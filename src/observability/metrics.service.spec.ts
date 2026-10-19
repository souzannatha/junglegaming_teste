import { MetricsService } from './metrics.service.js';

describe('MetricsService', () => {
  it('exports request, worker, and reconciliation metrics in Prometheus format', () => {
    const metrics = new MetricsService();
    metrics.startHttpRequest('POST', '/wagering/transactions');
    metrics.finishHttpRequest('POST', '/wagering/transactions', 200, 0.125);
    metrics.record('wagering_sqs_messages_total', 'processed');
    metrics.record('wagering_outbox_events_total', 'failed');
    metrics.record('wagering_wallet_reconciliations_total', 'consistent');

    const output = metrics.renderPrometheus();
    expect(output).toContain('# TYPE wagering_http_requests_total counter');
    expect(output).toContain(
      'wagering_http_requests_total{method="POST",route="/wagering/transactions",status="200"} 1',
    );
    expect(output).toContain(
      'wagering_http_request_duration_seconds_sum{method="POST",route="/wagering/transactions",status="200"} 0.125',
    );
    expect(output).toContain(
      'wagering_sqs_messages_total{outcome="processed"} 1',
    );
    expect(output).toContain(
      'wagering_outbox_events_total{outcome="failed"} 1',
    );
    expect(output).toContain(
      'wagering_wallet_reconciliations_total{outcome="consistent"} 1',
    );
    expect(output).not.toContain('amount');
    expect(output).not.toContain('wallet-id');
  });
});
