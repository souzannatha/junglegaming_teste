import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/core';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { OutboxPublisher } from '../src/infrastructure/outbox/outbox-publisher.service.js';

const queueName = `outbox-e2e-${randomUUID()}`;
const sqsEndpoint = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';

process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
process.env.WAGERING_SQS_CONSUMER_ENABLED = 'false';
process.env.OUTBOX_QUEUE_NAME = queueName;
process.env.SQS_ENDPOINT = sqsEndpoint;
process.env.OUTBOX_PUBLISHER_RETRY_BASE_MS = '50';
process.env.OUTBOX_PUBLISHER_RETRY_MAX_MS = '1000';
process.env.OUTBOX_PUBLISHER_BATCH_SIZE = '1';

describe('Transactional outbox publisher (e2e)', () => {
  let moduleFixture: TestingModule;
  let orm: MikroORM;
  let queueClient: SQSClient;
  let queueUrl: string;

  beforeAll(async () => {
    queueClient = new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      endpoint: sqsEndpoint,
      credentials: {
        accessKeyId: 'test',
        secretAccessKey: 'test',
      },
    });
    const queue = await queueClient.send(
      new CreateQueueCommand({ QueueName: queueName }),
    );
    if (!queue.QueueUrl) {
      throw new Error('LocalStack did not return the test queue URL');
    }
    queueUrl = queue.QueueUrl;
    process.env.OUTBOX_QUEUE_URL = queueUrl;

    moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    orm = moduleFixture.get(MikroORM);
  });

  afterAll(async () => {
    await moduleFixture?.close();
    await queueClient.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    queueClient.destroy();
  });

  it('retries failed sends and atomically claims events across workers', async () => {
    const eventId = randomUUID();
    const aggregateId = `outbox-test-${randomUUID()}`;
    const occurredAt = new Date('1900-01-01T00:00:00.000Z');
    const payload = {
      eventId,
      eventType: 'TestEvent',
      schemaVersion: 1,
      occurredAt: occurredAt.toISOString(),
      correlationId: randomUUID(),
      causationId: randomUUID(),
      data: { aggregateId },
    };

    await orm.em.transactional(async (em) => {
      await em.getConnection().execute(
        `insert into outbox_messages
          (id, event_id, aggregate_id, event_type, payload, occurred_at,
           attempts, next_attempt_at, published_at)
         values (?, ?, ?, ?, ?::jsonb, ?, 0, null, null)`,
        [
          eventId,
          eventId,
          aggregateId,
          payload.eventType,
          JSON.stringify(payload),
          occurredAt,
        ],
        'all',
        em.getTransactionContext(),
      );
    });

    process.env.OUTBOX_QUEUE_URL = `${queueUrl}-missing`;
    const invalidPublisher = new OutboxPublisher(orm);
    const failedCount = await invalidPublisher.publishDueBatch();
    expect(failedCount).toBe(0);
    const failedRecord = await readOutboxRecord(orm, eventId);
    expect(failedRecord.attempts).toBe(1);
    expect(failedRecord.published_at).toBeNull();
    expect(failedRecord.next_attempt_at).toBeTruthy();
    expect(failedRecord.lease_token).toBeNull();
    expect(failedRecord.last_error).toEqual(expect.any(String));
    await invalidPublisher.onModuleDestroy();

    await orm.em.getConnection().execute(
      `update outbox_messages set next_attempt_at = null where id = ?`,
      [eventId],
      'all',
    );
    process.env.OUTBOX_QUEUE_URL = queueUrl;
    const workerA = new OutboxPublisher(orm);
    const workerB = new OutboxPublisher(orm);
    const results = await Promise.all([
      workerA.publishDueBatch(),
      workerB.publishDueBatch(),
    ]);
    expect(results.reduce((sum, published) => sum + published, 0)).toBeGreaterThanOrEqual(
      1,
    );
    await workerA.onModuleDestroy();
    await workerB.onModuleDestroy();

    const publishedRecord = await readOutboxRecord(orm, eventId);
    expect(publishedRecord.attempts).toBe(2);
    expect(publishedRecord.published_at).toBeTruthy();
    expect(publishedRecord.next_attempt_at).toBeNull();
    expect(publishedRecord.lease_token).toBeNull();

    const received = await queueClient.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        WaitTimeSeconds: 2,
        MessageAttributeNames: ['All'],
        MaxNumberOfMessages: 10,
      }),
    );
    const message = received.Messages?.find(
      (candidate) =>
        candidate.MessageAttributes?.EventId?.StringValue === eventId,
    );
    expect(message).toBeDefined();
    expect(JSON.parse(message!.Body ?? '{}')).toEqual(payload);
    expect(message?.MessageAttributes?.EventType?.StringValue).toBe(
      'TestEvent',
    );
  });

  it('creates the configured queue when it has not been provisioned', async () => {
    const autoQueueName = `outbox-auto-${randomUUID()}`;
    const previousQueueName = process.env.OUTBOX_QUEUE_NAME;
    const previousQueueUrl = process.env.OUTBOX_QUEUE_URL;
    process.env.OUTBOX_QUEUE_NAME = autoQueueName;
    delete process.env.OUTBOX_QUEUE_URL;
    const publisher = new OutboxPublisher(orm);

    try {
      await publisher.publishDueBatch();
      const queue = await queueClient.send(
        new GetQueueUrlCommand({ QueueName: autoQueueName }),
      );
      expect(queue.QueueUrl).toEqual(expect.any(String));
      await queueClient.send(
        new DeleteQueueCommand({ QueueUrl: queue.QueueUrl }),
      );
    } finally {
      await publisher.onModuleDestroy();
      process.env.OUTBOX_QUEUE_NAME = previousQueueName;
      if (previousQueueUrl === undefined) {
        delete process.env.OUTBOX_QUEUE_URL;
      } else {
        process.env.OUTBOX_QUEUE_URL = previousQueueUrl;
      }
    }
  });
});

async function readOutboxRecord(
  orm: MikroORM,
  eventId: string,
): Promise<{
  attempts: number;
  published_at: Date | null;
  next_attempt_at: Date | null;
  lease_token: string | null;
  last_error: string | null;
}> {
  const rows = await orm.em.getConnection().execute<
    {
      attempts: number;
      published_at: Date | null;
      next_attempt_at: Date | null;
      lease_token: string | null;
      last_error: string | null;
    }[]
  >(
    `select attempts, published_at, next_attempt_at, lease_token, last_error
     from outbox_messages where event_id = ?`,
    [eventId],
    'all',
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`Outbox event ${eventId} was not persisted`);
  }
  return row;
}
