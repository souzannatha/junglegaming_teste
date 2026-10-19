import {
  DeleteQueueCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/core';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { WageringService } from '../src/application/wagering/wagering.service.js';
import { parseSqsWagerCommand } from '../src/application/wagering/wagering.contracts.js';

const queueName = `wagering-commands-e2e-${randomUUID()}.fifo`;
const deadLetterQueueName = `wagering-commands-dlq-e2e-${randomUUID()}.fifo`;
const sqsEndpoint = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';
const consumerName = `wagering-consumer-e2e-${randomUUID()}`;

process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
process.env.WAGERING_SQS_CONSUMER_ENABLED = 'true';
process.env.WAGERING_QUEUE_NAME = queueName;
process.env.WAGERING_DLQ_NAME = deadLetterQueueName;
process.env.WAGERING_QUEUE_URL = '';
process.env.WAGERING_DLQ_URL = '';
process.env.WAGERING_SQS_CONSUMER_NAME = consumerName;
process.env.WAGERING_SQS_WAIT_SECONDS = '1';
process.env.WAGERING_SQS_VISIBILITY_TIMEOUT_SECONDS = '1';
process.env.WAGERING_SQS_MAX_RECEIVE_COUNT = '3';
process.env.SQS_ENDPOINT = sqsEndpoint;

describe('Wagering SQS consumer (e2e)', () => {
  let app: INestApplication<App>;
  let orm: MikroORM;
  let wageringService: WageringService;
  let queueClient: SQSClient;
  let queueUrl: string;
  let deadLetterQueueUrl: string;

  beforeAll(async () => {
    queueClient = new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      endpoint: sqsEndpoint,
      credentials: {
        accessKeyId: 'test',
        secretAccessKey: 'test',
      },
    });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    orm = app.get(MikroORM);
    wageringService = app.get(WageringService);
    queueUrl = await waitForQueueUrl(queueName);
    deadLetterQueueUrl = await waitForQueueUrl(deadLetterQueueName);
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    if (queueClient) {
      if (queueUrl) {
        await queueClient.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      }
      if (deadLetterQueueUrl) {
        await queueClient.send(
          new DeleteQueueCommand({ QueueUrl: deadLetterQueueUrl }),
        );
      }
      queueClient.destroy();
    }
  });

  it('processes FIFO commands atomically and deduplicates a redelivery through the inbox', async () => {
    const playerId = `sqs-player-${randomUUID()}`;
    const wallet = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      })
      .expect(201);

    const command = {
      idempotencyKey: `sqs-idem-${randomUUID()}`,
      correlationId: `sqs-correlation-${randomUUID()}`,
      transaction: {
        providerId: `sqs-provider-${randomUUID()}`,
        externalTransactionId: `sqs-bet-${randomUUID()}`,
        playerId,
        walletId: wallet.body.id as string,
        roundId: 'sqs-round',
        gameId: 'sqs-game',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      },
    };
    const messageId = await sendCommand(command);

    const processed = await waitForInboxMessage(messageId);
    expect(processed.processed_at).toBeTruthy();

    const result = await request(app.getHttpServer())
      .get(`/wallets/${wallet.body.id as string}`)
      .expect(200);
    expect(result.body.balance).toEqual({ amount: '90.00', currency: 'BRL' });

    const transaction = parseSqsWagerCommand(command).transaction;
    const replay = await wageringService.submitWager(
      transaction,
      command.idempotencyKey,
      command.correlationId,
      { consumerName, messageId },
    );
    expect(replay.body.idempotentReplay).toBe(true);

    const inboxRows = await orm.em
      .getConnection()
      .execute<{ message_id: string; processed_at: Date | null }[]>(
        `select message_id, processed_at from inbox_messages
       where consumer_name = ? and message_id = ?`,
        [consumerName, messageId],
        'all',
      );
    expect(inboxRows).toHaveLength(1);
    expect(inboxRows[0]?.processed_at).toBeTruthy();

    const ledgerRows = await orm.em
      .getConnection()
      .execute<{ entry_count: number }[]>(
        `select count(*)::integer as entry_count from wallet_ledger_entries
       where wallet_id = ?`,
        [wallet.body.id],
        'all',
      );
    expect(ledgerRows[0]?.entry_count).toBe(2);

    await app.close();
    const restartedModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = restartedModule.createNestApplication();
    await app.init();
    orm = app.get(MikroORM);
    wageringService = app.get(WageringService);

    const replayAfterRestart = await wageringService.submitWager(
      transaction,
      command.idempotencyKey,
      command.correlationId,
      { consumerName, messageId },
    );
    expect(replayAfterRestart.body.duplicateMessage).toBe(true);
    const balanceAfterRestart = await request(app.getHttpServer())
      .get(`/wallets/${wallet.body.id as string}`)
      .expect(200);
    expect(balanceAfterRestart.body.balance).toEqual({
      amount: '90.00',
      currency: 'BRL',
    });
  }, 20_000);

  it('moves malformed permanent messages to the configured FIFO dead-letter queue', async () => {
    const sourceMessageId = await sendRawMessage('{not-json');
    const deadLetterMessage = await waitForDeadLetterMessage(sourceMessageId);

    expect(deadLetterMessage.Body).toBe('{not-json');
    expect(deadLetterMessage.MessageAttributes?.FailureCode?.StringValue).toBe(
      'INVALID_SQS_MESSAGE',
    );
    expect(
      deadLetterMessage.MessageAttributes?.SourceMessageId?.StringValue,
    ).toBe(sourceMessageId);
  }, 20_000);

  it('leaves transient failures unacknowledged and processes them after redelivery', async () => {
    const playerId = `sqs-retry-player-${randomUUID()}`;
    const wallet = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId,
        initialBalance: { amount: '50.00', currency: 'BRL' },
      })
      .expect(201);
    const command = {
      idempotencyKey: `sqs-retry-idem-${randomUUID()}`,
      transaction: {
        providerId: `sqs-retry-provider-${randomUUID()}`,
        externalTransactionId: `sqs-retry-bet-${randomUUID()}`,
        playerId,
        walletId: wallet.body.id as string,
        roundId: 'sqs-retry-round',
        gameId: 'sqs-retry-game',
        kind: 'BET',
        money: { amount: '5.00', currency: 'BRL' },
      },
    };
    const submitSpy = vi
      .spyOn(wageringService, 'submitWager')
      .mockRejectedValueOnce(new Error('temporary database failure'));

    try {
      const messageId = await sendCommand(command);
      await waitForCondition(() => submitSpy.mock.calls.length >= 1);
      const inboxRecord = await waitForInboxMessage(messageId);

      expect(inboxRecord.processed_at).toBeTruthy();
      expect(submitSpy).toHaveBeenCalledTimes(2);
      const result = await request(app.getHttpServer())
        .get(`/wallets/${wallet.body.id as string}`)
        .expect(200);
      expect(result.body.balance).toEqual({
        amount: '45.00',
        currency: 'BRL',
      });
    } finally {
      submitSpy.mockRestore();
    }
  }, 20_000);

  async function sendCommand(command: unknown): Promise<string> {
    const response = await queueClient.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(command),
        MessageGroupId: `player-${randomUUID()}`,
        MessageDeduplicationId: randomUUID(),
      }),
    );
    if (!response.MessageId) {
      throw new Error('LocalStack did not return the SQS message ID');
    }
    return response.MessageId;
  }

  async function sendRawMessage(body: string): Promise<string> {
    const response = await queueClient.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: body,
        MessageGroupId: `invalid-${randomUUID()}`,
        MessageDeduplicationId: randomUUID(),
      }),
    );
    if (!response.MessageId) {
      throw new Error('LocalStack did not return the SQS message ID');
    }
    return response.MessageId;
  }

  async function waitForInboxMessage(
    messageId: string,
  ): Promise<{ processed_at: Date | null }> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const rows = await orm.em
        .getConnection()
        .execute<{ processed_at: Date | null }[]>(
          `select processed_at from inbox_messages
         where consumer_name = ? and message_id = ?`,
          [consumerName, messageId],
          'all',
        );
      if (rows[0]?.processed_at) {
        return rows[0];
      }
      await delay(100);
    }
    throw new Error(
      `SQS message ${messageId} was not processed before timeout`,
    );
  }

  async function waitForDeadLetterMessage(
    sourceMessageId: string,
  ): Promise<Message> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const received = await queueClient.send(
        new ReceiveMessageCommand({
          QueueUrl: deadLetterQueueUrl,
          WaitTimeSeconds: 1,
          MessageAttributeNames: ['All'],
          MaxNumberOfMessages: 10,
        }),
      );
      const match = received.Messages?.find(
        (message) =>
          message.MessageAttributes?.SourceMessageId?.StringValue ===
          sourceMessageId,
      );
      if (match) {
        return match;
      }
    }
    throw new Error(
      `SQS message ${sourceMessageId} did not arrive in the dead-letter queue`,
    );
  }

  async function waitForQueueUrl(name: string): Promise<string> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const result = await queueClient.send(
          new GetQueueUrlCommand({ QueueName: name }),
        );
        if (result.QueueUrl) {
          return result.QueueUrl;
        }
      } catch {
        await delay(100);
      }
    }
    throw new Error(`SQS queue ${name} was not created before timeout`);
  }

  async function waitForCondition(
    condition: () => boolean,
    timeoutMs = 5_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (condition()) {
        return;
      }
      await delay(25);
    }
    throw new Error('Condition was not met before timeout');
  }
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
