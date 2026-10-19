import {
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import { MetricsService } from './metrics.service.js';
import { WorkerHealthService } from './worker-health.service.js';

@Injectable()
export class ReadinessService {
  private readonly logger = new Logger(ReadinessService.name);

  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    private readonly workerHealth: WorkerHealthService,
  ) {}

  async check(): Promise<{
    status: 'ok';
    checks: {
      database: 'up';
      workers: Record<
        string,
        'starting' | 'ready' | 'unavailable' | 'disabled'
      >;
    };
  }> {
    try {
      await this.orm.em.getConnection().execute('select 1', [], 'all');
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'readiness_check_failed',
          dependency: 'postgresql',
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
      throw new ServiceUnavailableException({
        status: 'unavailable',
        checks: { database: 'down' },
      });
    }

    const workers = this.workerHealth.snapshot();
    const workersReady = Object.values(workers).every(
      (state) => state === 'ready' || state === 'disabled',
    );
    if (!workersReady) {
      throw new ServiceUnavailableException({
        status: 'unavailable',
        checks: { database: 'up', workers },
      });
    }
    return { status: 'ok', checks: { database: 'up', workers } };
  }
}

@Controller('health')
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get('live')
  @HttpCode(HttpStatus.OK)
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @HttpCode(HttpStatus.OK)
  ready() {
    return this.readiness.check();
  }
}

@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(): string {
    return this.metrics.renderPrometheus();
  }
}
