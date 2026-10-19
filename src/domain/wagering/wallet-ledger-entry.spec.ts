import { InvalidLedgerEntryError } from '../errors/domain.error.js';
import { Money } from '../money/money.js';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry.js';

const at = new Date('2026-01-01T00:00:00.000Z');
const money = (amount: string, currency = 'BRL') =>
  Money.from({ amount, currency });

const createEntry = (
  overrides: Partial<Parameters<typeof WalletLedgerEntry.create>[0]> = {},
) =>
  WalletLedgerEntry.create({
    id: 'entry-1',
    walletId: 'wallet-1',
    transactionId: 'transaction-1',
    direction: LedgerDirection.Debit,
    money: money('25.00'),
    balanceBefore: money('100.00'),
    balanceAfter: money('75.00'),
    createdAt: at,
    ...overrides,
  });

describe('WalletLedgerEntry', () => {
  it('creates a balanced immutable debit entry', () => {
    const entry = createEntry();

    expect(entry.isBalanced()).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(entry.balanceAfter.toString()).toBe('75.00');
  });

  it('validates credit arithmetic', () => {
    const entry = createEntry({
      direction: LedgerDirection.Credit,
      balanceBefore: money('75.00'),
      balanceAfter: money('100.00'),
    });

    expect(entry.isBalanced()).toBe(true);
  });

  it.each([
    {
      name: 'mismatched balance arithmetic',
      overrides: { balanceAfter: money('74.99') },
    },
    {
      name: 'zero amount',
      overrides: { money: Money.zero('BRL') },
    },
    {
      name: 'negative resulting balance',
      overrides: {
        balanceBefore: money('10.00'),
        balanceAfter: money('-15.00'),
      },
    },
    {
      name: 'different currency',
      overrides: { balanceAfter: money('75.00', 'USD') },
    },
    {
      name: 'invalid identifier',
      overrides: { transactionId: ' ' },
    },
  ])('rejects $name', ({ overrides }) => {
    expect(() => createEntry(overrides)).toThrow(InvalidLedgerEntryError);
  });

  it('returns a defensive timestamp copy', () => {
    const entry = createEntry();
    const changedDate = entry.createdAt;
    changedDate.setUTCFullYear(2030);

    expect(entry.createdAt).toEqual(at);
  });
});
