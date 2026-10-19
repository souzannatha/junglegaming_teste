import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { WageringService } from '../application/wagering/wagering.service.js';
import {
  parseCreateWalletRequest,
  parseSubmitWagerRequest,
} from '../application/wagering/wagering.contracts.js';

@Controller('wallets')
export class WalletsController {
  constructor(private readonly wageringService: WageringService) {}

  @Post()
  @HttpCode(201)
  create(@Body() body: unknown) {
    return this.wageringService.createWallet(parseCreateWalletRequest(body));
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string) {
    return this.wageringService.getWallet(identifier(walletId, 'walletId', 64));
  }

  @Get(':walletId/ledger')
  getLedger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 50,
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException({
        code: 'INVALID_LIMIT',
        message: 'limit must be an integer between 1 and 100',
      });
    }
    if (cursor !== undefined && cursor.length > 512) {
      throw new BadRequestException({
        code: 'INVALID_CURSOR',
        message: 'cursor is invalid',
      });
    }
    return this.wageringService.getLedger(
      identifier(walletId, 'walletId', 64),
      cursor,
      limit,
    );
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(
    @Param('walletId') walletId: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    validateCorrelationId(correlationId);
    return this.wageringService.reconcileWallet(
      identifier(walletId, 'walletId', 64),
    );
  }
}

@Controller('wagering/transactions')
export class WageringTransactionsController {
  constructor(private readonly wageringService: WageringService) {}

  @Post()
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (
      typeof idempotencyKey !== 'string' ||
      idempotencyKey.trim().length === 0 ||
      idempotencyKey.length > 256
    ) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'A non-empty Idempotency-Key of at most 256 characters is required',
      });
    }
    const validatedCorrelationId = validateCorrelationId(correlationId);
    const result = await this.wageringService.submitWager(
      parseSubmitWagerRequest(body),
      idempotencyKey,
      validatedCorrelationId,
    );
    response.status(result.httpStatus);
    return result.body;
  }

  @Get(':transactionId')
  get(@Param('transactionId') transactionId: string) {
    return this.wageringService.getTransaction(
      identifier(transactionId, 'transactionId', 64),
    );
  }
}

@Controller('providers/:providerId/wagering/transactions')
export class ProviderWageringTransactionsController {
  constructor(private readonly wageringService: WageringService) {}

  @Get(':externalTransactionId')
  get(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return this.wageringService.getProviderTransaction(
      identifier(providerId, 'providerId', 128),
      identifier(externalTransactionId, 'externalTransactionId', 256),
    );
  }
}

function identifier(
  value: string,
  fieldName: string,
  maxLength: number,
): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > maxLength
  ) {
    throw new BadRequestException({
      code: 'INVALID_IDENTIFIER',
      message: `${fieldName} must be a non-empty string of at most ${maxLength} characters`,
    });
  }
  return value;
}

function validateCorrelationId(value: string | undefined): string {
  if (value === undefined) {
    return randomUUID();
  }
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new BadRequestException({
      code: 'INVALID_CORRELATION_ID',
      message: 'X-Correlation-Id contains invalid characters or length',
    });
  }
  return value;
}
