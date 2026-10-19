import {
  IdempotencyConflictError,
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  WagerFailureCode,
} from '../errors/domain.error.js';
import { Money } from '../money/money.js';
import { LedgerDirection } from './wallet-ledger-entry.js';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
}

export interface CreateOpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  createdAt?: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: WagerFailureCode;
  processedAt?: Date;
}

export class WagerTransaction {
  private readonly createdAtTimestamp: number;
  private _status: WagerTransactionStatus;
  private _referenceTransactionId?: string;
  private _failureCode?: WagerFailureCode;
  private _processedAtTimestamp?: number;

  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    createdAt: Date,
    status: WagerTransactionStatus,
    referenceTransactionId?: string,
    failureCode?: WagerFailureCode,
    processedAt?: Date,
  ) {
    this.createdAtTimestamp = createdAt.getTime();
    this._status = status;
    this._referenceTransactionId = referenceTransactionId;
    this._failureCode = failureCode;
    this._processedAtTimestamp = processedAt?.getTime();
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    this.assertValidInput(props);
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError(
        'OPENING transactions can only be created internally',
      );
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt ?? new Date(),
      WagerTransactionStatus.Pending,
    );
  }

  static createOpening(props: CreateOpeningTransactionProps): WagerTransaction {
    this.assertIdentifiers([props.id, props.walletId, props.playerId]);
    this.assertPositiveMoney(props.money);
    const createdAt = props.createdAt ?? new Date();
    this.assertValidDate(createdAt);

    const externalTransactionId = `opening:${props.walletId}`;

    return new WagerTransaction(
      props.id,
      'internal',
      externalTransactionId,
      externalTransactionId,
      `opening:${props.walletId}:${props.money.currency}:${props.money.toString()}`,
      props.walletId,
      props.playerId,
      'internal',
      'internal',
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): WagerFailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAtTimestamp === undefined
      ? undefined
      : new Date(this._processedAtTimestamp);
  }

  get createdAt(): Date {
    return new Date(this.createdAtTimestamp);
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNonTerminal('mark processed');
    WagerTransaction.assertValidDate(at);

    if (
      this.referenceExternalTransactionId !== undefined &&
      !referenceTransactionId?.trim()
    ) {
      throw new InvalidWagerTransactionError(
        `${this.kind} requires its declared reference to be resolved`,
      );
    }

    if (
      referenceTransactionId !== undefined &&
      !referenceTransactionId.trim()
    ) {
      throw new InvalidWagerTransactionError(
        'Resolved reference transaction identifier must not be empty',
      );
    }

    this._referenceTransactionId = referenceTransactionId;
    this._processedAtTimestamp = at.getTime();
    this._status = WagerTransactionStatus.Processed;
    this._failureCode = undefined;
  }

  markPendingReference(): void {
    if (
      this._status !== WagerTransactionStatus.Pending ||
      this.referenceExternalTransactionId === undefined
    ) {
      throw new InvalidTransactionStateError(
        this._status,
        'mark pending reference',
      );
    }
    this._status = WagerTransactionStatus.PendingReference;
  }

  markPending(): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(this._status, 'resume pending');
    }
    this._status = WagerTransactionStatus.Pending;
  }

  reject(code: WagerFailureCode): void {
    this.assertNonTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
  }

  fail(code: WagerFailureCode): void {
    this.assertNonTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  assertIdempotentReplay(idempotencyKey: string, payloadHash: string): void {
    if (idempotencyKey !== this.idempotencyKey) {
      throw new InvalidWagerTransactionError(
        'Idempotency key does not identify this transaction',
      );
    }
    this.assertPayloadMatches(payloadHash);
  }

  assertPayloadMatches(payloadHash: string): void {
    if (!this.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError();
    }
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError(
          'LOSS transactions do not create ledger entries',
        );
      case WagerTransactionKind.Rollback:
        if (!reference) {
          throw new InvalidWagerTransactionError(
            'ROLLBACK requires a resolved reference transaction',
          );
        }
        if (reference.kind === WagerTransactionKind.Bet) {
          return LedgerDirection.Credit;
        }
        if (
          reference.kind === WagerTransactionKind.Win ||
          reference.kind === WagerTransactionKind.Refund
        ) {
          return LedgerDirection.Debit;
        }
        throw new InvalidWagerTransactionError(
          `ROLLBACK cannot reverse ${reference.kind}`,
        );
    }
  }

  insufficientFundsFailureCode(): WagerFailureCode {
    return this.kind === WagerTransactionKind.Rollback
      ? WagerFailureCode.ReversalInsufficientFunds
      : WagerFailureCode.InsufficientFunds;
  }

  private assertNonTerminal(transition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this._status, transition);
    }
  }

  private static assertValidInput(props: CreateWagerTransactionProps): void {
    this.assertIdentifiers([
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
    ]);
    this.assertPositiveMoney(props.money);

    const createdAt = props.createdAt ?? new Date();
    this.assertValidDate(createdAt);

    if (
      props.referenceExternalTransactionId !== undefined &&
      !props.referenceExternalTransactionId.trim()
    ) {
      throw new InvalidWagerTransactionError(
        'Reference transaction identifier must not be empty',
      );
    }

    const requiresReference =
      props.kind === WagerTransactionKind.Refund ||
      props.kind === WagerTransactionKind.Rollback;
    if (requiresReference && !props.referenceExternalTransactionId?.trim()) {
      throw new InvalidWagerTransactionError(
        `${props.kind} requires a reference transaction identifier`,
      );
    }

    const allowsReference =
      props.kind === WagerTransactionKind.Win ||
      props.kind === WagerTransactionKind.Refund ||
      props.kind === WagerTransactionKind.Rollback;
    if (props.referenceExternalTransactionId && !allowsReference) {
      throw new InvalidWagerTransactionError(
        `${props.kind} cannot reference another transaction`,
      );
    }

    if (
      !Object.values(WagerTransactionKind).includes(props.kind) ||
      props.kind === WagerTransactionKind.Opening
    ) {
      throw new InvalidWagerTransactionError(
        'Transaction kind is not valid for provider-submitted wagers',
      );
    }
  }

  private static assertIdentifiers(identifiers: string[]): void {
    if (identifiers.some((identifier) => !identifier.trim())) {
      throw new InvalidWagerTransactionError(
        'Transaction identifiers and context must not be empty',
      );
    }
  }

  private static assertPositiveMoney(money: Money): void {
    if (!money.isPositive()) {
      throw new InvalidWagerTransactionError(
        'Wager transaction amount must be positive',
      );
    }
  }

  private static assertValidDate(date: Date): void {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      throw new InvalidWagerTransactionError(
        'Transaction timestamp must be valid',
      );
    }
  }
}
