import { EventEmitter } from 'node:events';
import type { RunEvent } from '@agentproof/shared';

/**
 * In-process pub/sub for run progress. The SSE route subscribes per run id;
 * the job executor publishes. Polling GET /runs/:id works too because every
 * event is also persisted onto the Run document.
 */
const bus = new EventEmitter();
bus.setMaxListeners(100);

export function publish(event: RunEvent): void {
  bus.emit(event.runId, event);
}

export function subscribe(runId: string, listener: (e: RunEvent) => void): () => void {
  bus.on(runId, listener);
  return () => bus.off(runId, listener);
}
