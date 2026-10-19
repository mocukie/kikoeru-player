// 不變調變速（#43）：以協定驅動頁面內的 MediaWorker，經過真實的 atempo。
import { describe, expect, test } from 'vitest';
import {
  audioTracks,
  beepOnsets,
  mediaBytes,
  WorkerDriver,
  type DecodedPcm,
  type WorkerEndpoint,
} from '../../test/media-worker-harness.js';
import type { WorkerToMainMessage, WorkletPcmMessage } from '../protocol/index.js';
import { MediaWorker } from './media-worker.js';

const SR = 48_000;

function inPage(): WorkerEndpoint {
  let listener: ((message: WorkerToMainMessage) => void) | null = null;
  const worker = new MediaWorker({ postMessage: (m) => listener?.(m) });
  return {
    post: (message) => {
      worker.handle(message);
    },
    onMessage: (l) => {
      listener = l;
    },
  };
}

async function open(data: ArrayBuffer, rate = 1) {
  const driver = await WorkerDriver.init(inPage(), { rate });
  const media = await driver.load({ kind: 'bytes', data });
  const [track] = audioTracks(media);
  if (!track) throw new Error('沒有音軌');
  return { driver, track };
}

/** 依 chunk 的 time map（time、rate）換算輸出第 `index` 個 frame 的媒體時間。 */
function mediaTimeAt(chunks: readonly WorkletPcmMessage[], index: number): number {
  let at = 0;
  for (const chunk of chunks) {
    const length = chunk.channels[0]?.length ?? 0;
    if (index < at + length) return chunk.time + ((index - at) * chunk.rate) / SR;
    at += length;
  }
  return NaN;
}

/**
 * 聽到的 beep 起點（輸出的 frame）換算成媒體時間。`beepOnsets` 以 0.5 秒的靜音分開 beep，快轉時輸出的間隔變短，
 * 所以依速度縮短（以縮小的取樣率傳入，再換回 frame）。
 */
function beepTimes(pcm: DecodedPcm, rate: number): number[] {
  const scaled = SR / Math.max(1, rate);
  return beepOnsets(pcm.left, scaled).map((t) => mediaTimeAt(pcm.chunks, Math.round(t * scaled)));
}

/**
 * atempo（WSOLA）的 window 是 2048 sample（48 kHz）：輸出由 window 為單位的片段疊接，片段的位置依波形對齊，
 * 完全的靜音之後對齊找不到依據，beep 的起點可能偏移到接近一個 window。browser mode 實測 1.25x 早 12–20 ms、
 * 2x 約 34 ms，容差取一個 window。E2E 的容差另見 test/e2e/tolerances.ts。
 */
const STRETCHED_ONSET_TOLERANCE = 2048 / SR;

/** 連續的 440 Hz 正弦波（振幅 0.5）的 PCM s16 stereo WAV。 */
function toneWav(seconds: number): ArrayBuffer {
  const frames = SR * seconds;
  const view = new DataView(new ArrayBuffer(44 + frames * 4));
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + frames * 4, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, SR, true);
  view.setUint32(28, SR * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, frames * 4, true);
  for (let i = 0; i < frames; i++) {
    const value = Math.round(0.5 * Math.sin((2 * Math.PI * 440 * i) / SR) * 32767);
    view.setInt16(44 + i * 4, value, true);
    view.setInt16(46 + i * 4, value, true);
  }
  return view.buffer;
}

/** 相鄰兩個 sample 的最大差；440 Hz、振幅 0.5 的正弦波約 0.029，不連續的跳點會大得多。 */
function maxStep(samples: Float32Array): number {
  let max = 0;
  for (let i = 1; i < samples.length; i++) {
    max = Math.max(max, Math.abs((samples[i] ?? 0) - (samples[i - 1] ?? 0)));
  }
  return max;
}

describe('變速', () => {
  for (const rate of [0.5, 0.75, 1.25, 1.5, 2]) {
    test(`${String(rate)}x：輸出長度是 10 秒 ÷ rate，chunk 帶 rate，beep 依 time map 落在整數秒`, async () => {
      const { driver, track } = await open(await mediaBytes('audio/pcm-s16.wav'), rate);
      const pcm = await driver.decode(track.streamIndex);
      expect(pcm.chunks.every((c) => c.rate === rate)).toBe(true);
      // atempo 排空時最後一段約少一個 window。
      expect(Math.abs(pcm.left.length - (10 * SR) / rate)).toBeLessThan(0.1 * SR);
      const times = beepTimes(pcm, rate);
      expect(times.map(Math.round)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      for (const time of times) {
        expect(Math.abs(time - Math.round(time))).toBeLessThanOrEqual(STRETCHED_ONSET_TOLERANCE);
      }
    });
  }

  test('1.0x → 1.25x → 1.0x：已送出的照舊速度；進出 bypass 沒有不連續的跳點，time map 連續', async () => {
    const { driver, track } = await open(toneWav(6));
    const first = await driver.decode(track.streamIndex, { frames: SR });
    driver.post({ type: 'rate', rate: 1.25 });
    const second = await driver.collect(1, SR);
    driver.post({ type: 'rate', rate: 1 });
    const third = await driver.collect(1);
    const chunks = [...first.chunks, ...second.chunks, ...third.chunks];
    const rates = chunks.map((c) => c.rate).filter((r, i, all) => r !== all[i - 1]);
    expect(rates).toEqual([1, 1.25, 1]);
    for (const part of [first, second, third]) {
      expect(maxStep(part.left)).toBeLessThan(0.05);
    }
    const all = new Float32Array([...first.left, ...second.left, ...third.left]);
    expect(maxStep(all)).toBeLessThan(0.05);
    // 每一段接在前一段的媒體時間之後：atempo 的 time map 誤差在一個 window 內。
    for (let i = 1; i < chunks.length; i++) {
      const previous = chunks[i - 1];
      const chunk = chunks[i];
      if (!previous || !chunk) continue;
      const end = previous.time + ((previous.channels[0]?.length ?? 0) * previous.rate) / SR;
      expect(Math.abs(chunk.time - end)).toBeLessThan(0.05);
    }
    // 回到 bypass 之後是原樣的輸入：時間到結尾 6 秒。
    const last = third.chunks.at(-1);
    expect(last && last.time + (last.channels[0]?.length ?? 0) / SR).toBeCloseTo(6, 3);
  });

  test('1.25x → 1.5x：換速度時也沒有跳點', async () => {
    const { driver, track } = await open(toneWav(4), 1.25);
    const first = await driver.decode(track.streamIndex, { frames: SR });
    driver.post({ type: 'rate', rate: 1.5 });
    const second = await driver.collect(1);
    expect(new Set(second.chunks.map((c) => c.rate))).toEqual(new Set([1.25, 1.5]));
    expect(maxStep(new Float32Array([...first.left, ...second.left]))).toBeLessThan(0.05);
  });

  test('變速中 seek：新的 epoch 沿用速度，從落點開始，beep 依 time map 落在整數秒', async () => {
    const { driver, track } = await open(await mediaBytes('audio/flac.flac'));
    await driver.decode(track.streamIndex, { frames: SR });
    driver.post({ type: 'rate', rate: 1.25 });
    const pcm = await driver.seek(4.5, 2);
    expect(pcm.chunks[0]?.time).toBeCloseTo(4.5, 3);
    expect(pcm.chunks.every((c) => c.rate === 1.25)).toBe(true);
    const times = beepTimes(pcm, 1.25);
    expect(times.map(Math.round)).toEqual([5, 6, 7, 8, 9]);
    for (const time of times) {
      expect(Math.abs(time - Math.round(time))).toBeLessThanOrEqual(STRETCHED_ONSET_TOLERANCE);
    }
  });
});
