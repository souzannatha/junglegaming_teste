import {
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SetQueueAttributesCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { WageringService } from '../../application/wagering/wagering.service.js';
import { parseSqsWagerCommand } from '../../application/wagering/wagering.contracts.js';
import { IdempotencyConflictError } from '../../domain/errors/domain.error.js';

@Injectable()
export class WageringSqsConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WageringSqsConsumer.name);
  private readonly enabled =
    process.env.WAGERING_SQS_CONSUMER_ENABLED !== 'false';
  private readonly queueName = readStringSetting(
    'WAGERING_QUEUE_NAME',
    'wagering-commands.fifo',
    80,
  );
  private readonly queueUrl = readOptionalStringSetting('WAGERING_QUEUE_URL');
  private readonly deadLetterQueueName = readStringSetting(
    'WAGERING_DLQ_NAME',
    'wagering-commands-dlq.fifo',
    80,
  );
  private readonly deadLetterQueueUrl =
    readOptionalStringSetting('WAGERING_DLQ_URL');
  private readonly consumerName = readStringSetting(
    'WAGERING_SQS_CONSUMER_NAME',
    'wagering-command-consumer',
    128,
  );
  private readonly pollWaitSeconds = readIntegerSetting(
    'WAGERING_SQS_WAIT_SECONDS',
    20,
    0,
    20,
  );
  private readonly visibilityTimeoutSeconds = readIntegerSetting(
    'WAGERING_SQS_VISIBILITY_TIMEOUT_SECONDS',
    60,
    1,
    43_200,
  );
  private readonly batchSize = readIntegerSetting(
    'WAGERING_SQS_BATCH_SIZE',
    10,
    1,
    10,
  );
  private readonly maxReceiveCount = readIntegerSetting(
    'WAGERING_SQS_MAX_RECEIVE_COUNT',
    5,
    1,
    1_000,
  );
  private readonly client: SQSClient;
  private readonly abortController = new AbortController();
  private queueConfiguration:
    Promise<{ queueUrl: string; deadLetterQueueUrl: string }> | undefined;
  private polling = false;
  private pollTask: Promise<void> | undefined;

  constructor(private readonly wageringService: WageringService) {
    if (!this.queueName.endsWith('.fifo')) {
      throw new Error('WAGERING_QUEUE_NAME must end with .fifo');
    }
    if (!this.deadLetterQueueName.endsWith('.fifo')) {
      throw new Error('WAGERING_DLQ_NAME must end with .fifo');
    }

    const endpoint = readOptionalStringSetting('SQS_ENDPOINT');
    this.client = new SQSClient({
      region: readStringSetting('AWS_REGION', 'us-east-1', 128),
      ...(endpoint ? { endpoint } : {}),
      ...(endpoint
        ? {
            credentials: {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID?.trim() || 'test',
              secretAccessKey:
                process.env.AWS_SECRET_ACCESS_KEY?.trim() || 'test',
            },
          }
        : {}),
    });
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('Wagering SQS consumer is disabled by configuration');
      return;
    }

    this.polling = true;
    this.pollTask = this.pollLoop();
  }

  async onModuleDestroy(): Promise<void> {
    this.polling = false;
    this.abortController.abort();
    await this.pollTask;
    this.client.destroy();
  }

  private async pollLoop(): Promise<void> {
    while (this.polling) {
      try {
        const { queueUrl, deadLetterQueueUrl } =
          await this.resolveQueueConfiguration();
        const received = await this.client.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            WaitTimeSeconds: this.pollWaitSeconds,
            VisibilityTimeout: this.visibilityTimeoutSeconds,
            MaxNumberOfMessages: this.batchSize,
            MessageAttributeNames: ['All'],
            AttributeNames: ['All'],
          }),
          { abortSignal: this.abortController.signal },
        );

        for (const message of received.Messages ?? []) {
          const continueBatch = await this.handleMessage(
            message,
            queueUrl,
            deadLetterQueueUrl,
          );
          if (!continueBatch) {
            break;
          }
        }
      } catch (error) {
        if (!this.polling) {
          break;
        }
        this.logger.error(
          JSON.stringify({
            event: 'wagering_sqs_poll_failed',
            errorType: errorName(error),
          }),
        );
        await delay(1_000);
      }
    }
  }

  private async resolveQueueConfiguration(): Promise<{
    queueUrl: string;
    deadLetterQueueUrl: string;
  }> {
    if (!this.queueConfiguration) {
      this.queueConfiguration = this.configureQueues().catch(
        (error: unknown) => {
          this.queueConfiguration = undefined;
          throw error;
        },
      );
    }
    return this.queueConfiguration;
  }

  private async configureQueues(): Promise<{
    queueUrl: string;
    deadLetterQueueUrl: string;
  }> {
    const deadLetterQueueUrl =
      this.deadLetterQueueUrl ??
      (await this.getOrCreateFifoQueue(this.deadLetterQueueName));
    const deadLetterQueueArn = await this.getQueueArn(deadLetterQueueUrl);
    const redrivePolicy = JSON.stringify({
      deadLetterTargetArn: deadLetterQueueArn,
      maxReceiveCount: String(this.maxReceiveCount),
    });
    const queueUrl =
      this.queueUrl ??
      (await this.getOrCreateFifoQueue(this.queueName, {
        RedrivePolicy: redrivePolicy,
      }));

    await this.assertFifoQueue(queueUrl);
    await this.client.send(
      new SetQueueAttributesCommand({
        QueueUrl: queueUrl,
        Attributes: { RedrivePolicy: redrivePolicy },
      }),
    );
    return { queueUrl, deadLetterQueueUrl };
  }

  private async getOrCreateFifoQueue(
    queueName: string,
    additionalAttributes: Record<string, string> = {},
  ): Promise<string> {
    try {
      const result = await this.client.send(
        new GetQueueUrlCommand({ QueueName: queueName }),
      );
      if (!result.QueueUrl) {
        throw new Error(`SQS did not return a URL for queue ${queueName}`);
      }
      return result.QueueUrl;
    } catch (error) {
      if (!isQueueMissingError(error)) {
        throw error;
      }
    }

    const created = await this.client.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'true',
          ...additionalAttributes,
        },
      }),
    );
    if (!created.QueueUrl) {
      throw new Error(`SQS did not create queue ${queueName}`);
    }
    this.logger.log(
      JSON.stringify({ event: 'wagering_sqs_queue_created', queueName }),
    );
    return created.QueueUrl;
  }

  private async assertFifoQueue(queueUrl: string): Promise<void> {
    const result = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ['QueueArn', 'FifoQueue'],
      }),
    );
    if (result.Attributes?.FifoQueue !== 'true') {
      throw new Error('Wagering command and dead-letter queues must be FIFO');
    }
  }

  private async getQueueArn(queueUrl: string): Promise<string> {
    const result = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ['QueueArn', 'FifoQueue'],
      }),
    );
    if (result.Attributes?.FifoQueue !== 'true') {
      throw new Error('Wagering dead-letter queue must be FIFO');
    }
    const arn = result.Attributes.QueueArn;
    if (!arn) {
      throw new Error('SQS did not return the dead-letter queue ARN');
    }
    return arn;
  }

  private async handleMessage(
    message: Message,
    queueUrl: string,
    deadLetterQueueUrl: string,
  ): Promise<boolean> {
    if (!message.MessageId || !message.ReceiptHandle) {
      this.logger.error(
        JSON.stringify({
          event: 'wagering_sqs_message_missing_metadata',
          messageId: message.MessageId ?? null,
        }),
      );
      return false;
    }

    try {
      let body: unknown;
      try {
        body = JSON.parse(message.Body ?? '') as unknown;
      } catch {
        throw new BadRequestException({
          code: 'INVALID_SQS_MESSAGE',
          message: 'SQS message body must contain valid JSON',
        });
      }
      const command = parseSqsWagerCommand(body);
      await this.wageringService.submitWager(
        command.transaction,
        command.idempotencyKey,
        command.correlationId ?? randomUUID(),
        {
          consumerName: this.consumerName,
          messageId: message.MessageId,
        },
      );
    } catch (error) {
      if (!isPermanentError(error)) {
        this.logger.warn(
          JSON.stringify({
            event: 'wagering_sqs_message_retry_scheduled',
            messageId: message.MessageId,
            receiveCount: message.Attributes?.ApproximateReceiveCount ?? null,
            errorType: errorName(error),
          }),
        );
        return false;
      }

      try {
        await this.sendToDeadLetterQueue(message, deadLetterQueueUrl, error);
      } catch (deadLetterError) {
        this.logger.error(
          JSON.stringify({
            event: 'wagering_sqs_dead_letter_publish_failed',
            messageId: message.MessageId,
            errorType: errorName(deadLetterError),
          }),
        );
        return false;
      }

      this.logger.warn(
        JSON.stringify({
          event: 'wagering_sqs_message_dead_lettered',
          messageId: message.MessageId,
          failureCode: permanentErrorCode(error),
        }),
      );
    }

    try {
      await this.client.send(
        new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );
      return true;
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'wagering_sqs_message_ack_failed',
          messageId: message.MessageId,
          errorType: errorName(error),
        }),
      );
      return false;
    }
  }

  private async sendToDeadLetterQueue(
    message: Message,
    deadLetterQueueUrl: string,
    error: unknown,
  ): Promise<void> {
    const messageId = message.MessageId;
    if (!messageId) {
      throw new Error('Cannot dead-letter an SQS message without a message ID');
    }
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: deadLetterQueueUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'wagering-errors',
        MessageDeduplicationId: messageId,
        MessageAttributes: {
          SourceMessageId: {
            DataType: 'String',
            StringValue: messageId,
          },
          FailureCode: {
            DataType: 'String',
            StringValue: permanentErrorCode(error),
          },
        },
      }),
    );
  }
}

function isPermanentError(error: unknown): boolean {
  if (error instanceof HttpException) {
    return error.getStatus() >= 400 && error.getStatus() < 500;
  }
  return error instanceof IdempotencyConflictError;
}

function permanentErrorCode(error: unknown): string {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (
      response !== null &&
      typeof response === 'object' &&
      'code' in response &&
      typeof response.code === 'string'
    ) {
      return response.code.slice(0, 128);
    }
    return `HTTP_${error.getStatus()}`;
  }
  return error instanceof Error ? error.name.slice(0, 128) : 'UNKNOWN_ERROR';
}

function isQueueMissingError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') {
    return false;
  }
  const candidate = error as { name?: unknown; Code?: unknown };
  return (
    candidate.name === 'QueueDoesNotExist' ||
    candidate.Code === 'AWS.SimpleQueueService.NonExistentQueue'
  );
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

function readStringSetting(
  name: string,
  fallback: string,
  maxLength: number,
): string {
  const value = process.env[name]?.trim() || fallback;
  if (value.length > maxLength) {
    throw new Error(`${name} must be at most ${maxLength} characters`);
  }
  return value;
}

function readOptionalStringSetting(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function readIntegerSetting(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
