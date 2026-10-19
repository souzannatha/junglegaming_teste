import { CurrencyMismatchError, InvalidMoneyError } from '../errors/domain.error.js';
import { Money } from './money.js';

describe('Money', () => {
  describe('from', () => {
    it('parses fixed-scale decimal strings without losing precision', () => {
      const money = Money.from({
        amount: '9007199254740993.99',
        currency: 'BRL',
      });

      expect(money.toString()).toBe('9007199254740993.99');
      expect(money.toJSON()).toEqual({
        amount: '9007199254740993.99',
        currency: 'BRL',
      });
    });

    it('normalizes negative zero', () => {
      const money = Money.from({ amount: '-0.00', currency: 'BRL' });

      expect(money.toString()).toBe('0.00');
      expect(money.isZero()).toBe(true);
    });

    it.each([
      '',
      ' ',
      'NaN',
      'Infinity',
      '-Infinity',
      '1e3',
      '1.0',
      '1.000',
      '.50',
      '01.00',
      '+1.00',
      '--1.00',
    ])('rejects invalid amount %j', (amount) => {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(
        InvalidMoneyError,
      );
    });

    it.each(['brl', 'BR', 'BRLX', '1RL', ''])(
      'rejects invalid currency %j',
      (currency) => {
        expect(() => Money.from({ amount: '1.00', currency })).toThrow(
          InvalidMoneyError,
        );
      },
    );
  });

  describe('arithmetic', () => {
    it('returns new values when adding and subtracting', () => {
      const initial = Money.from({ amount: '10.25', currency: 'BRL' });
      const added = initial.add(
        Money.from({ amount: '0.75', currency: 'BRL' }),
      );
      const subtracted = added.subtract(
        Money.from({ amount: '2.10', currency: 'BRL' }),
      );

      expect(initial.toString()).toBe('10.25');
      expect(added.toString()).toBe('11.00');
      expect(subtracted.toString()).toBe('8.90');
      expect(added).not.toBe(initial);
    });

    it('negates values and identifies their signs', () => {
      const positive = Money.from({ amount: '1.01', currency: 'BRL' });
      const negative = positive.negate();

      expect(positive.isPositive()).toBe(true);
      expect(negative.toString()).toBe('-1.01');
      expect(negative.isNegative()).toBe(true);
      expect(negative.negate().equals(positive)).toBe(true);
      expect(Money.zero('BRL').negate().isZero()).toBe(true);
    });

    it('compares values with the same currency', () => {
      const one = Money.from({ amount: '1.00', currency: 'BRL' });
      const two = Money.from({ amount: '2.00', currency: 'BRL' });

      expect(one.isLessThan(two)).toBe(true);
      expect(two.isLessThan(one)).toBe(false);
      expect(one.equals(Money.from({ amount: '1.00', currency: 'BRL' }))).toBe(
        true,
      );
    });

    it.each([
      (left: Money, right: Money) => left.add(right),
      (left: Money, right: Money) => left.subtract(right),
      (left: Money, right: Money) => left.isLessThan(right),
    ])('rejects arithmetic across currencies', (operation) => {
      const brl = Money.from({ amount: '1.00', currency: 'BRL' });
      const usd = Money.from({ amount: '1.00', currency: 'USD' });

      expect(() => operation(brl, usd)).toThrow(CurrencyMismatchError);
    });
  });
});
