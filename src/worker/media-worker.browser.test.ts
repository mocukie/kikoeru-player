// media Worker 的音訊 pipeline（以協定驅動，MediaWorker 直接在頁面內執行）：probe、demux、wasm 解碼、
// filter graph 的重採樣與 downmix、供料、錯誤與中止。真實 Worker 的行為見 index.browser.test.ts。
import { describe, expect, test } from 'vitest';
import {
  amplitudeAt,
  audioTracks,
  beepOnsets,
  beepWav,
  type DecodedPcm,
  importOnlyWasm,
  mediaBytes,
  peak,
  WorkerDriver,
  type WorkerEndpoint,
} from '../../test/media-worker-harness.js';
import type { WorkerToMainMessage, WorkerToWorkletMessage } from '../protocol/index.js';
import { MediaWorker, type MediaWorkerDeps } from './media-worker.js';
import type { ByteSource } from './source.js';

function inPage(deps: Omit<MediaWorkerDeps, 'postMessage'> = {}): WorkerEndpoint {
  let listener: ((message: WorkerToMainMessage) => void) | null = null;
  const worker = new MediaWorker({ ...deps, postMessage: (m) => listener?.(m) });
  return {
    post: (message) => {
      worker.handle(message);
    },
    onMessage: (l) => {
      listener = l;
    },
  };
}

async function decodeFile(path: string, sampleRate = 48_000) {
  const driver = await WorkerDriver.init(inPage(), { sampleRate });
  const media = await driver.load({ kind: 'bytes', data: await mediaBytes(path) });
  const [track] = audioTracks(media);
  if (!track) throw new Error(`${path} 沒有音軌`);
  const pcm = await driver.decode(track.streamIndex);
  return { driver, media, track, pcm };
}

const SECONDS = 10;

/** 收到的某個 epoch 的 PCM frame 數。 */
function frames(messages: readonly WorkerToWorkletMessage[], epoch: number): number {
  return messages.reduce(
    (sum, m) => sum + (m.type === 'pcm' && m.epoch === epoch ? (m.channels[0]?.length ?? 0) : 0),
    0,
  );
}
const beeps = Array.from({ length: SECONDS }, (_, i) => i);

/**
 * CI 組的音訊檔（test/media/README.md）。lossless 的長度與 beep 位置精確到幾個 sample；有損 codec 的開頭依格式
 * 可能有沒裁掉的 priming 或多裁的 frame（ADR-0003），容許 25 ms。
 */
const audioFiles: { file: string; codec: string; lossless: boolean }[] = [
  { file: 'mp3.mp3', codec: 'mp3', lossless: false },
  { file: 'aac.m4a', codec: 'aac', lossless: false },
  { file: 'aac-adts.aac', codec: 'aac', lossless: false },
  { file: 'alac.m4a', codec: 'alac', lossless: true },
  { file: 'opus.opus', codec: 'opus', lossless: false },
  { file: 'vorbis.ogg', codec: 'vorbis', lossless: false },
  { file: 'flac.flac', codec: 'flac', lossless: true },
  { file: 'wavpack.wv', codec: 'wavpack', lossless: true },
  { file: 'pcm-s16.wav', codec: 'pcm_s16le', lossless: true },
  { file: 'pcm-s24.wav', codec: 'pcm_s24le', lossless: true },
  { file: 'pcm-s32.wav', codec: 'pcm_s32le', lossless: true },
  { file: 'pcm-f32.wav', codec: 'pcm_f32le', lossless: true },
  { file: 'pcm-f64.wav', codec: 'pcm_f64le', lossless: true },
  { file: 'pcm-u8.wav', codec: 'pcm_u8', lossless: true },
  { file: 'pcm-s16be.aiff', codec: 'pcm_s16be', lossless: true },
  { file: 'ac3.ac3', codec: 'ac3', lossless: false },
  { file: 'eac3.eac3', codec: 'eac3', lossless: false },
  { file: 'flac-44100.flac', codec: 'flac', lossless: true },
  { file: 'flac-96000.flac', codec: 'flac', lossless: true },
  { file: 'flac-192000.flac', codec: 'flac', lossless: true },
];

describe('CI 組的音訊檔', () => {
  test.each(audioFiles)('$file', async ({ file, codec, lossless }) => {
    const { track, pcm } = await decodeFile(`audio/${file}`);
    expect(track).toMatchObject({ codec, supported: true, channels: 2 });

    const tolerance = lossless ? 5 / pcm.sampleRate : 0.025;
    expect(pcm.time).toBe(0);
    expect(pcm.left.length / pcm.sampleRate).toBeCloseTo(SECONDS, lossless ? 3 : 1);
    expect(Math.abs(pcm.left.length / pcm.sampleRate - SECONDS)).toBeLessThan(
      lossless ? 2 / pcm.sampleRate : 0.05,
    );
    const onsets = beepOnsets(pcm.left, pcm.sampleRate);
    // 有損 codec 多裁的開頭會切掉第一聲的起點，從第二聲開始比對。
    const expected = lossless ? beeps : beeps.slice(1);
    const measured = lossless ? onsets : onsets.slice(onsets.length - expected.length);
    expect(measured).toHaveLength(expected.length);
    measured.forEach((onset, i) => {
      expect(Math.abs(onset - (expected[i] ?? NaN))).toBeLessThanOrEqual(tolerance);
    });
    expect(peak(pcm.left)).toBeGreaterThan(0.45);
    expect(peak(pcm.left)).toBeLessThan(0.65);
    // 測試媒體的兩個聲道相同；有損 codec 的 joint stereo 不保證逐 sample 相同。
    if (lossless) expect([...pcm.right]).toEqual([...pcm.left]);
  });

  test.each([
    ['pcm-s24.wav', 's24'],
    ['pcm-f64.wav', 'f64'],
    ['pcm-u8.wav', 'u8'],
    ['flac-192000.flac', 's32'],
  ])('%s 的原始取樣格式是 %s', async (file, sampleFormat) => {
    const driver = await WorkerDriver.init(inPage());
    const media = await driver.load({ kind: 'bytes', data: await mediaBytes(`audio/${file}`) });
    expect(audioTracks(media)[0]?.sampleFormat).toBe(sampleFormat);
  });
});

describe('filter graph', () => {
  test.each([
    ['flac-96000.flac', 44_100],
    ['flac-192000.flac', 44_100],
    ['flac-44100.flac', 96_000],
    ['pcm-s16.wav', 44_100],
  ])('%s 重採樣到 context 的 %i Hz', async (file, sampleRate) => {
    const { pcm } = await decodeFile(`audio/${file}`, sampleRate);
    expect(Math.abs(pcm.left.length - SECONDS * sampleRate)).toBeLessThanOrEqual(2);
    const onsets = beepOnsets(pcm.left, sampleRate);
    expect(onsets).toHaveLength(SECONDS);
    onsets.forEach((onset, i) => {
      expect(Math.abs(onset - i)).toBeLessThanOrEqual(5 / sampleRate);
    });
  });

  test('5.1 以 swresample 的預設係數 downmix：中央分到兩邊、後方到同側、LFE 捨棄', async () => {
    const { track, pcm } = await decodeFile('audio/flac-5.1.flac');
    expect(track).toMatchObject({ channels: 6, channelLayout: '5.1' });
    // 每個聲道的基準頻率：FL 440、FR 550、FC 660、LFE 110、BL 770、BR 880 Hz。第 1 秒的 beep（不是加倍的那一聲）。
    const rate = pcm.sampleRate;
    const at = (samples: Float32Array, frequency: number) =>
      amplitudeAt(samples, rate, frequency, rate + rate / 100, rate / 12);
    for (const [samples, present, absent] of [
      [pcm.left, [440, 660, 770], [550, 880, 110]],
      [pcm.right, [550, 660, 880], [440, 770, 110]],
    ] as const) {
      for (const f of present) expect(at(samples, f), `${String(f)} Hz`).toBeGreaterThan(0.2);
      for (const f of absent) expect(at(samples, f), `${String(f)} Hz`).toBeLessThan(0.02);
    }
    // 前方聲道 1.0、中央與後方 -3 dB（swresample 預設不做正規化）。
    expect(at(pcm.left, 440)).toBeCloseTo(0.5, 1);
    expect(at(pcm.left, 660)).toBeCloseTo(0.5 * Math.SQRT1_2, 1);
  });

  test('mono 複製到兩個聲道，音量不變', async () => {
    const driver = await WorkerDriver.init(inPage());
    const media = await driver.load({
      kind: 'bytes',
      data: beepWav({ sampleRate: 48_000, channels: 1, seconds: 2 }),
    });
    expect(audioTracks(media)[0]).toMatchObject({ channels: 1 });
    const pcm = await driver.decode(0);
    expect(pcm.left.length).toBe(96_000);
    expect([...pcm.right]).toEqual([...pcm.left]);
    expect(peak(pcm.left)).toBeCloseTo(0.5, 2);
  });
});

describe('影片容器內的音軌', () => {
  test.each([
    ['video/h264-aac.mp4', 'aac'],
    ['video/vp9-opus.webm', 'opus'],
    ['video/h264-mp3.avi', 'mp3'],
  ])('%s 的 %s 音軌', async (file, codec) => {
    const { track, pcm } = await decodeFile(file);
    expect(track.codec).toBe(codec);
    expect(Math.abs(pcm.left.length / 48_000 - SECONDS)).toBeLessThan(0.05);
    const onsets = beepOnsets(pcm.left, 48_000).slice(-(SECONDS - 1));
    onsets.forEach((onset, i) => {
      expect(Math.abs(onset - (i + 1))).toBeLessThanOrEqual(0.025);
    });
  });
});

describe('probe 與選軌', () => {
  test('多軌 MKV：軌道組成、語言、標題與旗標', async () => {
    const driver = await WorkerDriver.init(inPage());
    const media = await driver.load({
      kind: 'bytes',
      data: await mediaBytes('video/multi-track.mkv'),
    });
    expect(media.format).toBe('matroska,webm');
    expect(media.duration).toBeCloseTo(20, 1);
    expect(media.tracks).toMatchObject([
      { kind: 'video', streamIndex: 0, codec: 'h264', supported: true, codedWidth: 320 },
      {
        kind: 'audio',
        streamIndex: 1,
        codec: 'aac',
        language: 'ja',
        rawLanguage: 'jpn',
        title: 'beep 880 Hz',
        default: true,
      },
      { kind: 'audio', streamIndex: 2, codec: 'opus', language: 'zh', title: 'beep 440 Hz' },
      { kind: 'subtitle', streamIndex: 3, format: 'subrip', language: 'ja', supported: true },
      { kind: 'subtitle', streamIndex: 4, format: 'ass', language: 'zh', supported: true },
    ]);
    const ass = media.tracks[4];
    expect(ass?.kind === 'subtitle' && ass.header).toContain('[Script Info]');
  });

  test('只解選中的音軌', async () => {
    const driver = await WorkerDriver.init(inPage());
    await driver.load({ kind: 'bytes', data: await mediaBytes('video/multi-track.mkv') });
    const pcm = await driver.decode(2, { frames: 2 * 48_000 });
    const window = [48_000 + 480, 2400] as const;
    expect(amplitudeAt(pcm.left, 48_000, 440, ...window)).toBeGreaterThan(0.3);
    expect(amplitudeAt(pcm.left, 48_000, 880, ...window)).toBeLessThan(0.02);
  });

  test('容器的 start_time 換算到媒體時間軸：MP3 的第一個 sample 在 0', async () => {
    const { media, pcm } = await decodeFile('audio/mp3.mp3');
    expect(media).toMatchObject({ format: 'mp3', duration: 10 });
    expect(pcm.time).toBe(0);
  });
});

describe('供料', () => {
  test('依要求送出 2048–4096 frame 的 chunk，帶 epoch 與連續的媒體時間', async () => {
    const driver = await WorkerDriver.init(inPage());
    await driver.load({ kind: 'bytes', data: await mediaBytes('audio/flac.flac') }, 4);
    const pcm = await driver.decode(0, { epoch: 5, frames: 20_000 });
    let end = 0;
    for (const chunk of pcm.chunks) {
      expect(chunk.epoch).toBe(5);
      expect(chunk.channels).toHaveLength(2);
      const length = chunk.channels[0]?.length ?? 0;
      expect(length).toBeGreaterThanOrEqual(2048);
      expect(length).toBeLessThanOrEqual(4096);
      expect(chunk.time).toBeCloseTo(end, 9);
      end += length / 48_000;
    }
    expect(pcm.left.length).toBeGreaterThanOrEqual(20_000);
    expect(pcm.left.length).toBeLessThan(20_000 + 4096);
  });

  test('從 start 的時間開始輸出', async () => {
    const driver = await WorkerDriver.init(inPage());
    await driver.load({ kind: 'bytes', data: await mediaBytes('audio/flac.flac') });
    const pcm = await driver.decode(0, { time: 2.5 });
    expect(pcm.time).toBe(2.5);
    expect(pcm.left.length).toBe(7.5 * 48_000);
    expect(beepOnsets(pcm.left, 48_000)[0]).toBeCloseTo(0.5, 4);
  });

  test('不輸出音軌時立即送出 EOF', async () => {
    const driver = await WorkerDriver.init(inPage());
    await driver.load({ kind: 'bytes', data: await mediaBytes('audio/flac.flac') });
    const pcm = await driver.decode(null);
    expect(pcm.chunks).toEqual([]);
    expect(driver.worklet).toEqual([{ type: 'eof', epoch: 1 }]);
  });

  test('port：改接重建後的 worklet，以新的 epoch 從指定時間重新供料，舊的 port 不再收到資料', async () => {
    const driver = await WorkerDriver.init(inPage());
    await driver.load({ kind: 'bytes', data: await mediaBytes('audio/flac.flac') });
    await driver.decode(0, { frames: 10_000 });
    const before = driver.worklet.length;

    const channel = new MessageChannel();
    const received: WorkerToWorkletMessage[] = [];
    channel.port2.onmessage = ({ data }: MessageEvent<WorkerToWorkletMessage>) => {
      received.push(data);
    };
    driver.post({ type: 'port', port: channel.port1, epoch: 2, time: 3 }, [channel.port1]);
    channel.port2.postMessage({ type: 'need', epoch: 2, frames: 8192 });
    const deadline = performance.now() + 5000;
    while (frames(received, 2) < 8192 && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // 舊的 worklet 再要資料也沒有回應。
    driver.need(1, 8192);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(frames(received, 2)).toBeGreaterThanOrEqual(8192);
    const first = received.find((m) => m.type === 'pcm');
    expect(first?.type === 'pcm' && first.time).toBeGreaterThanOrEqual(3);
    expect(driver.worklet.slice(before).filter((m) => m.type === 'pcm')).toEqual([]);
    channel.port2.close();
  });

  test('blob 來源', async () => {
    const driver = await WorkerDriver.init(inPage());
    const blob = new Blob([await mediaBytes('audio/opus.opus')]);
    await driver.load({ kind: 'blob', blob });
    const pcm = await driver.decode(0);
    expect(pcm.left.length).toBe(SECONDS * 48_000);
  });
});

/**
 * `seeked`（從 seek 落點開始的 PCM）與 `reference`（從頭解碼的 PCM）在 `reference[start]` 附近的對齊：
 * 在 ±`range` sample 內找平方誤差最小的位移，回傳位移與該位移的 RMS 誤差。
 */
function alignment(
  reference: Float32Array,
  start: number,
  seeked: Float32Array,
  length: number,
  range = 32,
): { lag: number; rms: number } {
  let best = { lag: NaN, rms: Infinity };
  for (let lag = -range; lag <= range; lag++) {
    let sum = 0;
    for (let i = 0; i < length; i++) {
      const d = (seeked[i] ?? 0) - (reference[start + lag + i] ?? 0);
      sum += d * d;
    }
    const rms = Math.sqrt(sum / length);
    if (rms < best.rms) best = { lag, rms };
  }
  return best;
}

describe('精準 seek', () => {
  /** 落點：整秒附近、beep 中間、不落在 sample 整數倍上的時間，以及回到開頭。比對的範圍（1.1 秒）一定含一個完整的 beep。 */
  const targets = [0.5, 3.03, 4.123_456, 7.95, 0];

  /**
   * 和從頭解碼的結果比對：起點誤差 0 sample，經重採樣的路線 ≤ 1 sample。輸出的第一個 sample 是落點捨入到的那個
   * sample，回報的時間是它的位置。不經重採樣時，lossless 逐 sample 相同；有損 codec 的 preroll 讓內容收斂
   *（ADR-0003），誤差遠小於差一個 sample 的程度（比對範圍內，880 Hz、振幅 0.5 的 beep 差一個 sample 約 0.012 RMS）。
   */
  async function expectPreciseSeeks(
    driver: WorkerDriver,
    reference: DecodedPcm,
    options: { resampled: boolean; lossless: boolean; maxLag?: number },
  ): Promise<void> {
    let epoch = 100;
    for (const target of targets) {
      const at = `${String(target)} s`;
      const seeked = await driver.seek(target, ++epoch);
      expect(seeked.chunks.every((c) => c.epoch === epoch)).toBe(true);
      expect(Math.abs(seeked.time - target) * 48_000, at).toBeLessThanOrEqual(0.5 + 1e-6);
      const start = Math.round(target * 48_000);
      const length = seeked.left.length - (reference.left.length - start);
      const { lag, rms } = alignment(reference.left, start, seeked.left, 1.1 * 48_000, 64);
      if (options.maxLag !== undefined) {
        expect(Math.abs(length), at).toBeLessThanOrEqual(options.maxLag);
        expect(Math.abs(lag), at).toBeLessThanOrEqual(options.maxLag);
        expect(rms, at).toBeLessThan(0.002);
      } else if (options.resampled) {
        expect(Math.abs(length), at).toBeLessThanOrEqual(1);
        expect(Math.abs(lag), at).toBeLessThanOrEqual(1);
        expect(rms, at).toBeLessThan(0.01);
      } else {
        expect(length, at).toBe(0);
        expect(lag, at).toBe(0);
        if (options.lossless) expect(rms, at).toBe(0);
        else expect(rms, at).toBeLessThan(0.002);
      }
    }
  }

  test.each(audioFiles)('$file', async ({ file, lossless }) => {
    const { driver, track, pcm: reference } = await decodeFile(`audio/${file}`);
    await expectPreciseSeeks(driver, reference, {
      resampled: track.sampleRate !== 48_000,
      lossless,
    });
  });

  /**
   * 影片容器內的音軌。Matroska／WebM 的時間戳以 ms 為單位，封包的位置本身就有 ±0.5 ms 的捨入，從頭解碼與 seek 後
   * 各自取整：容許 1 ms（48 sample）。
   */
  test.each([
    ['video/h264-aac.mp4', 1, 0],
    ['video/h264-mp3.avi', 1, 0],
    ['video/vp9-opus.webm', 1, 48],
    ['video/multi-track.mkv', 1, 48],
    ['video/multi-track.mkv', 2, 48],
  ])('影片容器 %s 的 stream %i', async (file, stream, maxLag) => {
    const driver = await WorkerDriver.init(inPage());
    await driver.load({ kind: 'bytes', data: await mediaBytes(file) });
    const reference = await driver.decode(stream);
    await expectPreciseSeeks(driver, reference, { resampled: false, lossless: false, maxLag });
  });
});

describe('seek 與讀取中止', () => {
  /**
   * 包住一份 bytes 的來源；`stallNext()` 之後的下一個讀取掛起，直到被中止。用 PCM 的 WAV（約 1.9 MB）：
   * 每 256 KB（約 1.4 秒）讀一次，開檔的 probe 會先讀進約 5 秒。
   */
  function stallableSource(data: Uint8Array) {
    const stalled: AbortSignal[] = [];
    let stall = false;
    const source: ByteSource = {
      size: data.length,
      read: (offset, length, signal) => {
        if (!stall) return Promise.resolve(data.subarray(offset, offset + length));
        stall = false;
        stalled.push(signal);
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(signal.reason as Error);
          });
        });
      },
    };
    return {
      stalled,
      stallNext: () => {
        stall = true;
      },
      driver: () =>
        WorkerDriver.init(inPage({ openSource: () => Promise.resolve(source) })).then(
          async (driver) => {
            await driver.load({ kind: 'http', url: 'stallable' });
            return driver;
          },
        ),
    };
  }

  /** 從 `time` 到結尾的 beep 起點：每整秒一個（門檻在 beep 開始後第 2 個 sample 越過）。精準度見「精準 seek」。 */
  function expectBeepsFrom(pcm: DecodedPcm, time: number): void {
    const expected = beeps.filter((b) => b >= time).map((b) => b - time);
    const onsets = beepOnsets(pcm.left, 48_000);
    expect(onsets).toHaveLength(expected.length);
    onsets.forEach((onset, i) => {
      expect(Math.abs(onset - (expected[i] ?? NaN))).toBeLessThanOrEqual(3 / 48_000);
    });
  }

  test('供料中讀取掛起時 seek：讀取被中止，seek 之後照常供料到結尾', async () => {
    const media = stallableSource(new Uint8Array(await mediaBytes('audio/pcm-s16.wav')));
    const driver = await media.driver();
    await driver.decode(0, { frames: 4096 });

    media.stallNext();
    // 開檔時 probe 已經讀進約 5 秒的封包，之後的讀取才會掛起。
    driver.need(1, 48_000 * 8);
    await expect.poll(() => media.stalled.length).toBe(1);
    const pcm = await driver.seek(2.5, 2);

    expect(media.stalled[0]?.aborted).toBe(true);
    expect(pcm.time).toBe(2.5);
    expect(pcm.left.length).toBe(7.5 * 48_000);
    expectBeepsFrom(pcm, 2.5);
    expect(driver.messages.filter((m) => m.type === 'error' || m.type === 'crash')).toEqual([]);
  });

  test('seek 本身的讀取掛起時再 seek：舊的 seek 被中止，只輸出最後一個 epoch', async () => {
    const media = stallableSource(new Uint8Array(await mediaBytes('audio/pcm-s16.wav')));
    const driver = await media.driver();
    await driver.decode(0);

    media.stallNext();
    driver.post({ type: 'seek', epoch: 2, time: 1.5 });
    driver.need(2, 48_000);
    await expect.poll(() => media.stalled.length).toBe(1);
    const sent = driver.worklet.length;
    const pcm = await driver.seek(3.25, 3);

    expect(media.stalled[0]?.aborted).toBe(true);
    expect(driver.worklet.slice(sent).every((m) => m.epoch === 3)).toBe(true);
    expect(pcm.time).toBe(3.25);
    expectBeepsFrom(pcm, 3.25);
    expect(driver.messages.filter((m) => m.type === 'error' || m.type === 'crash')).toEqual([]);
  });

  test('連續 seek 數十次後 Worker 沒有卡住：最後一個 seek 照常輸出到結尾', async () => {
    const media = stallableSource(new Uint8Array(await mediaBytes('audio/pcm-s16.wav')));
    const driver = await media.driver();
    await driver.decode(0, { frames: 4096 });

    for (let epoch = 2; epoch < 52; epoch++) {
      if (epoch % 7 === 0) media.stallNext();
      driver.post({ type: 'seek', epoch, time: (epoch * 0.37) % 9 });
      driver.need(epoch, 8192);
      // 有的 seek 在 Worker 開始處理之前就被取代，有的在供料中被取代。
      if (epoch % 3 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const pcm = await driver.seek(4, 52);

    expect(pcm.time).toBe(4);
    expect(pcm.left.length).toBe(6 * 48_000);
    expectBeepsFrom(pcm, 4);
    expect(media.stalled.length).toBeGreaterThan(0);
    expect(media.stalled.every((signal) => signal.aborted)).toBe(true);
    expect(driver.messages.filter((m) => m.type === 'error' || m.type === 'crash')).toEqual([]);
    expect(await driver.stats()).toEqual({ libavInstances: 1 });
  });

  test('EOF 之後 seek：從新的位置播到結尾', async () => {
    const driver = await WorkerDriver.init(inPage());
    await driver.load({ kind: 'bytes', data: await mediaBytes('audio/opus.opus') });
    await driver.decode(0);
    const pcm = await driver.seek(8, 2);
    expect(pcm.time).toBe(8);
    expect(pcm.left.length).toBe(2 * 48_000);
    expect(driver.worklet.at(-1)).toEqual({ type: 'eof', epoch: 2 });
  });

  test('不輸出音軌時，seek 也立即送出這個 epoch 的 EOF', async () => {
    const driver = await WorkerDriver.init(inPage());
    await driver.load({ kind: 'bytes', data: await mediaBytes('audio/flac.flac') });
    await driver.decode(null);
    const pcm = await driver.seek(3, 2);
    expect(pcm.chunks).toEqual([]);
    expect(driver.worklet.at(-1)).toEqual({ type: 'eof', epoch: 2 });
  });
});

describe('壞檔', () => {
  test('截斷的 MP3 播到資料結尾後送出 EOF', async () => {
    const { pcm, driver } = await decodeFile('broken/truncated.mp3');
    expect(pcm.left.length / 48_000).toBeCloseTo(5, 0);
    expect(driver.messages.filter((m) => m.type === 'error')).toEqual([]);
  });

  test('截斷的 MP4 播到資料結尾後送出 EOF', async () => {
    const { pcm } = await decodeFile('broken/truncated.mp4');
    expect(pcm.left.length / 48_000).toBeGreaterThan(3);
    expect(pcm.left.length / 48_000).toBeLessThan(6);
  });

  test('壞封包補靜音後繼續播放到結尾', async () => {
    const { pcm, driver } = await decodeFile('broken/bad-packets.mp3');
    expect(driver.messages.filter((m) => m.type === 'error')).toEqual([]);
    // 損毀範圍（4–6 秒）之前的 beep 位置不變，之後照常播到結尾。MP3 demuxer 跳過壞的 frame 時時間戳少算了
    // 那些 frame，所以之後的位置會往前偏，長度也略短（FFmpeg 本身的行為）。
    const onsets = beepOnsets(pcm.left, 48_000);
    expect(onsets.slice(0, 4).map((t) => Math.round(t * 1000) / 1000)).toEqual([0, 1, 2, 3]);
    expect(onsets.filter((t) => t > 6.5).length).toBeGreaterThanOrEqual(2);
    expect(Math.abs(pcm.left.length / 48_000 - SECONDS)).toBeLessThan(0.5);
  });

  test('影片封包損毀的 MKV 音訊照常播放', async () => {
    const { pcm } = await decodeFile('broken/bad-packets.mkv');
    expect(Math.abs(pcm.left.length / 48_000 - SECONDS)).toBeLessThan(0.05);
  });

  test.each([
    ['broken/fake-ext-flac.mp3', 'flac'],
    ['broken/fake-ext-webm.mp4', 'opus'],
  ])('假副檔名的 %s 依內容辨識（%s）', async (file, codec) => {
    const { track, pcm } = await decodeFile(file);
    expect(track.codec).toBe(codec);
    expect(Math.abs(pcm.left.length / 48_000 - SECONDS)).toBeLessThan(0.05);
  });

  test('無法辨識的內容為 FORMAT_UNSUPPORTED，並丟掉 instance', async () => {
    const driver = await WorkerDriver.init(inPage());
    const garbage = Uint8Array.from({ length: 4096 }, (_, i) => (i * 7919) % 251);
    await expect(driver.load({ kind: 'bytes', data: garbage })).rejects.toMatchObject({
      code: 'FORMAT_UNSUPPORTED',
      fatal: true,
    });
    expect(await driver.stats()).toEqual({ libavInstances: 0 });
  });

  test('沒有可以播放的軌為 CODEC_UNSUPPORTED', async () => {
    const driver = await WorkerDriver.init(inPage());
    // MS ADPCM 的 WAV：demuxer 認得，wasm 沒有它的 decoder。
    const data = beepWav({ sampleRate: 48_000, channels: 2, seconds: 1, formatTag: 2 });
    await expect(driver.load({ kind: 'bytes', data })).rejects.toMatchObject({
      code: 'CODEC_UNSUPPORTED',
      fatal: true,
    });
    expect(await driver.stats()).toEqual({ libavInstances: 0 });
  });
});

describe('中止與 instance', () => {
  /** 讀取一律掛起，直到被中止。 */
  function stallingSource(): { source: ByteSource; reads: AbortSignal[] } {
    const reads: AbortSignal[] = [];
    return {
      reads,
      source: {
        size: 1_000_000,
        read: (_offset, _length, signal) => {
          reads.push(signal);
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              reject(signal.reason as Error);
            });
          });
        },
      },
    };
  }

  test('open 中被新的 load 取代：讀取被中止、instance 被丟棄，新的 load 照常完成', async () => {
    const stalled = stallingSource();
    const flac = await mediaBytes('audio/flac.flac');
    const driver = await WorkerDriver.init(
      inPage({
        openSource: (wire, signal) =>
          wire.kind === 'http'
            ? Promise.resolve(stalled.source)
            : import('./source.js').then((m) => m.openSource(wire, signal)),
      }),
    );
    driver.post({ type: 'load', epoch: 1, source: { kind: 'http', url: 'stall' } });
    await expect.poll(() => stalled.reads.length).toBe(1);
    expect(await driver.stats()).toEqual({ libavInstances: 1 });

    const media = await driver.load({ kind: 'bytes', data: flac }, 2);
    expect(stalled.reads[0]?.aborted).toBe(true);
    expect(audioTracks(media)).toHaveLength(1);
    expect(await driver.stats()).toEqual({ libavInstances: 1 });
    // 被取代的 load 不回報任何東西。
    expect(driver.messages.filter((m) => 'epoch' in m && m.epoch === 1)).toEqual([]);
    const pcm = await driver.decode(0, { epoch: 2 });
    expect(pcm.left.length).toBe(SECONDS * 48_000);
  });

  test('輸出中被新的 load 取代：舊的 epoch 不再送資料', async () => {
    const driver = await WorkerDriver.init(inPage());
    await driver.load({ kind: 'bytes', data: await mediaBytes('audio/flac.flac') });
    await driver.decode(0, { frames: 4096 });
    await driver.load({ kind: 'bytes', data: await mediaBytes('audio/opus.opus') }, 2);
    const sent = driver.worklet.length;
    driver.need(1, 100_000);
    const pcm = await driver.decode(0, { epoch: 2, frames: 8192 });
    expect(pcm.chunks.every((c) => c.epoch === 2)).toBe(true);
    expect(driver.worklet.slice(sent).every((m) => m.epoch === 2)).toBe(true);
    expect(await driver.stats()).toEqual({ libavInstances: 1 });
  });
});

describe('建立 libav instance 失敗', () => {
  test.each([
    ['LinkError', 'a', 'kikoeru_missing'],
    ['TypeError', 'kikoeru', 'missing'],
  ])('imports 不符（%s）為 ASSET_LOAD_FAILED，並丟掉 instance', async (_, module, field) => {
    const driver = await WorkerDriver.init(inPage(), {
      module: importOnlyWasm(module, field),
    });
    const data = await mediaBytes('audio/flac.flac');
    await expect(driver.load({ kind: 'bytes', data })).rejects.toMatchObject({
      code: 'ASSET_LOAD_FAILED',
      fatal: true,
    });
    expect(await driver.stats()).toEqual({ libavInstances: 0 });
  });

  test('配置不到記憶體為 MEMORY_LIMIT；Worker 之後的 load 照常完成', async () => {
    let failures = 1;
    const driver = await WorkerDriver.init(
      inPage({
        instantiate: (module, imports) =>
          failures-- > 0
            ? Promise.reject(new RangeError('Out of memory: Cannot allocate Wasm memory'))
            : WebAssembly.instantiate(module, imports),
      }),
    );
    const flac = await mediaBytes('audio/flac.flac');
    await expect(driver.load({ kind: 'bytes', data: flac })).rejects.toMatchObject({
      code: 'MEMORY_LIMIT',
      fatal: true,
    });
    expect(await driver.stats()).toEqual({ libavInstances: 0 });
    expect(driver.messages.filter((m) => m.type === 'crash')).toEqual([]);

    const media = await driver.load({ kind: 'bytes', data: flac }, 2);
    expect(audioTracks(media)).toHaveLength(1);
    expect(await driver.stats()).toEqual({ libavInstances: 1 });
  });
});
