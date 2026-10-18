// 「此刻聽到的 context 時間」的換算與 fallback 順序（ADR-0004）：getOutputTimestamp() → outputLatency → baseLatency。

import { describe, expect, it } from 'vitest';
import { heardContextTime } from './latency.js';

describe('heardContextTime', () => {
  it('以 getOutputTimestamp() 為主，加上 timestamp 之後經過的時間', () => {
    const heard = heardContextTime({
      currentTime: 2,
      now: 10_030,
      timestamp: { contextTime: 1.9, performanceTime: 10_000 },
      outputLatency: 0.5,
      baseLatency: 0.01,
    });
    expect(heard).toBeCloseTo(1.93, 9);
  });

  it('不超過 currentTime（context 停住時不往前推）', () => {
    const heard = heardContextTime({
      currentTime: 2,
      now: 20_000,
      timestamp: { contextTime: 1.9, performanceTime: 10_000 },
    });
    expect(heard).toBe(2);
  });

  it('getOutputTimestamp() 回傳 0 時用 currentTime − outputLatency', () => {
    const heard = heardContextTime({
      currentTime: 2,
      now: 10_000,
      timestamp: { contextTime: 0, performanceTime: 0 },
      outputLatency: 0.04,
      baseLatency: 0.01,
    });
    expect(heard).toBeCloseTo(1.96, 9);
  });

  it('不支援 getOutputTimestamp() 時用 currentTime − outputLatency', () => {
    const heard = heardContextTime({ currentTime: 2, now: 0, outputLatency: 0.04 });
    expect(heard).toBeCloseTo(1.96, 9);
  });

  it('outputLatency 不支援或為 0 時用 currentTime − baseLatency', () => {
    expect(heardContextTime({ currentTime: 2, now: 0, baseLatency: 0.01 })).toBeCloseTo(1.99, 9);
    expect(
      heardContextTime({ currentTime: 2, now: 0, outputLatency: 0, baseLatency: 0.01 }),
    ).toBeCloseTo(1.99, 9);
  });

  it('都沒有時就是 currentTime', () => {
    expect(heardContextTime({ currentTime: 2, now: 0 })).toBe(2);
  });

  it('不低於 0', () => {
    expect(heardContextTime({ currentTime: 0.01, now: 0, outputLatency: 0.04 })).toBe(0);
  });

  it('context 還沒開始（currentTime 為 0）時為 null', () => {
    expect(heardContextTime({ currentTime: 0, now: 0, outputLatency: 0.04 })).toBeNull();
  });
});
