import { defineEntity, p } from '@mikro-orm/postgresql';

const InboxSchema = defineEntity({
  name: 'InboxEntity',
  tableName: 'inbox_messages',
  properties: {
    consumerName: p.string().length(128).fieldName('consumer_name').primary(),
    messageId: p.string().length(256).fieldName('message_id').primary(),
    payloadHash: p.string().length(128).fieldName('payload_hash'),
    receivedAt: p.datetime().fieldName('received_at'),
    processedAt: p.datetime().fieldName('processed_at').nullable(),
  },
  indexes: [
    { properties: ['receivedAt'], name: 'inbox_messages_received_idx' },
  ],
});

export class InboxEntity extends InboxSchema.class {}
InboxSchema.setClass(InboxEntity);
