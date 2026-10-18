// media Worker 的 log：送出端的等級過濾、沒有 hook（logLevel null）時不送，time 以 timeOrigin 為基準。

import { describe, expect, it } from 'vitest';
import type { WorkerToMainMessage } from '../protocol/index.js';
import { createWorkerLogger } from './log.js';

function sink() {
  const posted: WorkerToMainMessage[] = [];
  return { posted, post: (m: WorkerToMainMessage) => posted.push(m) };
}

describe('createWorkerLogger', () => {
  it('低於 logLevel 的不送出；time 是 timeOrigin 加上 performance.now()', () => {
    const { posted, post } = sink();
    const log = createWorkerLogger('info', post, () => 1_700_000_000_123.5);
    log.log('debug', 'io', '不送');
    log.log('info', 'io', 'Range 請求', { start: 0, end: 99 });
    log.log('error', 'worker', '崩潰');
    expect(posted).toEqual([
      {
        type: 'log',
        entry: {
          level: 'info',
          scope: 'io',
          message: 'Range 請求',
          time: 1_700_000_000_123.5,
          data: { start: 0, end: 99 },
        },
      },
      {
        type: 'log',
        entry: { level: 'error', scope: 'worker', message: '崩潰', time: 1_700_000_000_123.5 },
      },
    ]);
  });

  it('logLevel 為 null（App 沒有設定 hook）時什麼都不送', () => {
    const { posted, post } = sink();
    const log = createWorkerLogger(null, post);
    log.log('error', 'worker', 'x');
    expect(log.enabled('error')).toBe(false);
    expect(posted).toEqual([]);
  });

  it('預設的時間取 performance.timeOrigin + performance.now()', () => {
    const { posted, post } = sink();
    const before = performance.timeOrigin + performance.now();
    createWorkerLogger('debug', post).log('debug', 'demux', 'x');
    const after = performance.timeOrigin + performance.now();
    const time = posted[0]?.type === 'log' ? posted[0].entry.time : NaN;
    expect(time).toBeGreaterThanOrEqual(before);
    expect(time).toBeLessThanOrEqual(after);
  });
});
