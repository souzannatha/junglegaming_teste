import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  CurrencyMismatchError,
  IdempotencyConflictError,
  InvalidLedgerEntryError,
  InvalidMoneyError,
  InvalidTransactionStateError,
  InvalidWalletOperationError,
  InvalidWagerTransactionError,
  WagerRuleViolationError,
} from '../domain/errors/domain.error.js';

interface PostgresLikeError {
  code?: unknown;
}

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status = this.statusFor(exception);
    const body = this.bodyFor(exception, status);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        JSON.stringify({
          event: 'request_failed',
          errorType:
            exception instanceof Error ? exception.name : 'UnknownError',
        }),
      );
    }

    response.status(status).json(body);
  }

  private statusFor(exception: unknown): number {
    if (exception instanceof HttpException) {
      return exception.getStatus();
    }
    if (exception instanceof IdempotencyConflictError) {
      return HttpStatus.CONFLICT;
    }
    if (
      exception instanceof InvalidMoneyError ||
      exception instanceof CurrencyMismatchError ||
      exception instanceof InvalidLedgerEntryError ||
      exception instanceof InvalidTransactionStateError ||
      exception instanceof InvalidWalletOperationError ||
      exception instanceof InvalidWagerTransactionError
    ) {
      return HttpStatus.BAD_REQUEST;
    }
    if (exception instanceof WagerRuleViolationError) {
      return HttpStatus.UNPROCESSABLE_ENTITY;
    }

    if (!isPostgresError(exception)) {
      return HttpStatus.INTERNAL_SERVER_ERROR;
    }
    if (exception.code === '23505') {
      return HttpStatus.CONFLICT;
    }
    if (exception.code === '23503') {
      return HttpStatus.NOT_FOUND;
    }
    if (exception.code === '23514' || exception.code === 'P0001') {
      return HttpStatus.UNPROCESSABLE_ENTITY;
    }

    return HttpStatus.INTERNAL_SERVER_ERROR;
  }

  private bodyFor(exception: unknown, status: number): Record<string, unknown> {
    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      if (typeof response === 'string') {
        return { code: 'HTTP_ERROR', message: response };
      }
      return response as Record<string, unknown>;
    }
    if (exception instanceof IdempotencyConflictError) {
      return { code: exception.code, message: exception.message };
    }
    if (
      exception instanceof InvalidMoneyError ||
      exception instanceof CurrencyMismatchError ||
      exception instanceof InvalidLedgerEntryError ||
      exception instanceof InvalidTransactionStateError ||
      exception instanceof InvalidWalletOperationError ||
      exception instanceof InvalidWagerTransactionError
    ) {
      return { code: exception.code, message: exception.message };
    }
    if (exception instanceof WagerRuleViolationError) {
      return { code: exception.code, message: exception.message };
    }

    if (!isPostgresError(exception)) {
      return {
        code: status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR',
        message:
          status >= 500
            ? 'An unexpected error occurred'
            : 'The request could not be processed',
      };
    }
    if (exception.code === '23505') {
      return {
        code: 'RESOURCE_CONFLICT',
        message: 'The request conflicts with an existing resource',
      };
    }
    if (exception.code === '23503') {
      return {
        code: 'REFERENCE_NOT_FOUND',
        message: 'A referenced resource was not found',
      };
    }
    if (exception.code === '23514' || exception.code === 'P0001') {
      return {
        code: 'BUSINESS_RULE_VIOLATION',
        message: 'The operation violates a financial consistency rule',
      };
    }

    return {
      code: status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR',
      message:
        status >= 500
          ? 'An unexpected error occurred'
          : 'The request could not be processed',
    };
  }
}

function isPostgresError(exception: unknown): exception is PostgresLikeError {
  return typeof exception === 'object' && exception !== null;
}
