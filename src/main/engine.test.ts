import { describe, expect, it } from 'vitest';
import { createEngine } from './engine.js';
import { StateChangeEvent } from './events.js';

describe('createEngine', () => {
  it('沒有選項也能建立，Engine 是 EventTarget', () => {
    expect(createEngine()).toBeInstanceOf(EventTarget);
  });

  it('事件以帶型別的 listener 收到', () => {
    const engine = createEngine();
    const received: StateChangeEvent[] = [];
    engine.addEventListener('statechange', (event) => received.push(event));

    const event = new StateChangeEvent({
      state: 'idle',
      previous: 'idle',
      paused: true,
      reason: 'command',
    });
    engine.dispatchEvent(event);

    expect(received).toEqual([event]);
  });

  it('選項超出範圍時丟 RangeError', () => {
    expect(() => createEngine({ audioFadeMs: 101 })).toThrow(RangeError);
    expect(() =>
      createEngine({ audioBuffer: { targetMs: 300, refillMs: 400, capacityMs: 500 } }),
    ).toThrow(RangeError);
  });

  it('依平台補上 audioBuffer 後才檢查順序', () => {
    // Node 的 navigator 沒有觸控點，視為桌面（refill 75、capacity 400）。
    expect(() => createEngine({ audioBuffer: { targetMs: 100 } })).not.toThrow();
    expect(() => createEngine({ audioBuffer: { targetMs: 500 } })).toThrow(RangeError);
  });

  it('尚未實作的成員丟出錯誤並指出成員名稱', () => {
    const engine = createEngine();

    expect(() => engine.videoSize).toThrow(/videoSize/);
  });
});
