import { InvalidLedgerEntryError } from '../errors/domain.error.js';
import { Money } from '../money/money.js';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export interface LedgerEntryState extends CreateLedgerEntryProps {}

export class WalletLedgerEntry {
  private readonly createdAtTimestamp: number;

  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    createdAt: Date,
  ) {
    this.createdAtTimestamp = createdAt.getTime();
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    this.assertValid(props);
    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt,
    );

    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        'Ledger entry balance does not match its direction and amount',
      );
    }

    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  get createdAt(): Date {
    return new Date(this.createdAtTimestamp);
  }

  isBalanced(): boolean {
    if (
      this.money.currency !== this.balanceBefore.currency ||
      this.money.currency !== this.balanceAfter.currency ||
      !this.money.isPositive()
    ) {
      return false;
    }

    const expectedBalance =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);

    return (
      !this.balanceBefore.isNegative() &&
      !this.balanceAfter.isNegative() &&
      expectedBalance.equals(this.balanceAfter)
    );
  }

  private static assertValid(props: CreateLedgerEntryProps): void {
    if (
      !props.id.trim() ||
      !props.walletId.trim() ||
      !props.transactionId.trim()
    ) {
      throw new InvalidLedgerEntryError(
        'Ledger entry identifiers must not be empty',
      );
    }

    if (
      !(props.createdAt instanceof Date) ||
      Number.isNaN(props.createdAt.getTime())
    ) {
      throw new InvalidLedgerEntryError('Ledger entry timestamp must be valid');
    }

    if (
      props.direction !== LedgerDirection.Debit &&
      props.direction !== LedgerDirection.Credit
    ) {
      throw new InvalidLedgerEntryError('Ledger direction is invalid');
    }

    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError('Ledger amount must be positive');
    }

    if (
      props.money.currency !== props.balanceBefore.currency ||
      props.money.currency !== props.balanceAfter.currency
    ) {
      throw new InvalidLedgerEntryError(
        'Ledger amount and balances must use the same currency',
      );
    }
  }
}
