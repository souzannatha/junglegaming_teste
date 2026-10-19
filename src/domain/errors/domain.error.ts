export abstract class DomainError extends Error {
  protected constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super(message, 'INVALID_MONEY');
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(leftCurrency: string, rightCurrency: string) {
    super(
      `Cannot operate on different currencies: ${leftCurrency} and ${rightCurrency}`,
      'CURRENCY_MISMATCH',
    );
  }
}

export class InvalidWagerTransactionError extends DomainError {
  constructor(message: string) {
    super(message, 'INVALID_WAGER_TRANSACTION');
  }
}

export class InvalidTransactionStateError extends DomainError {
  constructor(status: string, transition: string) {
    super(
      `Cannot apply ${transition} transition to a ${status} transaction`,
      'INVALID_TRANSACTION_STATE',
    );
  }
}

export class InvalidWalletOperationError extends DomainError {
  constructor(message: string) {
    super(message, 'INVALID_WALLET_OPERATION');
  }
}

export class InvalidLedgerEntryError extends DomainError {
  constructor(message: string) {
    super(message, 'INVALID_LEDGER_ENTRY');
  }
}

export class IdempotencyConflictError extends DomainError {
  constructor() {
    super(
      'The idempotency key was already used with a different payload',
      'IDEMPOTENCY_CONFLICT',
    );
  }
}

export enum WagerFailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceTypeNotAllowed = 'REFERENCE_TYPE_NOT_ALLOWED',
  ReferenceContextMismatch = 'REFERENCE_CONTEXT_MISMATCH',
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
}

export class WagerRuleViolationError extends DomainError {
  constructor(public readonly failureCode: WagerFailureCode) {
    super(failureCode, failureCode);
  }
}
