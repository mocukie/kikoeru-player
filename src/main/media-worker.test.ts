// 真實 media Worker 的 adapter（createWebMediaWorker）：以假的全域 Worker 驅動，確認 terminate 之後的行為。

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerToMainMessage } from '../protocol/index.js';
import type { MainHost } from './deps.js';
import { createWebMediaWorker } from './media-worker.js';

/** 假的 Worker：記錄 terminate，測試以 `dispatch()` 模擬瀏覽器派送訊息與錯誤。 */
class FakeWorker {
  static last: FakeWorker | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { preventDefault(): void }) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  terminated = false;
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(): void {
    // 不需要。
  }
  terminate(): void {
    this.terminated = true;
  }
}

function setup() {
  vi.stubGlobal('Worker', FakeWorker);
  const handlers = { message: vi.fn(), crash: vi.fn() };
  const adapter = createWebMediaWorker(handlers);
  const fake = FakeWorker.last;
  if (!fake) throw new Error('沒有建立 Worker');
  return { handlers, adapter, fake };
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWorker.last = null;
});

describe('createWebMediaWorker', () => {
  it('terminate 之後瀏覽器仍派送的訊息（例如在途中的 frame）照樣交給 handler，讓 Engine close 它', () => {
    const { handlers, adapter, fake } = setup();
    adapter.terminate();
    expect(fake.terminated).toBe(true);
    const frame = { close: vi.fn() } as unknown as VideoFrame;
    const message: WorkerToMainMessage<MainHost> = { type: 'frame', epoch: 1, frame };
    fake.onmessage?.({ data: message });
    expect(handlers.message).toHaveBeenCalledWith(message);
  });

  it('terminate 之後的 error、messageerror 不再回報崩潰', () => {
    const { handlers, adapter, fake } = setup();
    adapter.terminate();
    fake.onerror?.({ preventDefault: () => undefined });
    fake.onmessageerror?.({});
    expect(handlers.crash).not.toHaveBeenCalled();
  });
});
