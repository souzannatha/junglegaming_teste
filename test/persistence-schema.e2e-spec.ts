import { Pool, type PoolClient } from 'pg';
import { MikroORM } from '@mikro-orm/postgresql';
import mikroOrmConfig from '../src/database/mikro-orm.config.js';
import { WalletEntity } from '../src/database/entities/wallet.entity.js';
import {
  WagerTransactionEntity,
  WagerTransactionKindEntity,
  WagerTransactionStatusEntity,
} from '../src/database/entities/wager-transaction.entity.js';
import {
  LedgerDirectionEntity,
  WalletLedgerEntryEntity,
} from '../src/database/entities/wallet-ledger-entry.entity.js';

const pool = new Pool({
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: Number.parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
  database: process.env.POSTGRES_DB ?? 'jungle_gaming',
  user: process.env.POSTGRES_USER ?? 'jungle',
  password: process.env.POSTGRES_PASSWORD ?? 'local_dev_password',
});
const createdAt = new Date('2026-01-01T00:00:00.000Z');

describe('PostgreSQL wagering schema', () => {
  let client: PoolClient;
  const walletId = `schema-test-${crypto.randomUUID()}`;

  beforeAll(async () => {
    client = await pool.connect();
    await client.query('begin');
  });

  afterAll(async () => {
    try {
      await client.query('rollback');
    } finally {
      client.release();
      await pool.end();
    }
  });

  it('creates required tables and enforces financial schema invariants', async () => {
    const tables = await client.query<{ table_name: string }>(
      `select table_name
       from information_schema.tables
       where table_schema = current_schema()
         and table_name = any($1::text[])`,
      [
        [
          'wallets',
          'wager_transactions',
          'wallet_ledger_entries',
          'inbox_messages',
          'outbox_messages',
        ],
      ],
    );

    expect(tables.rows.map(({ table_name }) => table_name).sort()).toEqual([
      'inbox_messages',
      'outbox_messages',
      'wager_transactions',
      'wallet_ledger_entries',
      'wallets',
    ]);

    await client.query(
      `insert into wallets
         (id, player_id, currency, balance, version, created_at, updated_at)
       values ($1, $2, 'BRL', 100.00, 1, $3, $3)`,
      [walletId, `player-${walletId}`, createdAt],
    );

    await insertProcessedTransaction(client, {
      id: `opening-${walletId}`,
      externalId: `opening:${walletId}`,
      walletId,
      kind: 'OPENING',
      amount: '100.00',
      providerId: 'internal',
      idempotencyKey: `opening:${walletId}`,
    });

    await insertLedgerEntry(client, {
      id: `ledger-opening-${walletId}`,
      walletId,
      transactionId: `opening-${walletId}`,
      direction: 'CREDIT',
      amount: '100.00',
      balanceBefore: '0.00',
      balanceAfter: '100.00',
      walletVersion: 1,
    });

    await client.query('set constraints all immediate');

    await client.query('savepoint duplicate_wallet');
    await expect(
      client.query(
        `insert into wallets
           (id, player_id, currency, balance, version, created_at, updated_at)
         values ($1, $2, 'BRL', 0.00, 1, $3, $3)`,
        [`duplicate-${walletId}`, `player-${walletId}`, createdAt],
      ),
    ).rejects.toThrow();
    await client.query('rollback to savepoint duplicate_wallet');

    await client.query('savepoint negative_wallet');
    await expect(
      client.query(
        `insert into wallets
           (id, player_id, currency, balance, version, created_at, updated_at)
         values ($1, $2, 'BRL', -0.01, 1, $3, $3)`,
        [`negative-${walletId}`, `negative-player-${walletId}`, createdAt],
      ),
    ).rejects.toThrow();
    await client.query('rollback to savepoint negative_wallet');

    await client.query('savepoint fractional_cent');
    await expect(
      client.query(
        `insert into wallets
           (id, player_id, currency, balance, version, created_at, updated_at)
         values ($1, $2, 'BRL', 0.001, 1, $3, $3)`,
        [`fractional-${walletId}`, `fractional-player-${walletId}`, createdAt],
      ),
    ).rejects.toThrow();
    await client.query('rollback to savepoint fractional_cent');

    await client.query('savepoint immutable_ledger');
    await expect(
      client.query(
        `update wallet_ledger_entries
         set balance_after = 99.00
         where id = $1`,
        [`ledger-opening-${walletId}`],
      ),
    ).rejects.toThrow(/immutable/i);
    await client.query('rollback to savepoint immutable_ledger');

    await client.query('savepoint duplicate_reversal');
    await insertPendingReversal(client, {
      id: `refund-${walletId}`,
      externalId: `refund:${walletId}`,
      walletId,
      referenceExternalId: `opening:${walletId}`,
    });
    await expect(
      insertPendingReversal(client, {
        id: `refund-duplicate-${walletId}`,
        externalId: `refund-duplicate:${walletId}`,
        walletId,
        referenceExternalId: `opening:${walletId}`,
      }),
    ).rejects.toThrow();
    await client.query('rollback to savepoint duplicate_reversal');

    await client.query('set constraints all deferred');
    await client.query('savepoint future_ledger');
    await insertProcessedTransaction(client, {
      id: `bet-${walletId}`,
      externalId: `bet:${walletId}`,
      walletId,
      kind: 'BET',
      amount: '10.00',
    });
    await insertLedgerEntry(client, {
      id: `ledger-bet-${walletId}`,
      walletId,
      transactionId: `bet-${walletId}`,
      direction: 'DEBIT',
      amount: '10.00',
      balanceBefore: '100.00',
      balanceAfter: '90.00',
      walletVersion: 2,
    });

    await expect(client.query('set constraints all immediate')).rejects.toThrow(
      /wallet version/i,
    );
    await client.query('rollback to savepoint future_ledger');
  });

  it('persists and hydrates NUMERIC values as exact decimal strings through MikroORM', async () => {
    const orm = await MikroORM.init(mikroOrmConfig);
    const id = `orm-schema-test-${crypto.randomUUID()}`;
    const amount = '900719925474099312345.67';

    try {
      try {
        await orm.em.transactional(async (em) => {
          const wallet = em.create(WalletEntity, {
            id,
            playerId: `player-${id}`,
            currency: 'BRL',
            balance: '0.00',
            version: 1,
            createdAt,
            updatedAt: createdAt,
          });
          const transaction = em.create(WagerTransactionEntity, {
            id: `op-${id}`,
            providerId: 'internal',
            externalTransactionId: `opening:${id}`,
            idempotencyKey: `opening:${id}`,
            payloadHash: `opening:${id}:${amount}`,
            wallet,
            playerId: `player-${id}`,
            roundId: 'internal',
            gameId: 'internal',
            kind: WagerTransactionKindEntity.Opening,
            amount,
            currency: 'BRL',
            status: WagerTransactionStatusEntity.Processed,
            createdAt,
            processedAt: createdAt,
          });
          em.create(WalletLedgerEntryEntity, {
            id: `lo-${id}`,
            wallet,
            transaction,
            direction: LedgerDirectionEntity.Credit,
            amount,
            balanceBefore: '0.00',
            balanceAfter: amount,
            currency: 'BRL',
            walletVersion: 1,
            createdAt,
          });
          wallet.balance = amount;

          await em.flush();
          em.clear();

          const persistedWallet = await em.findOneOrFail(WalletEntity, { id });
          const persistedTransaction = await em.findOneOrFail(
            WagerTransactionEntity,
            { id: `op-${id}` },
          );
          const persistedLedgerEntry = await em.findOneOrFail(
            WalletLedgerEntryEntity,
            { id: `lo-${id}` },
          );

          expect(persistedWallet.balance).toBe(amount);
          expect(persistedTransaction.amount).toBe(amount);
          expect(persistedLedgerEntry.balanceAfter).toBe(amount);
          throw new RollbackSchemaFixture();
        });
      } catch (error) {
        if (!(error instanceof RollbackSchemaFixture)) {
          throw error;
        }
      }
    } finally {
      await orm.close(true);
    }
  });
});

async function insertProcessedTransaction(
  client: PoolClient,
  props: {
    id: string;
    externalId: string;
    walletId: string;
    kind: string;
    amount: string;
    providerId?: string;
    idempotencyKey?: string;
  },
): Promise<void> {
  const providerId = props.providerId ?? 'schema-test-provider';
  await client.query(
    `insert into wager_transactions (
       id, provider_id, external_transaction_id, idempotency_key, payload_hash,
       wallet_id, player_id, round_id, game_id, kind, amount, currency, status,
       created_at, processed_at
     )
     values ($1, $2, $3, $4, 'schema-test-hash', $5, $6, 'round-1', 'game-1',
       $7, $8, 'BRL', 'PROCESSED', $9, $9)`,
    [
      props.id,
      providerId,
      props.externalId,
      props.idempotencyKey ?? props.externalId,
      props.walletId,
      `player-${props.walletId}`,
      props.kind,
      props.amount,
      createdAt,
    ],
  );
}

async function insertLedgerEntry(
  client: PoolClient,
  props: {
    id: string;
    walletId: string;
    transactionId: string;
    direction: 'DEBIT' | 'CREDIT';
    amount: string;
    balanceBefore: string;
    balanceAfter: string;
    walletVersion: number;
  },
): Promise<void> {
  await client.query(
    `insert into wallet_ledger_entries (
       id, wallet_id, transaction_id, direction, amount, balance_before,
       balance_after, currency, wallet_version, created_at
     )
     values ($1, $2, $3, $4, $5, $6, $7, 'BRL', $8, $9)`,
    [
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.amount,
      props.balanceBefore,
      props.balanceAfter,
      props.walletVersion,
      createdAt,
    ],
  );
}

async function insertPendingReversal(
  client: PoolClient,
  props: {
    id: string;
    externalId: string;
    walletId: string;
    referenceExternalId: string;
  },
): Promise<void> {
  await client.query(
    `insert into wager_transactions (
       id, provider_id, external_transaction_id, idempotency_key, payload_hash,
       wallet_id, player_id, round_id, game_id, kind, amount, currency,
       reference_external_transaction_id, status, created_at
     )
     values ($1, 'schema-test-provider', $2, $2, 'schema-test-hash',
       $3, $4, 'round-1', 'game-1', 'REFUND', 100.00, 'BRL', $5,
       'PENDING_REFERENCE', $6)`,
    [
      props.id,
      props.externalId,
      props.walletId,
      `player-${props.walletId}`,
      props.referenceExternalId,
      createdAt,
    ],
  );
}

class RollbackSchemaFixture extends Error {}
