import { defineEntity, p } from '@mikro-orm/postgresql';

const OutboxSchema = defineEntity({
  name: 'OutboxEntity',
  tableName: 'outbox_messages',
  properties: {
    id: p.string().length(64).primary(),
    eventId: p
      .string()
      .length(64)
      .fieldName('event_id')
      .unique('outbox_messages_event_id_uq'),
    aggregateId: p.string().length(128).fieldName('aggregate_id'),
    eventType: p.string().length(128).fieldName('event_type'),
    payload: p.json<Record<string, unknown>>().columnType('jsonb'),
    occurredAt: p.datetime().fieldName('occurred_at'),
    attempts: p.integer().default(0),
    nextAttemptAt: p.datetime().fieldName('next_attempt_at').nullable(),
    publishedAt: p.datetime().fieldName('published_at').nullable(),
  },
  indexes: [
    {
      properties: ['nextAttemptAt', 'occurredAt'],
      name: 'outbox_messages_due_idx',
      where: 'published_at IS NULL',
    },
  ],
});

export class OutboxEntity extends OutboxSchema.class {}
OutboxSchema.setClass(OutboxEntity);
