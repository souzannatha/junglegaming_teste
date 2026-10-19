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
