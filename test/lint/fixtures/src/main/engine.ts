import type { Message } from '../protocol/messages.js';

export function createEngine(): Worker {
  return new Worker(new URL('../worker/index.js', import.meta.url), { type: 'module' });
}

export function post(worker: Worker, message: Message): void {
  worker.postMessage(message);
}
