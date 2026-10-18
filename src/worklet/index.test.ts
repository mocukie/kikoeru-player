// AudioWorklet 的 ring buffer、水位與音訊時鐘：以協定訊息與 render() 驅動 OutputCore，不需要 AudioWorkletGlobalScope。

import { describe, expect, it } from 'vitest';
import type {
  MainToWorkletMessage,
  WorkerToWorkletMessage,
  WorkletToMainMessage,
  WorkletToWorkerMessage,
} from '../protocol/index.js';
import { framesToRequest, OutputCore, PcmRing, type PcmTransport } from './index.js';

// 取樣率 1000 Hz：1 frame = 1 ms，水位直接以 frame 表示。
const sampleRate = 1000;
const audioBuffer = { targetMs: 150, refillMs: 75, capacityMs: 400 };
/** 測試用的 render quantum；OutputCore 依輸出的長度處理，不限 128。 */
const quantum = 10;

class FakeTransport implements PcmTransport {
  readonly sent: WorkletToWorkerMessage[] = [];
  closed = false;
  #onMessage: ((message: WorkerToWorkletMessage) => void) | null = null;

  post(message: WorkletToWorkerMessage): void {
    this.sent.push(message);
  }
  listen(onMessage: (message: WorkerToWorkletMessage) => void): void {
    this.#onMessage = onMessage;
  }
  close(): void {
    this.closed = true;
  }

  /** 以 Worker 的身分送出。 */
  deliver(message: WorkerToWorkletMessage): void {
    this.#onMessage?.(message);
  }

  /** 送出一段 PCM：左聲道是 `values`，右聲道是它的相反數。 */
  pcm(epoch: number, time: number, values: number[]): void {
    this.deliver({
      type: 'pcm',
      epoch,
      time,
      channels: [Float32Array.from(values), Float32Array.from(values, (v) => -v)],
    });
  }

  /** 累計要求的 frame 數（只算指定 epoch）。 */
  requested(epoch: number): number {
    return this.sent
      .filter((m) => m.type === 'need' && m.epoch === epoch)
      .reduce((sum, m) => sum + (m.type === 'need' ? m.frames : 0), 0);
  }

  released(): ArrayBuffer[] {
    return this.sent.flatMap((m) => (m.type === 'release' ? m.buffers : []));
  }
}

/** 連續的 1, 2, 3, … 共 `count` 個，從 `from` 開始。 */
function ramp(count: number, from = 1): number[] {
  return Array.from({ length: count }, (_, i) => from + i);
}

function silence(count: number): number[] {
  return Array<number>(count).fill(0);
}

function setup() {
  const reports: WorkletToMainMessage[] = [];
  const core = new OutputCore({ sampleRate, audioBuffer, report: (m) => reports.push(m) });
  const worker = new FakeTransport();
  core.connect(worker);
  let frame = 0;
  /** render 一個 quantum，回傳左聲道。 */
  const render = (): number[] => {
    const output = [new Float32Array(quantum), new Float32Array(quantum)];
    core.render(output, frame);
    frame += quantum;
    return [...(output[0] ?? [])];
  };
  /** render 好幾個 quantum，串起左聲道。 */
  const renderFrames = (frames: number): number[] => {
    const left: number[] = [];
    for (let i = 0; i < frames / quantum; i++) left.push(...render());
    return left;
  };
  const send = (message: MainToWorkletMessage) => {
    core.handle(message);
  };
  /** 狀態回報（不含 clock）的 type。 */
  const states = () => reports.filter((r) => r.type !== 'clock').map((r) => r.type);
  const lastClock = () => reports.findLast((r) => r.type === 'clock');
  return { core, worker, reports, render, renderFrames, send, states, lastClock };
}

describe('水位', () => {
  it('低於 refill 時要求補到 target；補滿之前（filling）低於 target 就要求', () => {
    const marks = { refill: 75, target: 150, capacity: 400 };
    expect(framesToRequest(marks, 0, false)).toBe(150);
    expect(framesToRequest(marks, 74, false)).toBe(76);
    expect(framesToRequest(marks, 75, false)).toBe(0);
    expect(framesToRequest(marks, 100, true)).toBe(50);
    expect(framesToRequest(marks, 150, true)).toBe(0);
    expect(framesToRequest(marks, 200, true)).toBe(0);
  });
});

describe('PcmRing', () => {
  const read = (ring: PcmRing, frames: number) => {
    const output = [new Float32Array(frames), new Float32Array(frames)];
    ring.read(output, 0, frames);
    return output.map((c) => [...c]);
  };

  it('繞回開頭時順序不變，放不下的部分丟掉，媒體時間跨段換算', () => {
    const ring = new PcmRing(8, sampleRate);
    expect(ring.time).toBeNull();
    ring.write(2, [Float32Array.from(ramp(6)), Float32Array.from(ramp(6, 11))]);
    expect(read(ring, 4)).toEqual([ramp(4), ramp(4, 11)]);
    expect(ring.time).toBe(2.004);

    expect(ring.write(5, [Float32Array.from(ramp(8, 101))])).toBe(6);
    expect(ring.buffered).toBe(8);
    expect(read(ring, 3)).toEqual([
      [5, 6, 101],
      [15, 16, 101],
    ]);
    expect(ring.time).toBe(5.001);
    expect(read(ring, 5)).toEqual([ramp(5, 102), ramp(5, 102)]);
    expect(ring.buffered).toBe(0);
    expect(ring.time).toBe(5.006);
  });
});

describe('補滿', () => {
  it('flush 之後要求 target 的量，補到 target 才依播放意圖回報', () => {
    const { worker, send, states } = setup();
    send({ type: 'flush', epoch: 1, position: 0 });
    expect(worker.requested(1)).toBe(150);

    worker.pcm(1, 0, ramp(100));
    expect(states()).toEqual([]);
    worker.pcm(1, 0.1, ramp(60, 101));
    expect(states()).toEqual(['paused']);
  });

  it('暫停時不輸出，時鐘停在 flush 的位置', () => {
    const { worker, send, renderFrames, lastClock } = setup();
    send({ type: 'flush', epoch: 1, position: 3 });
    worker.pcm(1, 3, ramp(160));
    expect(renderFrames(100).every((v) => v === 0)).toBe(true);
    expect(lastClock()).toMatchObject({ epoch: 1, position: 3 });
  });
});

describe('播放與時鐘', () => {
  it('播出送入的 PCM，時鐘只隨播出的 sample 前進', () => {
    const { worker, send, render, renderFrames, states, lastClock } = setup();
    send({ type: 'flush', epoch: 1, position: 2 });
    send({ type: 'play', epoch: 1 });
    worker.pcm(1, 2, ramp(150));
    expect(states()).toEqual(['playing']);
    expect(lastClock()).toMatchObject({ position: 2 });

    expect(render()).toEqual(ramp(10));
    expect(renderFrames(40)).toEqual(ramp(40, 11));
    send({ type: 'pause', epoch: 1 });
    expect(states()).toEqual(['playing', 'paused']);
    expect(lastClock()).toMatchObject({ position: 2.05, frame: 50 });
    expect(render()).toEqual(silence(10));
  });

  it('右聲道照樣輸出', () => {
    const { core, worker, send } = setup();
    send({ type: 'flush', epoch: 1, position: 0 });
    send({ type: 'play', epoch: 1 });
    worker.pcm(1, 0, ramp(150));
    const output = [new Float32Array(4), new Float32Array(4)];
    core.render(output, 0);
    expect([...(output[1] ?? [])]).toEqual([-1, -2, -3, -4]);
  });

  it('時鐘前進時約每 250 ms 回報一次，帶 context frame', () => {
    const { worker, send, renderFrames, reports } = setup();
    send({ type: 'flush', epoch: 1, position: 0 });
    send({ type: 'play', epoch: 1 });
    worker.pcm(1, 0, ramp(400));
    for (let i = 0; i < 6; i++) {
      renderFrames(100);
      worker.pcm(1, 0.4 + i * 0.1, ramp(100));
    }
    const clocks = reports.filter((r) => r.type === 'clock');
    expect(clocks.map((c) => c.frame)).toEqual([0, 250, 500]);
    expect(clocks.map((c) => c.position)).toEqual([0, 0.25, 0.5]);
  });

  it('flush 之後還沒補滿就 play：補滿時才回報 playing', () => {
    const { worker, send, states, render } = setup();
    send({ type: 'flush', epoch: 1, position: 0 });
    send({ type: 'play', epoch: 1 });
    worker.pcm(1, 0, ramp(100));
    expect(states()).toEqual([]);
    expect(render()).toEqual(silence(10));
    worker.pcm(1, 0.1, ramp(50, 101));
    expect(states()).toEqual(['playing']);
    expect(render()).toEqual(ramp(10));
  });
});

describe('水位與要求', () => {
  it('播放中低於 refill 才再要，補到 target；已要求的量計入水位', () => {
    const { worker, send, renderFrames } = setup();
    send({ type: 'flush', epoch: 1, position: 0 });
    send({ type: 'play', epoch: 1 });
    worker.pcm(1, 0, ramp(150));
    expect(worker.requested(1)).toBe(150);

    renderFrames(70); // 剩 80，還在 refill 之上
    expect(worker.requested(1)).toBe(150);
    renderFrames(10); // 剩 70
    expect(worker.requested(1)).toBe(150 + 80);
    renderFrames(10); // 剩 60，加上未到的 80 仍在 refill 之上
    expect(worker.requested(1)).toBe(150 + 80);
  });

  it('收進 ring 的 PCM buffer 立即還給 Worker', () => {
    const { worker, send } = setup();
    send({ type: 'flush', epoch: 1, position: 0 });
    const channels = [new Float32Array(20), new Float32Array(20)];
    worker.deliver({ type: 'pcm', epoch: 1, time: 0, channels });
    expect(worker.released()).toEqual(channels.map((c) => c.buffer));
  });
});

describe('starved', () => {
  it('ring 用完時停住時鐘並回報 starved，補回 target 才回報 playing', () => {
    const { worker, send, render, renderFrames, states, lastClock } = setup();
    send({ type: 'flush', epoch: 1, position: 0 });
    send({ type: 'play', epoch: 1 });
    worker.pcm(1, 0, ramp(150));
    renderFrames(150);
    expect(states()).toEqual(['playing']);

    expect(render()).toEqual(silence(10));
    expect(states()).toEqual(['playing', 'starved']);
    expect(lastClock()).toMatchObject({ position: 0.15, underruns: 1 });
    renderFrames(50);
    expect(lastClock()).toMatchObject({ position: 0.15 });

    worker.pcm(1, 0.15, ramp(100, 151));
    expect(states()).toEqual(['playing', 'starved']);
    worker.pcm(1, 0.25, ramp(50, 251));
    expect(states()).toEqual(['playing', 'starved', 'playing']);
    expect(render()).toEqual(ramp(10, 151));
  });

  it('starved 時 pause 立即回報 paused', () => {
    const { worker, send, renderFrames, states } = setup();
    send({ type: 'flush', epoch: 1, position: 0 });
    send({ type: 'play', epoch: 1 });
    worker.pcm(1, 0, ramp(150));
    renderFrames(160);
    send({ type: 'pause', epoch: 1 });
    expect(states()).toEqual(['playing', 'starved', 'paused']);
  });

  it('starved 之後：已要求但還沒到的量不足 target 時繼續要', () => {
    const { worker, send, renderFrames } = setup();
    send({ type: 'flush', epoch: 1, position: 0 });
    send({ type: 'play', epoch: 1 });
    worker.pcm(1, 0, ramp(150));
    renderFrames(80); // 剩 70：要 80
    renderFrames(80); // 用完，starved；未到的 80 < target
    expect(worker.requested(1)).toBe(150 + 80 + 70);
  });
});

describe('eof 與 ended', () => {
  it('eof 之後音訊播完，以靜音推進到 duration 才回報 ended', () => {
    const { worker, send, renderFrames, states, lastClock } = setup();
    send({ type: 'flush', epoch: 1, position: 0 });
    send({ type: 'duration', epoch: 1, duration: 0.2 });
    send({ type: 'play', epoch: 1 });
    worker.pcm(1, 0, ramp(50));
    worker.deliver({ type: 'eof', epoch: 1 });
    // eof 時不必補到 target 就開始。
    expect(states()).toEqual(['playing']);

    expect(renderFrames(100)).toEqual([...ramp(50), ...silence(50)]);
    expect(states()).toEqual(['playing']);
    renderFrames(100);
    expect(states()).toEqual(['playing', 'ended']);
    expect(lastClock()).toMatchObject({ position: 0.2 });
    // ended 之後不再要求資料，時鐘不再前進。
    const requested = worker.requested(1);
    renderFrames(300);
    expect(worker.requested(1)).toBe(requested);
    expect(states()).toEqual(['playing', 'ended']);
  });

  it('沒有音訊（立即 eof）時以靜音推進時鐘', () => {
    const { worker, send, renderFrames, states, lastClock } = setup();
    send({ type: 'flush', epoch: 1, position: 1 });
    send({ type: 'duration', epoch: 1, duration: 1.3 });
    worker.deliver({ type: 'eof', epoch: 1 });
    expect(states()).toEqual(['paused']);
    send({ type: 'play', epoch: 1 });
    renderFrames(260);
    expect(lastClock()).toMatchObject({ position: 1.25 });
    renderFrames(50);
    expect(states()).toEqual(['paused', 'playing', 'ended']);
    expect(lastClock()).toMatchObject({ position: 1.3 });
  });

  it('超出 duration 的音訊截掉', () => {
    const { worker, send, renderFrames, states } = setup();
    send({ type: 'flush', epoch: 1, position: 0 });
    send({ type: 'duration', epoch: 1, duration: 0.025 });
    send({ type: 'play', epoch: 1 });
    worker.pcm(1, 0, ramp(150));
    expect(renderFrames(40)).toEqual([...ramp(25), ...silence(15)]);
    expect(states()).toEqual(['playing', 'ended']);
  });

  it('duration 未知時，eof 之後 ring 播完就 ended', () => {
    const { worker, send, renderFrames, states, lastClock } = setup();
    send({ type: 'flush', epoch: 1, position: 0 });
    send({ type: 'play', epoch: 1 });
    worker.pcm(1, 0, ramp(30));
    worker.deliver({ type: 'eof', epoch: 1 });
    expect(renderFrames(40)).toEqual([...ramp(30), ...silence(10)]);
    expect(states()).toEqual(['playing', 'ended']);
    expect(lastClock()).toMatchObject({ position: 0.03 });
  });

  it('paused 時 eof 不推進時鐘', () => {
    const { worker, send, renderFrames, states, lastClock } = setup();
    send({ type: 'flush', epoch: 1, position: 0 });
    send({ type: 'duration', epoch: 1, duration: 0.1 });
    worker.deliver({ type: 'eof', epoch: 1 });
    renderFrames(200);
    expect(states()).toEqual(['paused']);
    expect(lastClock()).toMatchObject({ position: 0 });
  });

  it('duration 沿用到之後的 flush', () => {
    const { worker, send, renderFrames, states } = setup();
    send({ type: 'flush', epoch: 1, position: 0 });
    send({ type: 'duration', epoch: 1, duration: 0.5 });
    send({ type: 'flush', epoch: 2, position: 0.48 });
    send({ type: 'play', epoch: 2 });
    worker.deliver({ type: 'eof', epoch: 2 });
    renderFrames(30);
    expect(states()).toEqual(['playing', 'ended']);
  });
});

describe('epoch', () => {
  it('新的 epoch 讓 ring 內的舊資料不被播出，之後收到的舊資料也丟掉', () => {
    const { worker, send, render, states, lastClock } = setup();
    send({ type: 'flush', epoch: 1, position: 0 });
    send({ type: 'play', epoch: 1 });
    worker.pcm(1, 0, ramp(150));
    expect(render()).toEqual(ramp(10));

    send({ type: 'flush', epoch: 2, position: 5 });
    expect(lastClock()).toMatchObject({ epoch: 1 });
    expect(render()).toEqual(silence(10));
    expect(worker.requested(2)).toBe(150);

    worker.pcm(1, 0.15, ramp(150, 151));
    worker.pcm(2, 5, ramp(150, 1001));
    expect(states()).toEqual(['playing', 'playing']);
    expect(lastClock()).toMatchObject({ epoch: 2, position: 5 });
    expect(render()).toEqual(ramp(10, 1001));
  });

  it('舊 epoch 的 PCM buffer 也還給 Worker', () => {
    const { worker, send } = setup();
    send({ type: 'flush', epoch: 2, position: 0 });
    const channels = [new Float32Array(20), new Float32Array(20)];
    worker.deliver({ type: 'pcm', epoch: 1, time: 0, channels });
    expect(worker.released()).toEqual(channels.map((c) => c.buffer));
  });

  it('比目前新的 epoch 的訊息先留著，flush 到該 epoch 時套用', () => {
    const { worker, send, states } = setup();
    send({ type: 'flush', epoch: 1, position: 0 });
    worker.deliver({ type: 'eof', epoch: 2 });
    expect(states()).toEqual([]);
    send({ type: 'flush', epoch: 2, position: 0 });
    expect(states()).toEqual(['paused']);
  });

  it('過期的主執行緒訊息丟掉', () => {
    const { worker, send, states } = setup();
    send({ type: 'flush', epoch: 2, position: 0 });
    send({ type: 'play', epoch: 1 });
    worker.pcm(2, 0, ramp(150));
    expect(states()).toEqual(['paused']);
  });
});

describe('connect', () => {
  it('接上新的 Worker 時關閉舊的，舊的訊息不再使用，向新的要資料', () => {
    const { core, worker, send, states } = setup();
    send({ type: 'flush', epoch: 1, position: 0 });
    const next = new FakeTransport();
    core.connect(next);
    expect(worker.closed).toBe(true);
    expect(next.requested(1)).toBe(150);

    worker.pcm(1, 0, ramp(150));
    expect(states()).toEqual([]);
    next.pcm(1, 0, ramp(150));
    expect(states()).toEqual(['paused']);
  });

  it('flush 之前不要求資料', () => {
    const { worker } = setup();
    expect(worker.sent).toEqual([]);
  });
});
