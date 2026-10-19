import { Injectable } from '@nestjs/common';

type WageringMetric =
  | 'wagering_outbox_events_total'
  | 'wagering_reference_retries_total'
  | 'wagering_sqs_messages_total'
  | 'wagering_wallet_reconciliations_total';

interface MetricFamily {
  name: string;
  help: string;
  type: 'counter' | 'gauge' | 'summary';
}

const METRIC_FAMILIES: MetricFamily[] = [
  {
    name: 'wagering_http_requests_total',
    help: 'Completed HTTP requests by method, route template, and status.',
    type: 'counter',
  },
  {
    name: 'wagering_http_request_duration_seconds',
    help: 'Cumulative duration of completed HTTP requests in seconds.',
    type: 'summary',
  },
  {
    name: 'wagering_http_requests_in_flight',
    help: 'Number of HTTP requests currently being handled.',
    type: 'gauge',
  },
  {
    name: 'wagering_outbox_events_total',
    help: 'Outbox publish attempts by outcome.',
    type: 'counter',
  },
  {
    name: 'wagering_reference_retries_total',
    help: 'Reference retry outcomes.',
    type: 'counter',
  },
  {
    name: 'wagering_sqs_messages_total',
    help: 'Wagering SQS message outcomes.',
    type: 'counter',
  },
  {
    name: 'wagering_wallet_reconciliations_total',
    help: 'Wallet reconciliation outcomes.',
    type: 'counter',
  },
];

@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, number>();
  private readonly requestDurationSeconds = new Map<string, number>();
  private readonly inFlightByRoute = new Map<string, number>();

  startHttpRequest(method: string, route: string): void {
    const key = labelsKey({ method, route });
    this.inFlightByRoute.set(key, (this.inFlightByRoute.get(key) ?? 0) + 1);
  }

  finishHttpRequest(
    method: string,
    route: string,
    status: number,
    durationSeconds: number,
  ): void {
    const requestLabels = { method, route, status: String(status) };
    increment(
      this.counters,
      labelsKey(requestLabels, 'wagering_http_requests_total'),
    );
    this.requestDurationSeconds.set(
      labelsKey(requestLabels),
      (this.requestDurationSeconds.get(labelsKey(requestLabels)) ?? 0) +
        durationSeconds,
    );

    const routeKey = labelsKey({ method, route });
    const inFlight = (this.inFlightByRoute.get(routeKey) ?? 1) - 1;
    if (inFlight <= 0) {
      this.inFlightByRoute.delete(routeKey);
    } else {
      this.inFlightByRoute.set(routeKey, inFlight);
    }
  }

  record(name: WageringMetric, outcome: string): void {
    increment(this.counters, labelsKey({ outcome }, name));
  }

  renderPrometheus(): string {
    const lines: string[] = [];
    for (const family of METRIC_FAMILIES) {
      lines.push(`# HELP ${family.name} ${family.help}`);
      lines.push(`# TYPE ${family.name} ${family.type}`);

      if (family.name === 'wagering_http_requests_total') {
        appendMetricSamples(lines, family.name, this.counters, (key) =>
          key.startsWith(`${family.name}|`),
        );
      } else if (family.name === 'wagering_http_request_duration_seconds') {
        appendMetricSamples(
          lines,
          `${family.name}_sum`,
          this.requestDurationSeconds,
        );
        appendMetricSamples(
          lines,
          `${family.name}_count`,
          this.counters,
          (key) => key.startsWith('wagering_http_requests_total|'),
        );
      } else if (family.name === 'wagering_http_requests_in_flight') {
        appendMetricSamples(lines, family.name, this.inFlightByRoute);
      } else {
        appendMetricSamples(lines, family.name, this.counters, (key) =>
          key.startsWith(`${family.name}|`),
        );
      }
    }
    return `${lines.join('\n')}\n`;
  }
}

function increment(values: Map<string, number>, key: string, amount = 1): void {
  values.set(key, (values.get(key) ?? 0) + amount);
}

function labelsKey(labels: Record<string, string>, prefix = ''): string {
  const serialized = Object.fromEntries(
    Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)),
  );
  return `${prefix}|${JSON.stringify(serialized)}`;
}

function escapeLabel(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n');
}

function appendMetricSamples(
  lines: string[],
  metricName: string,
  values: Map<string, number>,
  filter: (key: string) => boolean = () => true,
): void {
  for (const [key, value] of values) {
    if (!filter(key)) {
      continue;
    }
    const separator = key.indexOf('|');
    const labels = JSON.parse(key.slice(separator + 1)) as Record<
      string,
      string
    >;
    const labelString = Object.entries(labels)
      .map(([name, label]) => `${name}="${escapeLabel(label)}"`)
      .join(',');
    lines.push(
      `${metricName}${labelString ? `{${labelString}}` : ''} ${value}`,
    );
  }
}
