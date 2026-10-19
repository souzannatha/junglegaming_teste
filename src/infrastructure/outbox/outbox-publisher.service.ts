import {
  CreateQueueCommand,
  GetQueueUrlCommand,
  SendMessageCommand,
  SQSClient,
  type MessageAttributeValue,
} from '@aws-sdk/client-sqs';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { EntityManager, MikroORM } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';
import { MetricsService } from '../../observability/metrics.service.js';
import { WorkerHealthService } from '../../observability/worker-health.service.js';

interface ClaimedOutboxEvent {
  id: string;
  event_id: string;
  event_type: string;
  payload: unknown;
  attempts: number;
  lease_token: string;
}

interface IntegrationEventEnvelope {
  eventId: string;
  eventType: string;
  schemaVersion: number;
  occurredAt: string;
  correlationId: string;
  causationId: string;
  data: Record<string, unknown>;
}

@Injectable()
export class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisher.name);
  private readonly enabled = process.env.OUTBOX_PUBLISHER_ENABLED !== 'false';
  private readonly queueName = readStringSetting(
    'OUTBOX_QUEUE_NAME',
    'wagering-events',
    80,
  );
  private readonly queueUrl = readOptionalStringSetting('OUTBOX_QUEUE_URL');
  private readonly pollIntervalMs = readIntegerSetting(
    'OUTBOX_PUBLISHER_POLL_MS',
    500,
    10,
    60_000,
  );
  private readonly batchSize = readIntegerSetting(
    'OUTBOX_PUBLISHER_BATCH_SIZE',
    10,
    1,
    100,
  );
  private readonly concurrency = readIntegerSetting(
    'OUTBOX_PUBLISHER_CONCURRENCY',
    5,
    1,
    100,
  );
  private readonly leaseDurationMs = readIntegerSetting(
    'OUTBOX_PUBLISHER_LEASE_MS',
    60_000,
    1_000,
    600_000,
  );
  private readonly retryBaseMs = readIntegerSetting(
    'OUTBOX_PUBLISHER_RETRY_BASE_MS',
    500,
    10,
    60_000,
  );
  private readonly retryMaxMs = readIntegerSetting(
    'OUTBOX_PUBLISHER_RETRY_MAX_MS',
    60_000,
    this.retryBaseMs,
    3_600_000,
  );
  private readonly client: SQSClient;
  private queueUrlPromise: Promise<string> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private activeBatch: Promise<number> | undefined;

  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Optional()
    @Inject(MetricsService)
    private readonly metrics?: MetricsService,
    @Optional()
    @Inject(WorkerHealthService)
    private readonly workerHealth?: WorkerHealthService,
  ) {
    const endpoint = readOptionalStringSetting('SQS_ENDPOINT');
    const region = readStringSetting('AWS_REGION', 'us-east-1', 128);
    this.client = new SQSClient({
      region,
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

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.workerHealth?.setState('outbox-publisher', 'disabled');
      this.logger.log('Outbox publisher is disabled by configuration');
      return;
    }

    this.workerHealth?.setState('outbox-publisher', 'starting');
    this.timer = setInterval(() => this.kickBatch(), this.pollIntervalMs);
    this.timer.unref();
    this.kickBatch();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.activeBatch;
    this.client.destroy();
  }

  async publishDueBatch(): Promise<number> {
    const queueUrl = await this.resolveQueueUrl();
    const leaseToken = randomUUID();
    const events = await this.claimBatch(leaseToken);
    let published = 0;

    for (let offset = 0; offset < events.length; offset += this.concurrency) {
      const group = events.slice(offset, offset + this.concurrency);
      const results = await Promise.all(
        group.map((event) => this.publishClaimedEvent(event, queueUrl)),
      );
      published += results.filter(Boolean).length;
    }

    return published;
  }

  private kickBatch(): void {
    if (this.activeBatch) {
      return;
    }
    this.activeBatch = this.publishDueBatch()
      .then((published) => {
        this.workerHealth?.setState('outbox-publisher', 'ready');
        return published;
      })
      .catch((error: unknown) => {
        this.workerHealth?.setState('outbox-publisher', 'unavailable');
        this.logger.error(
          JSON.stringify({
            event: 'outbox_publish_batch_failed',
            errorType: error instanceof Error ? error.name : 'UnknownError',
          }),
        );
        return 0;
      })
      .finally(() => {
        this.activeBatch = undefined;
      });
  }

  private async resolveQueueUrl(): Promise<string> {
    if (this.queueUrl) {
      return this.queueUrl;
    }
    if (!this.queueUrlPromise) {
      this.queueUrlPromise = this.lookupOrCreateQueue().catch(
        (error: unknown) => {
          this.queueUrlPromise = undefined;
          throw error;
        },
      );
    }
    return this.queueUrlPromise;
  }

  private async lookupOrCreateQueue(): Promise<string> {
    try {
      const result = await this.client.send(
        new GetQueueUrlCommand({ QueueName: this.queueName }),
      );
      if (!result.QueueUrl) {
        throw new Error(`SQS did not return a URL for queue ${this.queueName}`);
      }
      return result.QueueUrl;
    } catch (error) {
      if (!isQueueMissingError(error)) {
        throw error;
      }
    }

    const created = await this.client.send(
      new CreateQueueCommand({ QueueName: this.queueName }),
    );
    if (!created.QueueUrl) {
      throw new Error(`SQS did not create queue ${this.queueName}`);
    }
    this.logger.log(
      JSON.stringify({
        event: 'outbox_queue_created',
        queueName: this.queueName,
      }),
    );
    return created.QueueUrl;
  }

  private async claimBatch(leaseToken: string): Promise<ClaimedOutboxEvent[]> {
    return this.orm.em.transactional(async (em) => {
      const now = new Date();
      const leaseUntil = new Date(now.getTime() + this.leaseDurationMs);
      return executeRows<ClaimedOutboxEvent>(
        em,
        `with due_events as (
           select id
           from outbox_messages
           where published_at is null
             and coalesce(next_attempt_at, occurred_at) <= ?
             and (lease_until is null or lease_until <= ?)
           order by coalesce(next_attempt_at, occurred_at), occurred_at, id
           for update skip locked
           limit ?
         )
         update outbox_messages as event
         set lease_token = ?, lease_until = ?, attempts = event.attempts + 1
         from due_events
         where event.id = due_events.id
         returning event.id, event.event_id, event.event_type, event.payload,
           event.attempts, event.lease_token`,
        [now, now, this.batchSize, leaseToken, leaseUntil],
      );
    });
  }

  private async publishClaimedEvent(
    event: ClaimedOutboxEvent,
    queueUrl: string,
  ): Promise<boolean> {
    try {
      const envelope = parseEnvelope(event.payload);
      if (
        envelope.eventId !== event.event_id ||
        envelope.eventType !== event.event_type
      ) {
        throw new Error(
          'Outbox event envelope does not match its database row',
        );
      }
      const messageAttributes: Record<string, MessageAttributeValue> = {
        EventId: {
          DataType: 'String',
          StringValue: event.event_id,
        },
        EventType: {
          DataType: 'String',
          StringValue: event.event_type,
        },
        SchemaVersion: {
          DataType: 'Number',
          StringValue: String(envelope.schemaVersion),
        },
      };
      await this.client.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(envelope),
          MessageAttributes: messageAttributes,
        }),
      );
      this.workerHealth?.setState('outbox-publisher', 'ready');

      const updated = await executeRows<{ id: string }>(
        this.orm.em,
        `update outbox_messages
         set published_at = ?, next_attempt_at = null, lease_token = null,
           lease_until = null, last_error = null
         where id = ? and lease_token = ? and published_at is null
         returning id`,
        [new Date(), event.id, event.lease_token],
      );
      if (updated.length === 0) {
        this.logger.warn(
          JSON.stringify({
            event: 'outbox_publish_lease_lost_after_send',
            eventId: event.event_id,
          }),
        );
      } else {
        this.metrics?.record('wagering_outbox_events_total', 'published');
      }
      return updated.length > 0;
    } catch (error) {
      this.workerHealth?.setState('outbox-publisher', 'unavailable');
      this.metrics?.record('wagering_outbox_events_total', 'failed');
      const nextAttemptAt = new Date(
        Date.now() +
          retryDelay(this.retryBaseMs, this.retryMaxMs, event.attempts),
      );
      try {
        await executeRows<{ id: string }>(
          this.orm.em,
          `update outbox_messages
           set next_attempt_at = ?, lease_token = null, lease_until = null,
             last_error = ?
           where id = ? and lease_token = ? and published_at is null
           returning id`,
          [nextAttemptAt, errorName(error), event.id, event.lease_token],
        );
      } catch (persistenceError) {
        this.logger.error(
          JSON.stringify({
            event: 'outbox_retry_schedule_failed',
            eventId: event.event_id,
            errorType:
              persistenceError instanceof Error
                ? persistenceError.name
                : 'UnknownError',
          }),
        );
      }
      this.logger.warn(
        JSON.stringify({
          event: 'outbox_publish_failed',
          eventId: event.event_id,
          eventType: event.event_type,
          attempt: event.attempts,
          nextAttemptAt: nextAttemptAt.toISOString(),
          errorType: errorName(error),
        }),
      );
      return false;
    }
  }
}

async function executeRows<T>(
  em: EntityManager,
  sql: string,
  params: unknown[],
): Promise<T[]> {
  const result: unknown = await em
    .getConnection()
    .execute(sql, params, 'all', em.getTransactionContext());
  if (Array.isArray(result)) {
    return result as T[];
  }
  if (
    result !== null &&
    typeof result === 'object' &&
    Array.isArray((result as { rows?: unknown }).rows)
  ) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function parseEnvelope(value: unknown): IntegrationEventEnvelope {
  const decoded =
    typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (
    decoded === null ||
    typeof decoded !== 'object' ||
    Array.isArray(decoded)
  ) {
    throw new Error('Outbox event payload must be a JSON object');
  }
  const envelope = decoded as Partial<IntegrationEventEnvelope>;
  if (
    typeof envelope.eventId !== 'string' ||
    typeof envelope.eventType !== 'string' ||
    !Number.isInteger(envelope.schemaVersion) ||
    typeof envelope.occurredAt !== 'string' ||
    typeof envelope.correlationId !== 'string' ||
    typeof envelope.causationId !== 'string' ||
    envelope.data === null ||
    typeof envelope.data !== 'object' ||
    Array.isArray(envelope.data)
  ) {
    throw new Error('Outbox event payload does not match the event envelope');
  }
  return envelope as IntegrationEventEnvelope;
}

function retryDelay(baseMs: number, maxMs: number, attempt: number): number {
  const exponent = Math.min(30, Math.max(0, attempt - 1));
  return Math.min(maxMs, baseMs * 2 ** exponent);
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
  const name = error instanceof Error ? error.name : 'UnknownError';
  return name.slice(0, 128);
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
