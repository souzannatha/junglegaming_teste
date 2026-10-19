import { createHash } from 'node:crypto';
import type { SubmitWagerRequest } from './wagering.contracts.js';

export function hashWagerPayload(payload: SubmitWagerRequest): string {
  const canonical = canonicalize({
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: payload.money.toJSON(),
    referenceExternalTransactionId:
      payload.referenceExternalTransactionId ?? null,
  });

  return createHash('sha256').update(canonical).digest('hex');
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const properties = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
  return `{${properties.join(',')}}`;
}
