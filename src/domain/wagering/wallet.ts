import {
  CurrencyMismatchError,
  InvalidWalletOperationError,
  WagerFailureCode,
  WagerRuleViolationError,
} from '../errors/domain.error.js';
import { Money } from '../money/money.js';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry.js';

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  createdAt?: Date;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface DebitWalletProps {
  entryId: string;
  transactionId: string;
  amount: Money;
  at: Date;
  insufficientFundsCode?: WagerFailureCode;
}

export interface CreditWalletProps {
  entryId: string;
  transactionId: string;
  amount: Money;
  at: Date;
}

export class Wallet {
  private readonly createdAtTimestamp: number;
  private _balance: Money;
  private _version: number;
  private _updatedAtTimestamp: number;

  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    balance: Money,
    version: number,
    createdAt: Date,
    updatedAt: Date,
  ) {
    this._balance = balance;
    this._version = version;
    this.createdAtTimestamp = createdAt.getTime();
    this._updatedAtTimestamp = updatedAt.getTime();
  }

  static open(props: OpenWalletProps): Wallet {
    if (!props.id.trim() || !props.playerId.trim()) {
      throw new InvalidWalletOperationError(
        'Wallet and player identifiers must not be empty',
      );
    }

    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletOperationError(
        'Wallet initial balance must not be negative',
      );
    }

    const createdAt = props.createdAt ?? new Date();
    this.assertValidDate(createdAt);

    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      createdAt,
      createdAt,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get createdAt(): Date {
    return new Date(this.createdAtTimestamp);
  }

  get updatedAt(): Date {
    return new Date(this._updatedAtTimestamp);
  }

  debit(props: DebitWalletProps): WalletLedgerEntry {
    this.assertValidMovement(props.amount, props.at);

    if (this._balance.isLessThan(props.amount)) {
      throw new WagerRuleViolationError(
        props.insufficientFundsCode ?? WagerFailureCode.InsufficientFunds,
      );
    }

    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.subtract(props.amount);
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction: LedgerDirection.Debit,
      money: props.amount,
      balanceBefore,
      balanceAfter,
      createdAt: props.at,
    });

    this.applyBalanceChange(balanceAfter, props.at);
    return entry;
  }

  credit(props: CreditWalletProps): WalletLedgerEntry {
    this.assertValidMovement(props.amount, props.at);

    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.add(props.amount);
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction: LedgerDirection.Credit,
      money: props.amount,
      balanceBefore,
      balanceAfter,
      createdAt: props.at,
    });

    this.applyBalanceChange(balanceAfter, props.at);
    return entry;
  }

  private assertValidMovement(amount: Money, at: Date): void {
    if (amount.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, amount.currency);
    }

    if (!amount.isPositive()) {
      throw new InvalidWalletOperationError(
        'Wallet movement amount must be positive',
      );
    }

    Wallet.assertValidDate(at);
    if (at.getTime() < this._updatedAtTimestamp) {
      throw new InvalidWalletOperationError(
        'Wallet update timestamp must not move backwards',
      );
    }
  }

  private applyBalanceChange(balance: Money, at: Date): void {
    this._balance = balance;
    this._version += 1;
    this._updatedAtTimestamp = at.getTime();
  }

  private static assertValidDate(date: Date): void {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      throw new InvalidWalletOperationError('Wallet timestamp must be valid');
    }
  }
}
