import { Injectable } from '@nestjs/common';

export type WorkerName = 'outbox-publisher' | 'wagering-sqs-consumer';
export type WorkerState = 'starting' | 'ready' | 'unavailable' | 'disabled';

@Injectable()
export class WorkerHealthService {
  private readonly workers = new Map<WorkerName, WorkerState>();

  setState(worker: WorkerName, state: WorkerState): void {
    this.workers.set(worker, state);
  }

  snapshot(): Record<WorkerName, WorkerState> {
    return {
      'outbox-publisher': this.workers.get('outbox-publisher') ?? 'starting',
      'wagering-sqs-consumer':
        this.workers.get('wagering-sqs-consumer') ?? 'starting',
    };
  }
}
