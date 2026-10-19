import {
  CurrencyMismatchError,
  InvalidMoneyError,
} from '../errors/domain.error.js';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const DECIMAL_AMOUNT_PATTERN = /^(-?)(0|[1-9]\d*)\.(\d{2})$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MINOR_UNITS_PER_MAJOR_UNIT = 100n;

export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    if (
      props === null ||
      typeof props !== 'object' ||
      typeof props.amount !== 'string' ||
      typeof props.currency !== 'string'
    ) {
      throw new InvalidMoneyError('Money requires a decimal string and currency');
    }

    const currency = props.currency;
    if (!CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError('Currency must be an uppercase ISO-4217 code');
    }

    const match = DECIMAL_AMOUNT_PATTERN.exec(props.amount);
    if (!match) {
      throw new InvalidMoneyError(
        'Amount must be a decimal string with exactly two fractional digits',
      );
    }

    const [, sign, majorUnits, fractionalUnits] = match;
    const absoluteMinorUnits =
      BigInt(majorUnits) * MINOR_UNITS_PER_MAJOR_UNIT +
      BigInt(fractionalUnits);
    const minorUnits = sign === '-' ? -absoluteMinorUnits : absoluteMinorUnits;

    return new Money(minorUnits, currency);
  }

  static zero(currency: string): Money {
    if (!CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError('Currency must be an uppercase ISO-4217 code');
    }

    return new Money(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  equals(other: Money): boolean {
    return (
      this.currency === other.currency && this.minorUnits === other.minorUnits
    );
  }

  toJSON(): MoneyProps {
    return {
      amount: this.toString(),
      currency: this.currency,
    };
  }

  toString(): string {
    const isNegative = this.minorUnits < 0n;
    const absoluteMinorUnits = isNegative
      ? -this.minorUnits
      : this.minorUnits;
    const majorUnits = absoluteMinorUnits / MINOR_UNITS_PER_MAJOR_UNIT;
    const fractionalUnits = absoluteMinorUnits % MINOR_UNITS_PER_MAJOR_UNIT;
    const sign = isNegative ? '-' : '';

    return `${sign}${majorUnits}.${fractionalUnits.toString().padStart(2, '0')}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
