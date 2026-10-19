import { defineEntity, p } from '@mikro-orm/postgresql';
import { WalletEntity } from './wallet.entity.js';

export const WagerTransactionKindEntity = {
  Opening: 'OPENING',
  Bet: 'BET',
  Win: 'WIN',
  Loss: 'LOSS',
  Refund: 'REFUND',
  Rollback: 'ROLLBACK',
} as const;

export const WagerTransactionStatusEntity = {
  Pending: 'PENDING',
  PendingReference: 'PENDING_REFERENCE',
  Processed: 'PROCESSED',
  Rejected: 'REJECTED',
  Failed: 'FAILED',
} as const;

const WagerTransactionSchema = defineEntity({
  name: 'WagerTransactionEntity',
  tableName: 'wager_transactions',
  properties: {
    id: p.string().length(64).primary(),
    providerId: p.string().length(128).fieldName('provider_id'),
    externalTransactionId: p
      .string()
      .length(256)
      .fieldName('external_transaction_id'),
    idempotencyKey: p.string().length(256).fieldName('idempotency_key'),
    payloadHash: p.string().length(128).fieldName('payload_hash'),
    wallet: () => p.manyToOne(WalletEntity).fieldName('wallet_id'),
    playerId: p.string().length(128).fieldName('player_id'),
    roundId: p.string().length(128).fieldName('round_id'),
    gameId: p.string().length(128).fieldName('game_id'),
    kind: p.enum(Object.values(WagerTransactionKindEntity)),
    amount: p.decimal('string').columnType('numeric'),
    currency: p.string().length(3),
    referenceExternalTransactionId: p
      .string()
      .length(256)
      .fieldName('reference_external_transaction_id')
      .nullable(),
    referenceTransaction: () =>
      p
        .manyToOne(WagerTransactionEntity)
        .fieldName('reference_transaction_id')
        .nullable(),
    status: p.enum(Object.values(WagerTransactionStatusEntity)),
    failureCode: p.string().length(64).fieldName('failure_code').nullable(),
    resultBalance: p
      .decimal('string')
      .fieldName('result_balance')
      .columnType('numeric')
      .nullable(),
    resultWalletVersion: p
      .integer()
      .fieldName('result_wallet_version')
      .nullable(),
    createdAt: p.datetime().fieldName('created_at'),
    processedAt: p.datetime().fieldName('processed_at').nullable(),
  },
  uniques: [
    {
      properties: ['providerId', 'idempotencyKey'],
      name: 'wager_transactions_provider_idempotency_uq',
    },
    {
      properties: ['providerId', 'externalTransactionId'],
      name: 'wager_transactions_provider_external_uq',
    },
    {
      properties: ['id', 'wallet'],
      name: 'wager_transactions_id_wallet_uq',
    },
    {
      properties: ['providerId', 'referenceExternalTransactionId', 'kind'],
      name: 'wager_transactions_reference_reversal_uq',
      where: `"kind" in ('REFUND', 'ROLLBACK') and "reference_external_transaction_id" is not null and "status" not in ('REJECTED', 'FAILED')`,
    },
  ],
  indexes: [
    {
      properties: ['wallet', 'createdAt'],
      name: 'wager_transactions_wallet_created_idx',
    },
    {
      properties: ['status', 'createdAt'],
      name: 'wager_transactions_status_created_idx',
    },
    {
      properties: ['providerId', 'referenceExternalTransactionId'],
      name: 'wager_transactions_provider_reference_idx',
    },
  ],
});

export class WagerTransactionEntity extends WagerTransactionSchema.class {}
WagerTransactionSchema.setClass(WagerTransactionEntity);
