import {
  CurrencyMismatchError,
  InvalidWalletOperationError,
  WagerFailureCode,
  WagerRuleViolationError,
} from '../errors/domain.error.js';
import { Money } from '../money/money.js';
import { LedgerDirection } from './wallet-ledger-entry.js';
import { Wallet } from './wallet.js';

const at = new Date('2026-01-01T00:00:00.000Z');
const money = (amount: string, currency = 'BRL') =>
  Money.from({ amount, currency });

describe('Wallet', () => {
  it('opens with version 1 and the provided initial balance', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: money('100.00'),
      createdAt: at,
    });

    expect(wallet.balance.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    expect(wallet.version).toBe(1);
    expect(wallet.createdAt).toEqual(at);
    expect(wallet.updatedAt).toEqual(at);
  });

  it('allows opening with a zero balance but rejects a negative one', () => {
    expect(
      Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: Money.zero('BRL'),
        createdAt: at,
      }).balance.isZero(),
    ).toBe(true);

    expect(() =>
      Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: money('-0.01'),
        createdAt: at,
      }),
    ).toThrow(InvalidWalletOperationError);
  });

  it('debits and credits atomically, returning matching ledger entries', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: money('100.00'),
      createdAt: at,
    });

    const debit = wallet.debit({
      entryId: 'entry-1',
      transactionId: 'bet-1',
      amount: money('25.00'),
      at,
    });
    expect(debit.direction).toBe(LedgerDirection.Debit);
    expect(debit.balanceBefore.toString()).toBe('100.00');
    expect(debit.balanceAfter.toString()).toBe('75.00');
    expect(wallet.balance.toString()).toBe('75.00');
    expect(wallet.version).toBe(2);

    const credit = wallet.credit({
      entryId: 'entry-2',
      transactionId: 'win-1',
      amount: money('10.00'),
      at: new Date(at.getTime() + 1000),
    });
    expect(credit.direction).toBe(LedgerDirection.Credit);
    expect(credit.balanceBefore.toString()).toBe('75.00');
    expect(credit.balanceAfter.toString()).toBe('85.00');
    expect(wallet.balance.toString()).toBe('85.00');
    expect(wallet.version).toBe(3);
    expect(wallet.updatedAt).toEqual(new Date(at.getTime() + 1000));
  });

  it('rejects an unaffordable debit without mutating wallet state', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: money('20.00'),
      createdAt: at,
    });

    expect(() =>
      wallet.debit({
        entryId: 'entry-1',
        transactionId: 'bet-1',
        amount: money('20.01'),
        at: new Date(at.getTime() + 1000),
      }),
    ).toThrow(
      expect.objectContaining({
        failureCode: WagerFailureCode.InsufficientFunds,
      }),
    );
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(at);
  });

  it('preserves a distinct failure code for unaffordable reversals', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: money('20.00'),
      createdAt: at,
    });

    try {
      wallet.debit({
        entryId: 'entry-1',
        transactionId: 'rollback-1',
        amount: money('25.00'),
        at: new Date(at.getTime() + 1000),
        insufficientFundsCode: WagerFailureCode.ReversalInsufficientFunds,
      });
      throw new Error('Expected debit to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(WagerRuleViolationError);
      expect((error as WagerRuleViolationError).failureCode).toBe(
        WagerFailureCode.ReversalInsufficientFunds,
      );
    }
  });

  it('rejects movement with a different currency, non-positive amount, or older timestamp', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: money('20.00'),
      createdAt: at,
    });

    const baseProps = {
      entryId: 'entry-1',
      transactionId: 'bet-1',
      at,
    };

    expect(() =>
      wallet.debit({ ...baseProps, amount: money('1.00', 'USD') }),
    ).toThrow(CurrencyMismatchError);
    expect(() =>
      wallet.credit({ ...baseProps, amount: Money.zero('BRL') }),
    ).toThrow(InvalidWalletOperationError);
    expect(() =>
      wallet.credit({
        ...baseProps,
        amount: money('1.00'),
        at: new Date(at.getTime() - 1),
      }),
    ).toThrow(InvalidWalletOperationError);

    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(1);
  });

  it('returns defensive copies of timestamps', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: money('1.00'),
      createdAt: at,
    });
    const changedDate = wallet.updatedAt;
    changedDate.setUTCFullYear(2030);

    expect(wallet.updatedAt).toEqual(at);
  });
});
