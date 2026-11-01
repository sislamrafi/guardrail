// A small in-process event bus: every change made through the admin API (by a person or the agent)
// is announced, and open consoles listen at /api/admin/events to refresh what they show.
import { EventEmitter } from 'events';

export interface ChangeEvent {
  /** "agent" when the console agent made the change. */
  source: 'console' | 'agent';
  method: string;
  path: string;
  at: number;
}

const g = globalThis as unknown as { __grBus?: EventEmitter };
const bus = (g.__grBus ??= Object.assign(new EventEmitter(), {}).setMaxListeners(200));

export function publish(e: Omit<ChangeEvent, 'at'>) {
  bus.emit('change', { ...e, at: Date.now() });
}

export function subscribe(fn: (e: ChangeEvent) => void): () => void {
  bus.on('change', fn);
  return () => bus.off('change', fn);
}
