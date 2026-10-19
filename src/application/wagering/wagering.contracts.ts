import { BadRequestException } from '@nestjs/common';
import { InvalidMoneyError } from '../../domain/errors/domain.error.js';
import { Money } from '../../domain/money/money.js';
import { WagerTransactionKind } from '../../domain/wagering/wager-transaction.js';

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export interface CreateWalletRequest {
  playerId: string;
  initialBalance: Money;
}

export interface SubmitWagerRequest {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;
  money: Money;
  referenceExternalTransactionId?: string;
}

export interface SqsWagerCommand {
  idempotencyKey: string;
  correlationId?: string;
  transaction: SubmitWagerRequest;
}

export function parseSqsWagerCommand(body: unknown): SqsWagerCommand {
  const input = asRecord(body, 'SQS command');
  const correlationId =
    input.correlationId === undefined
      ? undefined
      : requiredString(input.correlationId, 'correlationId', 128);

  if (
    correlationId !== undefined &&
    !/^[A-Za-z0-9._:-]{1,128}$/.test(correlationId)
  ) {
    throw new BadRequestException({
      code: 'INVALID_CORRELATION_ID',
      message: 'correlationId contains invalid characters or length',
    });
  }

  return {
    idempotencyKey: requiredString(input.idempotencyKey, 'idempotencyKey', 256),
    correlationId,
    transaction: parseSubmitWagerRequest(input.transaction),
  };
}

export function parseCreateWalletRequest(body: unknown): CreateWalletRequest {
  const input = asRecord(body);
  const playerId = requiredString(input.playerId, 'playerId', 128);
  const initialBalance = parseMoney(input.initialBalance, 'initialBalance');

  if (initialBalance.isNegative()) {
    throw new BadRequestException({
      code: 'INVALID_MONEY',
      message: 'initialBalance must not be negative',
    });
  }

  return { playerId, initialBalance };
}

export function parseSubmitWagerRequest(body: unknown): SubmitWagerRequest {
  const input = asRecord(body);
  const kind = requiredString(input.kind, 'kind', 16);
  if (
    !Object.values(WagerTransactionKind).includes(
      kind as WagerTransactionKind,
    ) ||
    kind === WagerTransactionKind.Opening
  ) {
    throw new BadRequestException({
      code: 'INVALID_TRANSACTION_KIND',
      message: 'kind must be BET, WIN, LOSS, REFUND, or ROLLBACK',
    });
  }

  const money = parseMoney(input.money, 'money');
  if (!money.isPositive()) {
    throw new BadRequestException({
      code: 'INVALID_MONEY',
      message: 'money.amount must be greater than zero',
    });
  }

  const referenceExternalTransactionId =
    input.referenceExternalTransactionId === undefined
      ? undefined
      : requiredString(
          input.referenceExternalTransactionId,
          'referenceExternalTransactionId',
          256,
        );

  return {
    providerId: requiredString(input.providerId, 'providerId', 128),
    externalTransactionId: requiredString(
      input.externalTransactionId,
      'externalTransactionId',
      256,
    ),
    playerId: requiredString(input.playerId, 'playerId', 128),
    walletId: requiredString(input.walletId, 'walletId', 64),
    roundId: requiredString(input.roundId, 'roundId', 128),
    gameId: requiredString(input.gameId, 'gameId', 128),
    kind: kind as SubmitWagerRequest['kind'],
    money,
    referenceExternalTransactionId,
  };
}

function parseMoney(value: unknown, fieldName: string): Money {
  const input = asRecord(value, fieldName);
  if (typeof input.amount !== 'string') {
    throw new BadRequestException({
      code: 'INVALID_MONEY',
      message: `${fieldName}.amount must be a decimal string`,
    });
  }
  if (
    typeof input.currency !== 'string' ||
    !CURRENCY_PATTERN.test(input.currency)
  ) {
    throw new BadRequestException({
      code: 'INVALID_MONEY',
      message: `${fieldName}.currency must be an uppercase ISO-4217 code`,
    });
  }

  try {
    return Money.from({ amount: input.amount, currency: input.currency });
  } catch (error) {
    if (error instanceof InvalidMoneyError) {
      throw new BadRequestException({
        code: error.code,
        message: `${fieldName}: ${error.message}`,
      });
    }
    throw error;
  }
}

function asRecord(
  value: unknown,
  fieldName = 'request body',
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException({
      code: 'INVALID_REQUEST',
      message: `${fieldName} must be an object`,
    });
  }
  return value as Record<string, unknown>;
}

function requiredString(
  value: unknown,
  fieldName: string,
  maxLength: number,
): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > maxLength
  ) {
    throw new BadRequestException({
      code: 'INVALID_REQUEST',
      message: `${fieldName} must be a non-empty string of at most ${maxLength} characters`,
    });
  }
  return value;
}
