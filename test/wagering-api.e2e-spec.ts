import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { App } from 'supertest/types.js';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';

describe('Wagering HTTP API (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('persists wallets, references, idempotent snapshots, ledger, and reconciliation', async () => {
    const playerId = `api-player-${crypto.randomUUID()}`;
    const walletResponse = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      })
      .expect(201);
    const walletId = walletResponse.body.id as string;

    expect(walletResponse.body.balance).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    expect(walletResponse.body.version).toBe(1);

    const betPayload = {
      providerId: 'provider-e2e',
      externalTransactionId: `bet-${crypto.randomUUID()}`,
      playerId,
      walletId,
      roundId: 'round-api',
      gameId: 'game-api',
      kind: 'BET',
      money: { amount: '80.00', currency: 'BRL' },
    };
    const betIdempotencyKey = `idem-${crypto.randomUUID()}`;
    const bet = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', betIdempotencyKey)
      .send(betPayload)
      .expect(200);

    expect(bet.body.status).toBe('PROCESSED');
    expect(bet.body.balance).toEqual({ amount: '20.00', currency: 'BRL' });
    expect(bet.body.walletVersion).toBe(2);

    const replay = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', betIdempotencyKey)
      .send(betPayload)
      .expect(200);
    expect(replay.body.id).toBe(bet.body.id);
    expect(replay.body.balance).toEqual(bet.body.balance);
    expect(replay.body.walletVersion).toBe(bet.body.walletVersion);
    expect(replay.body.idempotentReplay).toBe(true);

    const idempotencyKey = `idem-replay-${crypto.randomUUID()}`;
    const rejectedPayload = {
      ...betPayload,
      externalTransactionId: `bet-rejected-${crypto.randomUUID()}`,
      money: { amount: '25.00', currency: 'BRL' },
    };
    const replayFirstResponse = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', idempotencyKey)
      .send(rejectedPayload)
      .expect(422);
    const replayedResponse = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', idempotencyKey)
      .send(rejectedPayload)
      .expect(422);
    expect(replayedResponse.body.id).toBe(replayFirstResponse.body.id);
    expect(replayedResponse.body.balance).toEqual(
      replayFirstResponse.body.balance,
    );
    expect(replayedResponse.body.walletVersion).toBe(
      replayFirstResponse.body.walletVersion,
    );
    expect(replayedResponse.body.idempotentReplay).toBe(true);

    const conflict = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', idempotencyKey)
      .send({
        ...rejectedPayload,
        money: { amount: '26.00', currency: 'BRL' },
      })
      .expect(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');

    const winPayload = {
      ...betPayload,
      externalTransactionId: `win-${crypto.randomUUID()}`,
      kind: 'WIN',
      money: { amount: '50.00', currency: 'BRL' },
      referenceExternalTransactionId: betPayload.externalTransactionId,
    };
    const win = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `idem-${crypto.randomUUID()}`)
      .send(winPayload)
      .expect(200);
    expect(win.body.balance).toEqual({ amount: '70.00', currency: 'BRL' });
    expect(win.body.walletVersion).toBe(3);

    const refundPayload = {
      ...betPayload,
      externalTransactionId: `refund-${crypto.randomUUID()}`,
      kind: 'REFUND',
      money: betPayload.money,
      referenceExternalTransactionId: betPayload.externalTransactionId,
    };
    const refund = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `idem-${crypto.randomUUID()}`)
      .send(refundPayload)
      .expect(200);
    expect(refund.body.balance).toEqual({ amount: '150.00', currency: 'BRL' });

    const duplicateRefund = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `idem-${crypto.randomUUID()}`)
      .send({
        ...refundPayload,
        externalTransactionId: `refund-duplicate-${crypto.randomUUID()}`,
      })
      .expect(422);
    expect(duplicateRefund.body.failureCode).toBe(
      'REFERENCE_ALREADY_REVERSED',
    );

    const delayedBetReplay = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', betIdempotencyKey)
      .send(betPayload)
      .expect(200);
    expect(delayedBetReplay.body.balance).toEqual({
      amount: '20.00',
      currency: 'BRL',
    });
    expect(delayedBetReplay.body.walletVersion).toBe(2);

    const transaction = await request(app.getHttpServer())
      .get(`/wagering/transactions/${win.body.id}`)
      .expect(200);
    expect(transaction.body.status).toBe('PROCESSED');

    const lookup = await request(app.getHttpServer())
      .get(
        `/providers/${betPayload.providerId}/wagering/transactions/${betPayload.externalTransactionId}`,
      )
      .expect(200);
    expect(lookup.body.id).toBe(bet.body.id);

    const wallet = await request(app.getHttpServer())
      .get(`/wallets/${walletId}`)
      .expect(200);
    expect(wallet.body.balance).toEqual({ amount: '150.00', currency: 'BRL' });

    const ledger = await request(app.getHttpServer())
      .get(`/wallets/${walletId}/ledger?limit=2`)
      .expect(200);
    expect(ledger.body.items).toHaveLength(2);
    expect(ledger.body.nextCursor).toEqual(expect.any(String));
    const nextPage = await request(app.getHttpServer())
      .get(
        `/wallets/${walletId}/ledger?limit=2&cursor=${encodeURIComponent(ledger.body.nextCursor as string)}`,
      )
      .expect(200);
    expect(nextPage.body.items).toHaveLength(2);
    expect(nextPage.body.nextCursor).toBeNull();

    const reconciliation = await request(app.getHttpServer())
      .post(`/wallets/${walletId}/reconciliation`)
      .expect(200);
    expect(reconciliation.body.consistent).toBe(true);
    expect(reconciliation.body.ledgerBalance).toEqual({
      amount: '150.00',
      currency: 'BRL',
    });
  });

  it('serializes concurrent debits so the balance never becomes negative', async () => {
    const playerId = `api-race-${crypto.randomUUID()}`;
    const wallet = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      })
      .expect(201);
    const makeBet = (suffix: string) =>
      request(app.getHttpServer())
        .post('/wagering/transactions')
        .set('Idempotency-Key', `race-${suffix}-${crypto.randomUUID()}`)
        .send({
          providerId: 'provider-race',
          externalTransactionId: `race-tx-${suffix}-${crypto.randomUUID()}`,
          playerId,
          walletId: wallet.body.id,
          roundId: 'round-race',
          gameId: 'game-race',
          kind: 'BET',
          money: { amount: '80.00', currency: 'BRL' },
        });

    const responses = await Promise.all([makeBet('a'), makeBet('b')]);
    expect(
      responses.map(({ status }) => status).sort((left, right) => left - right),
    ).toEqual([200, 422]);
    expect(
      responses.find(({ status }) => status === 422)?.body.failureCode,
    ).toBe('INSUFFICIENT_FUNDS');

    const balance = await request(app.getHttpServer())
      .get(`/wallets/${wallet.body.id}`)
      .expect(200);
    expect(balance.body.balance).toEqual({ amount: '20.00', currency: 'BRL' });
    expect(balance.body.version).toBe(2);

    const reconciliation = await request(app.getHttpServer())
      .post(`/wallets/${wallet.body.id}/reconciliation`)
      .expect(200);
    expect(reconciliation.body.consistent).toBe(true);
  });

  it('returns pending-reference status and requires an idempotency key', async () => {
    const playerId = `api-pending-${crypto.randomUUID()}`;
    const wallet = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId,
        initialBalance: { amount: '0.00', currency: 'BRL' },
      })
      .expect(201);
    const payload = {
      providerId: 'provider-pending',
      externalTransactionId: `win-${crypto.randomUUID()}`,
      playerId,
      walletId: wallet.body.id as string,
      roundId: 'round-pending',
      gameId: 'game-pending',
      kind: 'WIN',
      money: { amount: '2.50', currency: 'BRL' },
      referenceExternalTransactionId: 'bet-not-arrived',
    };
    const response = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `pending-${crypto.randomUUID()}`)
      .send(payload)
      .expect(202);

    expect(response.body.status).toBe('PENDING_REFERENCE');
    expect(response.body.balance).toEqual({ amount: '0.00', currency: 'BRL' });

    const missingKey = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .send(payload)
      .expect(400);
    expect(missingKey.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});
