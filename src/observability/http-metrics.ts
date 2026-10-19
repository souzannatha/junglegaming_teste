import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { MetricsService } from './metrics.service.js';

const logger = new Logger('HttpMetrics');

export function httpMetricsMiddleware(
  metrics: MetricsService,
): (request: Request, response: Response, next: NextFunction) => void {
  return (request, response, next) => {
    const method = normalizeMethod(request.method);
    const route = routeTemplate(request.originalUrl.split('?', 1)[0] ?? '/');
    if (
      route === '/metrics' ||
      route === '/health/live' ||
      route === '/health/ready'
    ) {
      next();
      return;
    }

    const startedAt = process.hrtime.bigint();
    metrics.startHttpRequest(method, route);
    response.once('finish', () => {
      const durationSeconds =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      metrics.finishHttpRequest(method, route, response.statusCode, durationSeconds);
      logger.log(
        JSON.stringify({
          event: 'http_request_completed',
          method,
          route,
          status: response.statusCode,
          durationSeconds: Number(durationSeconds.toFixed(6)),
        }),
      );
    });
    next();
  };
}

function normalizeMethod(method: string): string {
  const normalized = method.toUpperCase();
  return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].includes(
    normalized,
  )
    ? normalized
    : 'OTHER';
}

function routeTemplate(path: string): string {
  if (path === '/') {
    return path;
  }
  if (
    path === '/metrics' ||
    path === '/health/live' ||
    path === '/health/ready'
  ) {
    return path;
  }
  if (/^\/wallets\/[^/]+\/ledger$/.test(path)) {
    return '/wallets/:walletId/ledger';
  }
  if (/^\/wallets\/[^/]+\/reconciliation$/.test(path)) {
    return '/wallets/:walletId/reconciliation';
  }
  if (/^\/wallets\/[^/]+$/.test(path)) {
    return '/wallets/:walletId';
  }
  if (/^\/wagering\/transactions\/[^/]+$/.test(path)) {
    return '/wagering/transactions/:transactionId';
  }
  if (/^\/providers\/[^/]+\/wagering\/transactions\/[^/]+$/.test(path)) {
    return '/providers/:providerId/wagering/transactions/:externalTransactionId';
  }
  if (path === '/wallets' || path === '/wagering/transactions') {
    return path;
  }
  return 'unmatched';
}
