// log 的時基換算：media Worker 的 timeOrigin 時間與 worklet 的 context frame 換算成主執行緒的 performance.now()。

import { describe, expect, it } from 'vitest';
import { fromContextFrame, fromWorkerTime } from './log.js';

describe('fromWorkerTime', () => {
  it('減去主執行緒的 timeOrigin', () => {
    // Worker 比主執行緒晚 300 ms 建立：它的 performance.now() = 100 對應主執行緒的 400。
    expect(fromWorkerTime(1_700_000_000_300 + 100, 1_700_000_000_000)).toBe(400);
  });
});

describe('fromContextFrame', () => {
  it('以此刻的 currentTime 與 performance.now() 對齊，往回推 frame 之後經過的時間', () => {
    // context 已經 render 到 10.5 秒；log 在 10 秒的 quantum 發生，那是 500 ms 之前。
    expect(
      fromContextFrame({ frame: 480_000, sampleRate: 48_000, currentTime: 10.5, now: 2000 }),
    ).toBe(1500);
  });

  it('frame 比 currentTime 新（主執行緒的 currentTime 還沒更新）時不超過此刻', () => {
    expect(fromContextFrame({ frame: 48_128, sampleRate: 48_000, currentTime: 1, now: 2000 })).toBe(
      2000,
    );
  });
});
