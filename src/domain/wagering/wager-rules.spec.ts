import {
  WagerFailureCode,
  WagerRuleViolationError,
} from '../errors/domain.error.js';
import { Money } from '../money/money.js';
import { WagerTransaction, WagerTransactionKind } from './wager-transaction.js';
import { WagerRules } from './wager-rules.js';

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

const processed = (kind = WagerTransactionKind.Bet) => {
  const transaction = createTransaction({
    id: `reference-${kind}`,
    externalTransactionId: 'reference-external',
    kind,
    referenceExternalTransactionId:
      kind === WagerTransactionKind.Refund ||
      kind === WagerTransactionKind.Rollback
        ? 'prior-reference'
        : undefined,
  });
  transaction.markProcessed(
    transaction.requiresReference() ? 'prior-internal-reference' : undefined,
    at,
  );
  return transaction;
};

const createReversal = (
  kind: WagerTransactionKind.Refund | WagerTransactionKind.Rollback,
  overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {},
) =>
  createTransaction({
    id: 'reversal-1',
    kind,
    referenceExternalTransactionId: 'reference-external',
    ...overrides,
  });

describe('WagerRules', () => {
  it('accepts an unreferenced BET and LOSS', () => {
    expect(() =>
      WagerRules.validateReference(createTransaction(), undefined),
    ).not.toThrow();
    expect(() =>
      WagerRules.validateReference(
        createTransaction({ kind: WagerTransactionKind.Loss }),
        undefined,
      ),
    ).not.toThrow();
  });

  it('allows WIN to reference a processed BET in the same context', () => {
    const bet = processed();
    const win = createTransaction({
      kind: WagerTransactionKind.Win,
      referenceExternalTransactionId: 'reference-external',
    });

    expect(() => WagerRules.validateReference(win, bet)).not.toThrow();
  });

  it('allows REFUND only for a processed BET and exact amount', () => {
    const bet = processed();
    const refund = createReversal(WagerTransactionKind.Refund);

    expect(() => WagerRules.validateReference(refund, bet)).not.toThrow();
    expect(() =>
      WagerRules.validateReference(
        createReversal(WagerTransactionKind.Refund, {
          money: money('9.99'),
        }),
        bet,
      ),
    ).toThrow(
      expect.objectContaining({
        failureCode: WagerFailureCode.ReferenceAmountMismatch,
      }),
    );
  });

  it.each([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ])('allows ROLLBACK to reverse processed %s with matching amount', (kind) => {
    const reference = processed(kind);
    const rollback = createReversal(WagerTransactionKind.Rollback);

    expect(() =>
      WagerRules.validateReference(rollback, reference),
    ).not.toThrow();
  });

  it('allows one reversal of each type but prevents repeating the same type', () => {
    const bet = processed();
    const refund = createReversal(WagerTransactionKind.Refund);
    const rollback = createReversal(WagerTransactionKind.Rollback);

    expect(() =>
      WagerRules.validateReference(refund, bet, [refund]),
    ).not.toThrow();
    expect(() =>
      WagerRules.validateReference(
        createReversal(WagerTransactionKind.Refund, { id: 'refund-2' }),
        bet,
        [refund],
      ),
    ).toThrow(
      expect.objectContaining({
        failureCode: WagerFailureCode.ReferenceAlreadyReversed,
      }),
    );
    expect(() =>
      WagerRules.validateReference(rollback, bet, [refund]),
    ).not.toThrow();
  });

  it('rejects a missing reference for reference-dependent transactions', () => {
    const refund = createReversal(WagerTransactionKind.Refund);

    expect(() => WagerRules.validateReference(refund, undefined)).toThrow(
      expect.objectContaining({
        failureCode: WagerFailureCode.ReferenceNotFound,
      }),
    );
  });

  it('rejects an absent explicitly declared optional WIN reference', () => {
    const win = createTransaction({
      kind: WagerTransactionKind.Win,
      referenceExternalTransactionId: 'missing',
    });

    expect(() => WagerRules.validateReference(win, undefined)).toThrow(
      expect.objectContaining({
        failureCode: WagerFailureCode.ReferenceNotFound,
      }),
    );
  });

  it('distinguishes not processed, type mismatch, and context mismatch', () => {
    const pendingBet = createTransaction({
      externalTransactionId: 'reference-external',
    });
    const refund = createReversal(WagerTransactionKind.Refund);

    expect(() => WagerRules.validateReference(refund, pendingBet)).toThrow(
      expect.objectContaining({
        failureCode: WagerFailureCode.ReferenceNotProcessed,
      }),
    );

    const processedWin = processed(WagerTransactionKind.Win);
    expect(() => WagerRules.validateReference(refund, processedWin)).toThrow(
      expect.objectContaining({
        failureCode: WagerFailureCode.ReferenceTypeNotAllowed,
      }),
    );

    const otherWallet = processed();
    const mismatchedRefund = createReversal(WagerTransactionKind.Refund, {
      walletId: 'wallet-2',
    });
    expect(() =>
      WagerRules.validateReference(mismatchedRefund, otherWallet),
    ).toThrow(
      expect.objectContaining({
        failureCode: WagerFailureCode.ReferenceContextMismatch,
      }),
    );
  });

  it('rejects a reference from another provider or with a different external id', () => {
    const bet = processed();
    const refund = createReversal(WagerTransactionKind.Refund);

    const otherProvider = WagerTransaction.rehydrate({
      id: bet.id,
      providerId: 'provider-2',
      externalTransactionId: bet.externalTransactionId,
      idempotencyKey: bet.idempotencyKey,
      payloadHash: bet.payloadHash,
      walletId: bet.walletId,
      playerId: bet.playerId,
      roundId: bet.roundId,
      gameId: bet.gameId,
      kind: bet.kind,
      money: bet.money,
      createdAt: bet.createdAt,
      status: bet.status,
    });

    expect(() => WagerRules.validateReference(refund, otherProvider)).toThrow(
      WagerRuleViolationError,
    );
    expect(() =>
      WagerRules.validateReference(
        refund,
        WagerTransaction.rehydrate({
          id: bet.id,
          providerId: bet.providerId,
          externalTransactionId: 'different-external',
          idempotencyKey: bet.idempotencyKey,
          payloadHash: bet.payloadHash,
          walletId: bet.walletId,
          playerId: bet.playerId,
          roundId: bet.roundId,
          gameId: bet.gameId,
          kind: bet.kind,
          money: bet.money,
          createdAt: bet.createdAt,
          status: bet.status,
        }),
      ),
    ).toThrow(
      expect.objectContaining({
        failureCode: WagerFailureCode.ReferenceNotFound,
      }),
    );
  });

  it('rejects a reference from another round or currency', () => {
    const bet = processed();
    const otherRound = WagerTransaction.rehydrate({
      id: bet.id,
      providerId: bet.providerId,
      externalTransactionId: bet.externalTransactionId,
      idempotencyKey: bet.idempotencyKey,
      payloadHash: bet.payloadHash,
      walletId: bet.walletId,
      playerId: bet.playerId,
      roundId: 'round-2',
      gameId: bet.gameId,
      kind: bet.kind,
      money: bet.money,
      createdAt: bet.createdAt,
      status: bet.status,
    });
    const refund = createReversal(WagerTransactionKind.Refund);

    expect(() => WagerRules.validateReference(refund, otherRound)).toThrow(
      expect.objectContaining({
        failureCode: WagerFailureCode.ReferenceContextMismatch,
      }),
    );

    const differentCurrency = WagerTransaction.rehydrate({
      id: bet.id,
      providerId: bet.providerId,
      externalTransactionId: bet.externalTransactionId,
      idempotencyKey: bet.idempotencyKey,
      payloadHash: bet.payloadHash,
      walletId: bet.walletId,
      playerId: bet.playerId,
      roundId: bet.roundId,
      gameId: bet.gameId,
      kind: bet.kind,
      money: money('10.00', 'USD'),
      createdAt: bet.createdAt,
      status: bet.status,
    });
    expect(() =>
      WagerRules.validateReference(refund, differentCurrency),
    ).toThrow(
      expect.objectContaining({
        failureCode: WagerFailureCode.ReferenceContextMismatch,
      }),
    );
  });
});
