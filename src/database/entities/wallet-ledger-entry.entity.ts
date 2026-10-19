import { defineEntity, p } from '@mikro-orm/postgresql';
import { WagerTransactionEntity } from './wager-transaction.entity.js';
import { WalletEntity } from './wallet.entity.js';

export const LedgerDirectionEntity = {
  Debit: 'DEBIT',
  Credit: 'CREDIT',
} as const;

const WalletLedgerEntrySchema = defineEntity({
  name: 'WalletLedgerEntryEntity',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: p.string().length(64).primary(),
    wallet: () => p.manyToOne(WalletEntity).fieldName('wallet_id'),
    transaction: () =>
      p.manyToOne(WagerTransactionEntity).fieldName('transaction_id'),
    direction: p.enum(Object.values(LedgerDirectionEntity)),
    amount: p.decimal('string').columnType('numeric'),
    balanceBefore: p
      .decimal('string')
      .fieldName('balance_before')
      .columnType('numeric'),
    balanceAfter: p
      .decimal('string')
      .fieldName('balance_after')
      .columnType('numeric'),
    currency: p.string().length(3),
    walletVersion: p.integer().fieldName('wallet_version'),
    createdAt: p.datetime().fieldName('created_at'),
  },
  uniques: [
    {
      properties: ['wallet', 'transaction'],
      name: 'wallet_ledger_wallet_transaction_uq',
    },
    {
      properties: ['wallet', 'walletVersion'],
      name: 'wallet_ledger_wallet_version_uq',
    },
  ],
  indexes: [
    {
      properties: ['wallet', 'createdAt', 'id'],
      name: 'wallet_ledger_wallet_cursor_idx',
    },
  ],
});

export class WalletLedgerEntryEntity extends WalletLedgerEntrySchema.class {}
WalletLedgerEntrySchema.setClass(WalletLedgerEntryEntity);
