import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { httpMetricsMiddleware } from '../src/observability/http-metrics.js';
import { MetricsService } from '../src/observability/metrics.service.js';

process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
process.env.WAGERING_SQS_CONSUMER_ENABLED = 'false';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use(httpMetricsMiddleware(app.get(MetricsService)));
    await app.init();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  it('exposes liveness, database readiness, and Prometheus metrics without payload data', async () => {
    await request(app.getHttpServer()).get('/').expect(200);

    await request(app.getHttpServer())
      .get('/health/live')
      .expect(200)
      .expect({ status: 'ok' });

    await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200)
      .expect({
        status: 'ok',
        checks: {
          database: 'up',
          workers: {
            'outbox-publisher': 'disabled',
            'wagering-sqs-consumer': 'disabled',
          },
        },
      });

    const metrics = await request(app.getHttpServer())
      .get('/metrics')
      .expect(200);
    expect(metrics.headers['content-type']).toContain('text/plain');
    expect(metrics.text).toContain(
      '# TYPE wagering_http_requests_total counter',
    );
    expect(metrics.text).toMatch(
      /wagering_http_requests_total\{method="GET",route="\/",status="200"\} [1-9]\d*/,
    );
    expect(metrics.text).not.toContain('wagering_http_requests_in_flight{');
    expect(metrics.text).not.toContain('100.00');
    expect(metrics.text).not.toContain('playerId');
  });

  afterEach(async () => {
    await app.close();
  });
});
