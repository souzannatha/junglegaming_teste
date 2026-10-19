import {
  IdempotencyConflictError,
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  WagerFailureCode,
} from '../errors/domain.error.js';
import { Money } from '../money/money.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction.js';
import { LedgerDirection } from './wallet-ledger-entry.js';

const at = new Date('2026-01-01T00:00:00.000Z');
const money = (amount: string, currency = 'BRL') =>
  Money.from({ amount, currency });

const createTransaction = (
  overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {},
) =>
  WagerTransaction.create({
    id: 'transaction-1',
    providerId: 'provider-1',
    externalTransactionId: 'external-1',
    idempotencyKey: 'key-1',
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: money('10.00'),
    createdAt: at,
    ...overrides,
  });

describe('WagerTransaction', () => {
  it('creates provider transactions in PENDING', () => {
    const transaction = createTransaction();

    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(transaction.isTerminal()).toBe(false);
    expect(transaction.affectsBalance()).toBe(true);
    expect(transaction.requiresReference()).toBe(false);
  });

  it('keeps OPENING internal and requires references for reversal kinds', () => {
    expect(() =>
      createTransaction({ kind: WagerTransactionKind.Opening }),
    ).toThrow(InvalidWagerTransactionError);

    expect(() =>
      createTransaction({ kind: WagerTransactionKind.Refund }),
    ).toThrow(InvalidWagerTransactionError);
    expect(() =>
      createTransaction({ kind: WagerTransactionKind.Rollback }),
    ).toThrow(InvalidWagerTransactionError);
  });

  it('creates an internal opening transaction for a positive opening credit', () => {
    const opening = WagerTransaction.createOpening({
      id: 'opening-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      money: money('100.00'),
      createdAt: at,
    });

    expect(opening.kind).toBe(WagerTransactionKind.Opening);
    expect(opening.providerId).toBe('internal');
    expect(opening.status).toBe(WagerTransactionStatus.Pending);
    expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  it('rejects zero transaction amounts and references on unsupported kinds', () => {
    expect(() => createTransaction({ money: Money.zero('BRL') })).toThrow(
      InvalidWagerTransactionError,
    );
    expect(() =>
      createTransaction({
        referenceExternalTransactionId: 'external-ref',
      }),
    ).toThrow(InvalidWagerTransactionError);
  });

  it('moves reference-dependent operations into and out of PENDING_REFERENCE', () => {
    const transaction = createTransaction({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'bet-1',
    });

    transaction.markPendingReference();
    expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);

    transaction.markPending();
    expect(transaction.status).toBe(WagerTransactionStatus.Pending);

    transaction.markProcessed('internal-bet-1', at);
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.referenceTransactionId).toBe('internal-bet-1');
    expect(transaction.processedAt).toEqual(at);
  });

  it('allows an explicitly referenced WIN to wait for its BET', () => {
    const transaction = createTransaction({
      kind: WagerTransactionKind.Win,
      referenceExternalTransactionId: 'bet-1',
    });

    transaction.markPendingReference();
    expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);
    expect(() => transaction.markProcessed(undefined, at)).toThrow(
      InvalidWagerTransactionError,
    );
  });

  it('requires a resolved reference before processing REFUND or ROLLBACK', () => {
    const transaction = createTransaction({
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'bet-1',
    });

    expect(() => transaction.markProcessed(undefined, at)).toThrow(
      InvalidWagerTransactionError,
    );
    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
  });

  it('makes processed, rejected, and failed states terminal', () => {
    const processed = createTransaction();
    processed.markProcessed(undefined, at);

    const rejected = createTransaction({ id: 'transaction-2' });
    rejected.reject(WagerFailureCode.InsufficientFunds);

    const failed = createTransaction({ id: 'transaction-3' });
    failed.fail(WagerFailureCode.ReferenceNotFound);

    for (const transaction of [processed, rejected, failed]) {
      expect(transaction.isTerminal()).toBe(true);
      expect(() => transaction.markProcessed(undefined, at)).toThrow(
        InvalidTransactionStateError,
      );
      expect(() =>
        transaction.reject(WagerFailureCode.InsufficientFunds),
      ).toThrow(InvalidTransactionStateError);
    }
  });

  it('rehydrates persisted terminal state without replaying transitions', () => {
    const transaction = WagerTransaction.rehydrate({
      id: 'transaction-1',
      providerId: 'provider-1',
      externalTransactionId: 'external-1',
      idempotencyKey: 'key-1',
      payloadHash: 'hash-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: money('10.00'),
      createdAt: at,
      status: WagerTransactionStatus.Rejected,
      failureCode: WagerFailureCode.InsufficientFunds,
    });

    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.failureCode).toBe(WagerFailureCode.InsufficientFunds);
    expect(transaction.isTerminal()).toBe(true);
  });

  it('detects conflicting idempotency payloads', () => {
    const transaction = createTransaction();

    expect(transaction.matchesPayload('hash-1')).toBe(true);
    expect(() =>
      transaction.assertIdempotentReplay('key-1', 'hash-1'),
    ).not.toThrow();
    expect(() =>
      transaction.assertIdempotentReplay('key-1', 'different-hash'),
    ).toThrow(IdempotencyConflictError);
  });

  it('does not create ledger entries for LOSS', () => {
    const loss = createTransaction({ kind: WagerTransactionKind.Loss });

    expect(loss.affectsBalance()).toBe(false);
    expect(() => loss.ledgerDirectionFor()).toThrow(
      InvalidWagerTransactionError,
    );
  });

  it('selects a distinct insufficient-funds failure code for ROLLBACK', () => {
    const bet = createTransaction();
    const rollback = createTransaction({
      id: 'rollback-1',
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'bet-1',
    });

    expect(bet.insufficientFundsFailureCode()).toBe(
      WagerFailureCode.InsufficientFunds,
    );
    expect(rollback.insufficientFundsFailureCode()).toBe(
      WagerFailureCode.ReversalInsufficientFunds,
    );
  });

  it('returns the correct direction for each supported transaction kind', () => {
    const bet = createTransaction();
    const win = createTransaction({
      id: 'win-1',
      kind: WagerTransactionKind.Win,
    });
    const refund = createTransaction({
      id: 'refund-1',
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'bet-1',
    });
    const rollback = createTransaction({
      id: 'rollback-1',
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'bet-1',
    });
    const rollbackWin = createTransaction({
      id: 'rollback-2',
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'win-1',
    });
    const processedBet = createTransaction({
      externalTransactionId: 'bet-1',
    });
    const processedWin = createTransaction({
      id: 'win-1',
      externalTransactionId: 'win-1',
      kind: WagerTransactionKind.Win,
    });

    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(processedBet)).toBe(
      LedgerDirection.Credit,
    );
    expect(rollbackWin.ledgerDirectionFor(processedWin)).toBe(
      LedgerDirection.Debit,
    );
  });
});
