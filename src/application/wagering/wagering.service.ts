import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { EntityManager, MikroORM } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';
import {
  WagerFailureCode,
  WagerRuleViolationError,
} from '../../domain/errors/domain.error.js';
import { Money } from '../../domain/money/money.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../domain/wagering/wallet-ledger-entry.js';
import { Wallet } from '../../domain/wagering/wallet.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type WagerTransactionState,
} from '../../domain/wagering/wager-transaction.js';
import { WagerRules } from '../../domain/wagering/wager-rules.js';
import { hashWagerPayload } from './canonical-payload.js';
import type {
  CreateWalletRequest,
  SubmitWagerRequest,
} from './wagering.contracts.js';

interface DatabaseRow {
  [key: string]: unknown;
  reference_external_transaction_id?: string | null;
  reference_transaction_id?: string | null;
  failure_code?: string | null;
  processed_at?: Date | string | null;
}

interface ProcessResult {
  httpStatus: number;
  body: Record<string, unknown>;
}

const TRANSACTION_SELECT = `
  select id, provider_id, external_transaction_id, idempotency_key,
    payload_hash, wallet_id, player_id, round_id, game_id, kind, amount,
    currency, reference_external_transaction_id, reference_transaction_id,
    status, failure_code, created_at, processed_at, result_balance,
    result_wallet_version
  from wager_transactions
`;

@Injectable()
export class WageringService {
  private readonly logger = new Logger(WageringService.name);

  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
  ) {}

  async createWallet(request: CreateWalletRequest): Promise<{
    id: string;
    playerId: string;
    currency: string;
    balance: { amount: string; currency: string };
    version: number;
    createdAt: string;
  }> {
    const walletId = randomUUID();
    const now = new Date();
    const wallet = Wallet.open({
      id: walletId,
      playerId: request.playerId,
      initialBalance: request.initialBalance,
      createdAt: now,
    });

    await this.orm.em.transactional(async (em) => {
      await query(
        em,
        `insert into wallets
          (id, player_id, currency, balance, version, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
        [
          wallet.id,
          wallet.playerId,
          wallet.currency,
          wallet.balance.toString(),
          wallet.version,
          wallet.createdAt,
          wallet.updatedAt,
        ],
      );

      let openingTransactionId: string | undefined;
      if (wallet.balance.isPositive()) {
        const transaction = WagerTransaction.createOpening({
          id: randomUUID(),
          walletId: wallet.id,
          playerId: wallet.playerId,
          money: wallet.balance,
          createdAt: now,
        });
        openingTransactionId = transaction.id;
        transaction.markProcessed(undefined, now);

        await query(
          em,
          `insert into wager_transactions
            (id, provider_id, external_transaction_id, idempotency_key,
             payload_hash, wallet_id, player_id, round_id, game_id, kind,
             amount, currency, reference_external_transaction_id,
             reference_transaction_id, status, failure_code, created_at,
             processed_at, result_balance, result_wallet_version)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, ?, null,
                   ?, ?, ?, ?)`,
          [
            transaction.id,
            transaction.providerId,
            transaction.externalTransactionId,
            transaction.idempotencyKey,
            transaction.payloadHash,
            transaction.walletId,
            transaction.playerId,
            transaction.roundId,
            transaction.gameId,
            transaction.kind,
            transaction.money.toString(),
            transaction.money.currency,
            transaction.status,
            now,
            now,
            wallet.balance.toString(),
            wallet.version,
          ],
        );

        const ledger = WalletLedgerEntry.create({
          id: randomUUID(),
          walletId: wallet.id,
          transactionId: transaction.id,
          direction: LedgerDirection.Credit,
          money: wallet.balance,
          balanceBefore: Money.zero(wallet.currency),
          balanceAfter: wallet.balance,
          createdAt: now,
        });
        await insertLedgerEntry(em, ledger, wallet.version);
      }

      await insertOutboxEvent(em, {
        id: randomUUID(),
        aggregateId: wallet.id,
        eventType: 'WalletCreated',
        occurredAt: now,
        correlationId: randomUUID(),
        causationId: openingTransactionId ?? wallet.id,
        data: {
          walletId: wallet.id,
          playerId: wallet.playerId,
          currency: wallet.currency,
          balance: wallet.balance.toJSON(),
          walletVersion: wallet.version,
          openingTransactionId: openingTransactionId ?? null,
        },
      });
    });

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
      createdAt: wallet.createdAt.toISOString(),
    };
  }

  async getWallet(walletId: string): Promise<Record<string, unknown>> {
    const rows = await query(
      this.orm.em,
      `select id, player_id, currency, balance, version, created_at, updated_at
       from wallets where id = ?`,
      [walletId],
    );
    const wallet = rows[0];
    if (!wallet) {
      throw new NotFoundException({
        code: 'WALLET_NOT_FOUND',
        message: 'Wallet was not found',
      });
    }

    return serializeWallet(wallet);
  }

  async getLedger(
    walletId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<Record<string, unknown>> {
    const walletRows = await query(
      this.orm.em,
      `select id from wallets where id = ?`,
      [walletId],
    );
    if (!walletRows[0]) {
      throw new NotFoundException({
        code: 'WALLET_NOT_FOUND',
        message: 'Wallet was not found',
      });
    }

    const decodedCursor = cursor ? decodeCursor(cursor) : undefined;
    const rows = decodedCursor
      ? await query(
          this.orm.em,
          `select id, transaction_id, direction, amount, balance_before,
             balance_after, currency, wallet_version, created_at
           from wallet_ledger_entries
           where wallet_id = ?
             and (created_at, id) < (?, ?)
           order by created_at desc, id desc
           limit ?`,
          [walletId, decodedCursor.createdAt, decodedCursor.id, limit + 1],
        )
      : await query(
          this.orm.em,
          `select id, transaction_id, direction, amount, balance_before,
             balance_after, currency, wallet_version, created_at
           from wallet_ledger_entries
           where wallet_id = ?
           order by created_at desc, id desc
           limit ?`,
          [walletId, limit + 1],
        );

    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items: items.map(serializeLedgerEntry),
      nextCursor:
        hasMore && last
          ? encodeCursor(
              new Date(String(last.created_at)).toISOString(),
              String(last.id),
            )
          : null,
    };
  }

  async submitWager(
    request: SubmitWagerRequest,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<ProcessResult> {
    const payloadHash = hashWagerPayload(request);
    return this.orm.em.transactional(async (em) => {
      const existing = await findByIdempotencyKey(
        em,
        request.providerId,
        idempotencyKey,
      );
      if (existing) {
        return replay(existing, payloadHash);
      }

      const walletRows = await query(
        em,
        `select id, player_id, currency, balance, version, created_at,
           updated_at
         from wallets where id = ? for update`,
        [request.walletId],
      );
      const walletRow = walletRows[0];
      if (!walletRow) {
        throw new NotFoundException({
          code: 'WALLET_NOT_FOUND',
          message: 'Wallet was not found',
        });
      }
      if (
        String(walletRow.player_id) !== request.playerId ||
        String(walletRow.currency) !== request.money.currency
      ) {
        throw new UnprocessableEntityException({
          code: 'WALLET_CONTEXT_MISMATCH',
          message: 'Player and currency must match the wallet',
        });
      }

      const afterLock = await findByIdempotencyKey(
        em,
        request.providerId,
        idempotencyKey,
      );
      if (afterLock) {
        return replay(afterLock, payloadHash);
      }

      const externalDuplicate = await query(
        em,
        `${TRANSACTION_SELECT}
         where provider_id = ? and external_transaction_id = ?`,
        [request.providerId, request.externalTransactionId],
      );
      if (externalDuplicate[0]) {
        throw new ConflictException({
          code: 'EXTERNAL_TRANSACTION_CONFLICT',
          message: 'External transaction ID is already in use',
        });
      }

      const wallet = hydrateWallet(walletRow);
      const now = new Date();
      const transaction = WagerTransaction.create({
        id: randomUUID(),
        providerId: request.providerId,
        externalTransactionId: request.externalTransactionId,
        idempotencyKey,
        payloadHash,
        walletId: request.walletId,
        playerId: request.playerId,
        roundId: request.roundId,
        gameId: request.gameId,
        kind: request.kind,
        money: request.money,
        referenceExternalTransactionId:
          request.referenceExternalTransactionId,
        createdAt: now,
      });

      const reference = request.referenceExternalTransactionId
        ? await findReference(
            em,
            request.providerId,
            request.referenceExternalTransactionId,
          )
        : undefined;

      if (
        (transaction.kind === WagerTransactionKind.Refund ||
          transaction.kind === WagerTransactionKind.Rollback) &&
        transaction.referenceExternalTransactionId !== undefined
      ) {
        const previousReversals = await findReversals(
          em,
          transaction.providerId,
          transaction.referenceExternalTransactionId,
        );
        if (previousReversals.length > 0) {
          let duplicateReversal = !reference;
          if (reference) {
            try {
              WagerRules.validateReference(
                transaction,
                reference,
                previousReversals,
              );
            } catch (error) {
              duplicateReversal =
                error instanceof WagerRuleViolationError &&
                error.failureCode === WagerFailureCode.ReferenceAlreadyReversed;
              if (!(error instanceof WagerRuleViolationError)) {
                throw error;
              }
            }
          }
          if (duplicateReversal) {
            transaction.reject(WagerFailureCode.ReferenceAlreadyReversed);
            await insertRejectedTransaction(em, transaction, wallet);
            await insertOutboxEvent(em, {
              id: randomUUID(),
              aggregateId: wallet.id,
              eventType: 'WagerTransactionRejected',
              occurredAt: now,
              correlationId,
              causationId: transaction.id,
              data: {
                ...transactionEventData(transaction, wallet),
                failureCode: transaction.failureCode,
              },
            });
            return formatTransactionResult(transaction, wallet, false);
          }
        }
      }

      if (!(await insertPendingTransaction(em, transaction))) {
        const concurrentReplay = await findByIdempotencyKey(
          em,
          request.providerId,
          idempotencyKey,
        );
        if (concurrentReplay) {
          return replay(concurrentReplay, payloadHash);
        }
        throw new ConflictException({
          code: 'EXTERNAL_TRANSACTION_CONFLICT',
          message: 'External transaction ID is already in use',
        });
      }
      if (
        request.referenceExternalTransactionId !== undefined &&
        !reference
      ) {
        transaction.markPendingReference();
        await query(
          em,
          `update wager_transactions
           set status = ?, result_balance = ?, result_wallet_version = ?
           where id = ?`,
          [
            transaction.status,
            wallet.balance.toString(),
            wallet.version,
            transaction.id,
          ],
        );
        await insertOutboxEvent(em, {
          id: randomUUID(),
          aggregateId: wallet.id,
          eventType: 'WagerTransactionPendingReference',
          occurredAt: now,
          correlationId,
          causationId: transaction.id,
          data: transactionEventData(transaction, wallet),
        });
        return formatTransactionResult(transaction, wallet, false);
      }

      const existingReversals = reference
        ? await findReversals(
            em,
            request.providerId,
            reference.externalTransactionId,
          )
        : [];

      try {
        WagerRules.validateReference(
          transaction,
          reference,
          existingReversals,
        );

        if (transaction.kind === WagerTransactionKind.Loss) {
          transaction.markProcessed(reference?.id, now);
        } else {
          const direction = transaction.ledgerDirectionFor(reference);
          const ledger =
            direction === LedgerDirection.Debit
              ? wallet.debit({
                  entryId: randomUUID(),
                  transactionId: transaction.id,
                  amount: transaction.money,
                  at: now,
                  insufficientFundsCode:
                    transaction.insufficientFundsFailureCode(),
                })
              : wallet.credit({
                  entryId: randomUUID(),
                  transactionId: transaction.id,
                  amount: transaction.money,
                  at: now,
                });
          transaction.markProcessed(reference?.id, now);

          await query(
            em,
            `update wallets
             set balance = ?, version = ?, updated_at = ?
             where id = ?`,
            [
              wallet.balance.toString(),
              wallet.version,
              wallet.updatedAt,
              wallet.id,
            ],
          );
          await insertLedgerEntry(em, ledger, wallet.version);
        }

        await updateTransactionResult(em, transaction, wallet, now);
        await insertOutboxEvent(em, {
          id: randomUUID(),
          aggregateId: wallet.id,
          eventType: 'WagerTransactionProcessed',
          occurredAt: now,
          correlationId,
          causationId: transaction.id,
          data: transactionEventData(transaction, wallet),
        });
        return formatTransactionResult(transaction, wallet, false);
      } catch (error) {
        if (!(error instanceof WagerRuleViolationError)) {
          throw error;
        }

        transaction.reject(error.failureCode);
        await updateTransactionResult(em, transaction, wallet, now);
        await insertOutboxEvent(em, {
          id: randomUUID(),
          aggregateId: wallet.id,
          eventType: 'WagerTransactionRejected',
          occurredAt: now,
          correlationId,
          causationId: transaction.id,
          data: {
            ...transactionEventData(transaction, wallet),
            failureCode: transaction.failureCode,
          },
        });
        return formatTransactionResult(transaction, wallet, false);
      }
    });
  }

  async getTransaction(id: string): Promise<Record<string, unknown>> {
    const rows = await query(
      this.orm.em,
      `${TRANSACTION_SELECT} where id = ?`,
      [id],
    );
    const row = rows[0];
    if (!row) {
      throw transactionNotFound();
    }
    return serializeTransaction(row);
  }

  async getProviderTransaction(
    providerId: string,
    externalTransactionId: string,
  ): Promise<Record<string, unknown>> {
    const rows = await query(
      this.orm.em,
      `${TRANSACTION_SELECT}
       where provider_id = ? and external_transaction_id = ?`,
      [providerId, externalTransactionId],
    );
    const row = rows[0];
    if (!row) {
      throw transactionNotFound();
    }
    return serializeTransaction(row);
  }

  async reconcileWallet(walletId: string): Promise<Record<string, unknown>> {
    return this.orm.em.transactional(async (em) => {
      const walletRows = await query(
        em,
        `select id, player_id, currency, balance, version, created_at,
           updated_at
         from wallets where id = ? for update`,
        [walletId],
      );
      const row = walletRows[0];
      if (!row) {
        throw new NotFoundException({
          code: 'WALLET_NOT_FOUND',
          message: 'Wallet was not found',
        });
      }

      const totals = await query(
        em,
        `select count(*)::integer as entry_count,
           coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0)::text
             as ledger_balance,
           coalesce(max(wallet_version), 1)::integer as ledger_version
         from wallet_ledger_entries where wallet_id = ?`,
        [walletId],
      );
      const total = totals[0]!;
      const storedBalance = moneyFromRow(row.balance, row.currency);
      const ledgerBalance = moneyFromRow(total.ledger_balance, row.currency);
      const difference = storedBalance.subtract(ledgerBalance);
      const consistent =
        difference.isZero() &&
        Number(total.ledger_version) === Number(row.version);

      if (!consistent) {
        this.logger.error(
          JSON.stringify({
            event: 'wallet_reconciliation_mismatch',
            walletId,
            walletVersion: Number(row.version),
            ledgerVersion: Number(total.ledger_version),
          }),
        );
      }

      return {
        walletId,
        consistent,
        storedBalance: storedBalance.toJSON(),
        ledgerBalance: ledgerBalance.toJSON(),
        difference: difference.toJSON(),
        walletVersion: Number(row.version),
        ledgerVersion: Number(total.ledger_version),
        checkedEntries: Number(total.entry_count),
        checkedAt: new Date().toISOString(),
      };
    });
  }
}

async function query(
  em: EntityManager,
  sql: string,
  params: unknown[] = [],
): Promise<DatabaseRow[]> {
  const result: unknown = await em.getConnection().execute(
    sql,
    params,
    'all',
    em.getTransactionContext(),
  );
  if (Array.isArray(result)) {
    return result as DatabaseRow[];
  }
  if (
    result !== null &&
    typeof result === 'object' &&
    Array.isArray((result as { rows?: unknown }).rows)
  ) {
    return (result as { rows: DatabaseRow[] }).rows;
  }
  return [];
}

async function insertPendingTransaction(
  em: EntityManager,
  transaction: WagerTransaction,
): Promise<boolean> {
  const rows = await query(
    em,
    `insert into wager_transactions
      (id, provider_id, external_transaction_id, idempotency_key,
       payload_hash, wallet_id, player_id, round_id, game_id, kind, amount,
       currency, reference_external_transaction_id,
       reference_transaction_id, status, failure_code, created_at,
       processed_at, result_balance, result_wallet_version)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?, null, ?, null,
             null, null)
     on conflict do nothing
     returning id`,
    [
      transaction.id,
      transaction.providerId,
      transaction.externalTransactionId,
      transaction.idempotencyKey,
      transaction.payloadHash,
      transaction.walletId,
      transaction.playerId,
      transaction.roundId,
      transaction.gameId,
      transaction.kind,
      transaction.money.toString(),
      transaction.money.currency,
      transaction.referenceExternalTransactionId ?? null,
      transaction.status,
      transaction.createdAt,
    ],
  );
  return rows.length > 0;
}

async function insertRejectedTransaction(
  em: EntityManager,
  transaction: WagerTransaction,
  wallet: Wallet,
): Promise<void> {
  const rows = await query(
    em,
    `insert into wager_transactions
      (id, provider_id, external_transaction_id, idempotency_key,
       payload_hash, wallet_id, player_id, round_id, game_id, kind, amount,
       currency, reference_external_transaction_id,
       reference_transaction_id, status, failure_code, created_at,
       processed_at, result_balance, result_wallet_version)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?, ?, ?, null,
             ?, ?)
     on conflict do nothing
     returning id`,
    [
      transaction.id,
      transaction.providerId,
      transaction.externalTransactionId,
      transaction.idempotencyKey,
      transaction.payloadHash,
      transaction.walletId,
      transaction.playerId,
      transaction.roundId,
      transaction.gameId,
      transaction.kind,
      transaction.money.toString(),
      transaction.money.currency,
      transaction.referenceExternalTransactionId ?? null,
      transaction.status,
      transaction.failureCode ?? null,
      transaction.createdAt,
      wallet.balance.toString(),
      wallet.version,
    ],
  );
  if (rows.length === 0) {
    throw new ConflictException({
      code: 'EXTERNAL_TRANSACTION_CONFLICT',
      message: 'External transaction ID is already in use',
    });
  }
}

async function updateTransactionResult(
  em: EntityManager,
  transaction: WagerTransaction,
  wallet: Wallet,
  processedAt: Date,
): Promise<void> {
  await query(
    em,
    `update wager_transactions
     set status = ?, failure_code = ?, reference_transaction_id = ?,
       processed_at = ?, result_balance = ?, result_wallet_version = ?
     where id = ?`,
    [
      transaction.status,
      transaction.failureCode ?? null,
      transaction.referenceTransactionId ?? null,
      transaction.status === WagerTransactionStatus.Processed
        ? processedAt
        : null,
      wallet.balance.toString(),
      wallet.version,
      transaction.id,
    ],
  );
}

async function insertLedgerEntry(
  em: EntityManager,
  entry: WalletLedgerEntry,
  walletVersion: number,
): Promise<void> {
  await query(
    em,
    `insert into wallet_ledger_entries
      (id, wallet_id, transaction_id, direction, amount, balance_before,
       balance_after, currency, wallet_version, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.id,
      entry.walletId,
      entry.transactionId,
      entry.direction,
      entry.money.toString(),
      entry.balanceBefore.toString(),
      entry.balanceAfter.toString(),
      entry.money.currency,
      walletVersion,
      entry.createdAt,
    ],
  );
}

async function insertOutboxEvent(
  em: EntityManager,
  event: {
    id: string;
    aggregateId: string;
    eventType: string;
    occurredAt: Date;
    correlationId: string;
    causationId: string;
    data: Record<string, unknown>;
  },
): Promise<void> {
  const payload = {
    eventId: event.id,
    eventType: event.eventType,
    schemaVersion: 1,
    occurredAt: event.occurredAt.toISOString(),
    correlationId: event.correlationId,
    causationId: event.causationId,
    data: event.data,
  };
  await query(
    em,
    `insert into outbox_messages
      (id, event_id, aggregate_id, event_type, payload, occurred_at,
       attempts, next_attempt_at, published_at)
     values (?, ?, ?, ?, ?::jsonb, ?, 0, null, null)`,
    [
      event.id,
      event.id,
      event.aggregateId,
      event.eventType,
      JSON.stringify(payload),
      event.occurredAt,
    ],
  );
}

async function findByIdempotencyKey(
  em: EntityManager,
  providerId: string,
  idempotencyKey: string,
): Promise<DatabaseRow | undefined> {
  const rows = await query(
    em,
    `${TRANSACTION_SELECT}
     where provider_id = ? and idempotency_key = ?`,
    [providerId, idempotencyKey],
  );
  return rows[0];
}

async function findReference(
  em: EntityManager,
  providerId: string,
  externalTransactionId: string,
): Promise<WagerTransaction | undefined> {
  const rows = await query(
    em,
    `${TRANSACTION_SELECT}
     where provider_id = ? and external_transaction_id = ?`,
    [providerId, externalTransactionId],
  );
  return rows[0] ? hydrateTransaction(rows[0]) : undefined;
}

async function findReversals(
  em: EntityManager,
  providerId: string,
  referenceExternalTransactionId: string,
): Promise<WagerTransaction[]> {
  const rows = await query(
    em,
    `${TRANSACTION_SELECT}
     where provider_id = ? and reference_external_transaction_id = ?
       and kind in ('REFUND', 'ROLLBACK')
       and status not in ('REJECTED', 'FAILED')`,
    [providerId, referenceExternalTransactionId],
  );
  return rows.map(hydrateTransaction);
}

function hydrateWallet(row: DatabaseRow): Wallet {
  const createdAt = new Date(String(row.created_at));
  return Wallet.rehydrate({
    id: String(row.id),
    playerId: String(row.player_id),
    currency: String(row.currency).trim(),
    balance: moneyFromRow(row.balance, row.currency),
    version: Number(row.version),
    createdAt,
    updatedAt: new Date(String(row.updated_at)),
  });
}

function hydrateTransaction(row: DatabaseRow): WagerTransaction {
  const state: WagerTransactionState = {
    id: String(row.id),
    providerId: String(row.provider_id),
    externalTransactionId: String(row.external_transaction_id),
    idempotencyKey: String(row.idempotency_key),
    payloadHash: String(row.payload_hash),
    walletId: String(row.wallet_id),
    playerId: String(row.player_id),
    roundId: String(row.round_id),
    gameId: String(row.game_id),
    kind: row.kind as WagerTransactionKind,
    money: moneyFromRow(row.amount, row.currency),
    referenceExternalTransactionId:
      row.reference_external_transaction_id === null
        ? undefined
        : String(row.reference_external_transaction_id),
    createdAt: new Date(String(row.created_at)),
    status: row.status as WagerTransactionStatus,
    referenceTransactionId:
      row.reference_transaction_id === null
        ? undefined
        : String(row.reference_transaction_id),
    failureCode:
      row.failure_code === null
        ? undefined
        : (String(row.failure_code) as WagerFailureCode),
    processedAt:
      row.processed_at === null
        ? undefined
        : new Date(String(row.processed_at)),
  };
  return WagerTransaction.rehydrate(state);
}

function moneyFromRow(amount: unknown, currency: unknown): Money {
  return Money.from({
    amount: String(amount),
    currency: String(currency).trim(),
  });
}

function replay(row: DatabaseRow, payloadHash: string): ProcessResult {
  const transaction = hydrateTransaction(row);
  transaction.assertPayloadMatches(payloadHash);
  return {
    httpStatus: statusCode(transaction.status),
    body: serializeTransaction(row, true),
  };
}

function formatTransactionResult(
  transaction: WagerTransaction,
  wallet: Wallet,
  idempotentReplay: boolean,
): ProcessResult {
  return {
    httpStatus: statusCode(transaction.status),
    body: {
      id: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      kind: transaction.kind,
      status: transaction.status,
      failureCode: transaction.failureCode ?? null,
      balance: wallet.balance.toJSON(),
      walletVersion: wallet.version,
      idempotentReplay,
    },
  };
}

function statusCode(status: WagerTransactionStatus): number {
  switch (status) {
    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.PendingReference:
      return 202;
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.Failed:
      return 500;
    case WagerTransactionStatus.Processed:
      return 200;
  }
}

function transactionEventData(
  transaction: WagerTransaction,
  wallet: Wallet,
): Record<string, unknown> {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    playerId: transaction.playerId,
    walletId: transaction.walletId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    money: transaction.money.toJSON(),
    referenceExternalTransactionId:
      transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    balance: wallet.balance.toJSON(),
    walletVersion: wallet.version,
  };
}

function serializeWallet(row: DatabaseRow): Record<string, unknown> {
  return {
    id: String(row.id),
    playerId: String(row.player_id),
    currency: String(row.currency).trim(),
    balance: moneyFromRow(row.balance, row.currency).toJSON(),
    version: Number(row.version),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

function serializeLedgerEntry(row: DatabaseRow): Record<string, unknown> {
  const currency = row.currency;
  return {
    id: String(row.id),
    transactionId: String(row.transaction_id),
    direction: String(row.direction),
    money: moneyFromRow(row.amount, currency).toJSON(),
    balanceBefore: moneyFromRow(row.balance_before, currency).toJSON(),
    balanceAfter: moneyFromRow(row.balance_after, currency).toJSON(),
    walletVersion: Number(row.wallet_version),
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

function serializeTransaction(
  row: DatabaseRow,
  idempotentReplay = false,
): Record<string, unknown> {
  const resultBalance =
    row.result_balance === null
      ? null
      : moneyFromRow(row.result_balance, row.currency).toJSON();
  return {
    id: String(row.id),
    providerId: String(row.provider_id),
    externalTransactionId: String(row.external_transaction_id),
    playerId: String(row.player_id),
    walletId: String(row.wallet_id),
    roundId: String(row.round_id),
    gameId: String(row.game_id),
    kind: String(row.kind),
    money: moneyFromRow(row.amount, row.currency).toJSON(),
    referenceExternalTransactionId:
      row.reference_external_transaction_id === null
        ? null
        : String(row.reference_external_transaction_id),
    referenceTransactionId:
      row.reference_transaction_id === null
        ? null
        : String(row.reference_transaction_id),
    status: String(row.status),
    failureCode:
      row.failure_code === null ? null : String(row.failure_code),
    processedAt:
      row.processed_at === null
        ? null
        : new Date(String(row.processed_at)).toISOString(),
    balance: resultBalance,
    walletVersion:
      row.result_wallet_version === null
        ? null
        : Number(row.result_wallet_version),
    idempotentReplay,
  };
}

function transactionNotFound(): NotFoundException {
  return new NotFoundException({
    code: 'TRANSACTION_NOT_FOUND',
    message: 'Wagering transaction was not found',
  });
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}\n${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const separator = decoded.indexOf('\n');
    const createdAt = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    if (
      separator < 1 ||
      !Number.isFinite(Date.parse(createdAt)) ||
      id.length < 1 ||
      id.length > 64
    ) {
      throw new Error('Malformed cursor');
    }
    return { createdAt: new Date(createdAt).toISOString(), id };
  } catch {
    throw new UnprocessableEntityException({
      code: 'INVALID_CURSOR',
      message: 'cursor is invalid',
    });
  }
}
