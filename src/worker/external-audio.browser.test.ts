// 外掛音軌與音軌 offset（#53）：media Worker 為外掛來源開第二個 libav instance、以 offset 換算時間，以及兩個 instance
// 的讀取互不阻塞（各自的 Asyncify）。以協定驅動頁面內的 MediaWorker。
import { describe, expect, test } from 'vitest';
import {
  amplitudeAt,
  beepOnsets,
  type DecodedPcm,
  mediaBytes,
  peak,
  WorkerDriver,
  type WorkerEndpoint,
} from '../../test/media-worker-harness.js';
import type { WireSource, WorkerToMainMessage } from '../protocol/index.js';
import type { WorkerHost } from './host.js';
import { MediaWorker, type MediaWorkerDeps } from './media-worker.js';
import type { ByteSource } from './source.js';
import { createWebVideoDecoder } from './webcodecs.js';

function inPage(deps: Omit<MediaWorkerDeps, 'postMessage'> = {}): WorkerEndpoint {
  let listener: ((message: WorkerToMainMessage<WorkerHost>) => void) | null = null;
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

const RATE = 48_000;
/** 與 multi-track.mkv 同長（20 秒）、基準頻率 440 Hz 的 FLAC（test/media/README.md）。 */
const EXTERNAL = 'video/external-audio-440.flac';
/** multi-track.mkv：stream 0 是 H.264，stream 1 是 880 Hz 的 AAC。 */
const MAIN = 'video/multi-track.mkv';
/**
 * 兩條 FLAC 軌：stream 0 是 440 Hz（0 秒起），stream 1 是 default 的 660 Hz（12 秒起，超過 probe 範圍），
 * 容器的 start_time 是 0（test/media/README.md）。
 */
const LATE_START = 'video/external-audio-late-start.mkv';

async function bytes(path: string): Promise<WireSource<WorkerHost>> {
  return { kind: 'bytes', data: await mediaBytes(path), name: path };
}

async function withExternal(main = MAIN, deps: Omit<MediaWorkerDeps, 'postMessage'> = {}) {
  const driver = await WorkerDriver.init(inPage(deps));
  const media = await driver.load(await bytes(main));
  const track = await driver.addAudio('ext:1', await bytes(EXTERNAL));
  return { driver, media, track };
}

/** beep 起點（相對於 PCM 的開頭，秒）。門檻在 beep 開始後幾個 sample 越過。 */
function onsets(pcm: DecodedPcm): number[] {
  return beepOnsets(pcm.left, RATE);
}

/** `actual` 的每個起點與 `expected` 相差不到 5 個 sample（不經重採樣；440 Hz 的 beep 在第 4 個 sample 越過門檻）。 */
function expectOnsets(actual: number[], expected: number[]): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((onset, i) => {
    expect(Math.abs(onset - (expected[i] ?? NaN)) * RATE).toBeLessThanOrEqual(5);
  });
}

describe('addaudio', () => {
  test('為外掛來源開第二個 instance 並回覆選用的音軌；removeaudio 丟掉它', async () => {
    const { driver, track } = await withExternal();
    expect(track).toMatchObject({
      kind: 'audio',
      streamIndex: 0,
      codec: 'flac',
      supported: true,
      sampleRate: RATE,
      channels: 2,
    });
    expect((await driver.stats()).libavInstances).toBe(2);
    driver.post({ type: 'removeaudio', id: 'ext:1' });
    expect((await driver.stats()).libavInstances).toBe(1);
  });

  test('開檔失敗：回覆 audioerror、丟掉 instance，主媒體照常輸出', async () => {
    const driver = await WorkerDriver.init(inPage());
    await driver.load(await bytes('audio/flac.flac'));
    const garbage: WireSource<WorkerHost> = { kind: 'bytes', data: new Uint8Array(4096).fill(7) };
    await expect(driver.addAudio('ext:1', garbage)).rejects.toMatchObject({
      code: 'FORMAT_UNSUPPORTED',
    });
    await expect(
      driver.addAudio('ext:2', await bytes('video/video-only.mp4')),
    ).rejects.toMatchObject({ code: 'CODEC_UNSUPPORTED' });
    expect((await driver.stats()).libavInstances).toBe(1);
    const pcm = await driver.decode(0, { frames: RATE });
    expectOnsets(onsets(pcm), [0]);
    expect(driver.messages.some((m) => m.type === 'error' || m.type === 'crash')).toBe(false);
  });
});

describe('外掛音軌的輸出', () => {
  test('音訊來自外掛來源、影片來自主來源；offset 為正時起點前補靜音，beep 晚 offset 出現', async () => {
    const { driver } = await withExternal();
    driver.post({
      type: 'start',
      epoch: 1,
      time: 0,
      audio: 0,
      audioSource: 'ext:1',
      audioOffset: 0.5,
      video: 0,
      subtitle: null,
    });
    const pcm = await driver.collect(1, 3 * RATE);
    expect(pcm.time).toBeCloseTo(0, 9);
    expect(peak(pcm.left.subarray(0, 0.5 * RATE - 1))).toBe(0);
    expectOnsets(onsets(pcm).slice(0, 3), [0.5, 1.5, 2.5]);
    // 外掛音軌是 440 Hz（0 秒那一聲加倍為 880 Hz），主來源的 880 Hz 音軌沒有輸出。
    expect(amplitudeAt(pcm.left, RATE, 440, 1.5 * RATE + 480, 2400)).toBeGreaterThan(0.3);
    expect(amplitudeAt(pcm.left, RATE, 880, 1.5 * RATE + 480, 2400)).toBeLessThan(0.02);
    await expect.poll(() => driver.frames.filter((f) => f.epoch === 1).length).toBeGreaterThan(0);
    expect(driver.frames[0]?.time).toBe(0);
  });

  test('select 改 offset 並 seek：從來源的 time − offset 開始，之後的 seek 沿用外掛音軌與 offset', async () => {
    const { driver } = await withExternal();
    await driver.decode(1, { frames: 4096, video: 0 });
    driver.post({
      type: 'select',
      epoch: 2,
      time: 3.2,
      audio: 0,
      audioSource: 'ext:1',
      audioOffset: -0.3,
      video: 0,
      subtitle: null,
    });
    const selected = await driver.collect(2, 2 * RATE);
    expect(selected.time).toBe(3.2);
    // 媒體 3.2 秒是來源 3.5 秒，下一聲在來源 4 秒（媒體 3.7 秒）。
    expectOnsets(onsets(selected), [0.5, 1.5]);

    const seeked = await driver.seek(5, 3, 2 * RATE);
    // 媒體 5 秒是來源 5.3 秒，下一聲在來源 6 秒（媒體 5.7 秒）。
    expectOnsets(onsets(seeked), [0.7, 1.7]);
    expect(amplitudeAt(seeked.left, RATE, 440, 0.7 * RATE + 480, 2400)).toBeGreaterThan(0.3);
  });

  test('選外掛音軌、不選影片軌：主來源只為字幕 demux，cue 隨音訊的進度送出', async () => {
    const { driver } = await withExternal();
    // multi-track.mkv 的 stream 3 是 SRT 字幕（每整秒一個 cue）。
    driver.post({
      type: 'start',
      epoch: 1,
      time: 2,
      audio: 0,
      audioSource: 'ext:1',
      video: null,
      subtitle: 3,
    });
    const pcm = await driver.collect(1, RATE);
    expectOnsets(onsets(pcm), [0]);
    await expect.poll(() => driver.cues(1).map((c) => Math.round(c.start))).toContain(4);
    // 主來源不會一口氣 demux 到結尾：字幕只比外掛音軌的 demux 進度（約 2 秒的佇列加上一次讀取）超前一小段。
    await new Promise((resolve) => setTimeout(resolve, 300));
    const starts = driver.cues(1).map((c) => Math.round(c.start));
    expect(Math.min(...starts)).toBe(2);
    expect(Math.max(...starts)).toBeLessThan(17);
    // 音訊播到結尾時字幕也送到最後一個。
    await driver.collect(1);
    await expect.poll(() => driver.cues(1).map((c) => Math.round(c.start))).toContain(19);
  });

  test('offset 為正、背景中：影片的封包不被丟到 offset 附近，回到前景時從實際的播放位置繼續畫面', async () => {
    const { driver } = await withExternal();
    driver.post({ type: 'videosuspend', suspended: true, time: 0 });
    driver.post({
      type: 'start',
      epoch: 1,
      time: 0,
      audio: 0,
      audioSource: 'ext:1',
      audioOffset: 10,
      video: 0,
      subtitle: null,
    });
    // 起點前的 10 秒靜音只播了 2 秒。PcmQueue 一收到第一個封包就有 10 秒的靜音，外掛音軌的 lane 停在來源的 0 秒附近，
    // 以它估計播放位置會是 10 − 2 = 8 秒。
    await driver.collect(1, 2 * RATE);
    await new Promise((resolve) => setTimeout(resolve, 500));
    driver.post({ type: 'videosuspend', suspended: false, time: 2 });
    await expect.poll(() => driver.frames.filter((f) => f.epoch === 1).length).toBeGreaterThan(0);
    // 第一張是恢復位置（2 秒）的 frame，不是 8 秒附近的 keyframe。
    expect(driver.frames.find((f) => f.epoch === 1)?.time).toBeCloseTo(2, 3);
    expect(driver.messages.filter((m) => m.type === 'error' || m.type === 'crash')).toEqual([]);
  });

  test('seek 到外掛音軌的 0 點之前：從來源開頭解碼，到 0 點之前都是靜音', async () => {
    const { driver } = await withExternal();
    driver.post({
      type: 'start',
      epoch: 1,
      time: 0.2,
      audio: 0,
      audioSource: 'ext:1',
      audioOffset: 0.5,
      video: null,
      subtitle: null,
    });
    const pcm = await driver.collect(1, 2 * RATE);
    expect(pcm.time).toBe(0.2);
    expect(peak(pcm.left.subarray(0, 0.3 * RATE - 1))).toBe(0);
    // 來源 0 秒的那一聲（加倍為 880 Hz）在媒體 0.5 秒。
    expectOnsets(onsets(pcm), [0.3, 1.3]);
    expect(amplitudeAt(pcm.left, RATE, 880, 0.3 * RATE + 480, 2400)).toBeGreaterThan(0.3);
  });
});

describe('容器內音軌的 offset', () => {
  test.each([
    [0.25, [0.25, 1.25, 2.25]],
    [-0.25, [0.75, 1.75, 2.75]],
  ])('offset %f：beep 在 %j 秒', async (offset, expected) => {
    const driver = await WorkerDriver.init(inPage());
    await driver.load(await bytes('audio/flac.flac'));
    driver.post({
      type: 'start',
      epoch: 1,
      time: 0,
      audio: 0,
      audioOffset: offset,
      video: null,
      subtitle: null,
    });
    const pcm = await driver.collect(1, 3 * RATE);
    expect(pcm.time).toBeCloseTo(0, 9);
    expectOnsets(onsets(pcm), expected);
  });

  test('有影片軌時 seek：影片從 time、音訊從 time − offset 開始', async () => {
    const driver = await WorkerDriver.init(inPage());
    await driver.load(await bytes(MAIN));
    driver.post({
      type: 'start',
      epoch: 1,
      time: 4.5,
      audio: 1,
      audioOffset: 0.8,
      video: 0,
      subtitle: null,
    });
    const pcm = await driver.collect(1, 2 * RATE);
    expect(pcm.time).toBe(4.5);
    // 媒體 4.5 秒是來源 3.7 秒，下一聲在來源 4 秒（媒體 4.8 秒）。AAC 的 Matroska 時間戳容許 1 ms。
    const [first] = onsets(pcm);
    expect(Math.abs((first ?? NaN) - 0.3)).toBeLessThan(0.0015);
    const { frames } = await driver.videoDone(1);
    expect(frames[0]?.time).toBeCloseTo(4.5, 1);
  });

  test('offset 的絕對值很大、同時解碼影片：音軌另開 instance demux，封包佇列不因 offset 增長', async () => {
    // 硬上限 64 KiB：與影片共用 demuxer 時，影片的 lane 要多存 15 秒的封包，會超過上限。
    const driver = await WorkerDriver.init(inPage(), { limits: { packetQueueBytes: 64 * 1024 } });
    // 扮演影片照音訊時鐘消耗的主執行緒：frame 不 close，影片的解碼停在 frame 的上限。
    driver.autoCloseFrames = false;
    await driver.load(await bytes(MAIN));
    driver.post({
      type: 'start',
      epoch: 1,
      time: 0,
      audio: 1,
      audioOffset: -15,
      video: 0,
      subtitle: null,
    });
    // 媒體 0 秒是來源 15 秒。
    const pcm = await driver.collect(1, 2 * RATE);
    expect(pcm.time).toBe(0);
    const [first] = onsets(pcm);
    expect(Math.abs(first ?? NaN)).toBeLessThan(0.0015);
    const stats = await driver.stats();
    expect(stats.libavInstances).toBe(2);
    expect(stats.packetQueue.bytes).toBeLessThan(64 * 1024);
    await expect.poll(() => driver.frames[0]?.time).toBe(0);
    driver.releaseFrames();

    // offset 回到小的值：回到共用的 demuxer，丟掉另開的 instance。
    driver.post({
      type: 'select',
      epoch: 2,
      time: 1,
      audio: 1,
      audioOffset: 0.5,
      video: 0,
      subtitle: null,
    });
    await driver.collect(2, RATE);
    expect((await driver.stats()).libavInstances).toBe(1);
  });
});

/**
 * 包住一份 bytes 的來源：`stall()` 之後的讀取掛起，直到被中止。
 */
function stallable(data: Uint8Array) {
  let stalling = false;
  const stalled: AbortSignal[] = [];
  const source: ByteSource = {
    size: data.length,
    read: (offset, length, signal) => {
      if (!stalling) return Promise.resolve(data.subarray(offset, offset + length));
      stalled.push(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(signal.reason as Error);
        });
      });
    },
  };
  return {
    source,
    stalled,
    stall: () => {
      stalling = true;
    },
  };
}

describe('兩個 instance 的讀取互不阻塞', () => {
  async function setup() {
    const main = stallable(new Uint8Array(await mediaBytes(MAIN)));
    const external = stallable(new Uint8Array(await mediaBytes(EXTERNAL)));
    const deps = {
      openSource: (wire: WireSource<WorkerHost>) =>
        Promise.resolve(
          wire.kind === 'bytes' && wire.name === EXTERNAL ? external.source : main.source,
        ),
    };
    const { driver } = await withExternal(MAIN, deps);
    return { driver, main, external };
  }

  test('主來源的讀取掛起：外掛音軌照常供料到結尾', async () => {
    const { driver, main } = await setup();
    main.stall();
    // 從 1 秒開始：主來源要 seek，一定會再讀取（probe 已經讀進檔案的大部分）。
    driver.post({
      type: 'start',
      epoch: 1,
      time: 1,
      audio: 0,
      audioSource: 'ext:1',
      video: 0,
      subtitle: null,
    });
    const pcm = await driver.collect(1);
    expect(pcm.left.length).toBe(19 * RATE);
    expect(main.stalled.length).toBeGreaterThan(0);
    expect(main.stalled.every((s) => !s.aborted)).toBe(true);
    expect(driver.messages.some((m) => m.type === 'videoend')).toBe(false);
  });

  test('外掛來源的讀取掛起：主來源的影片照常解碼到結尾', async () => {
    const { driver, external } = await setup();
    external.stall();
    driver.post({
      type: 'start',
      epoch: 1,
      time: 0,
      audio: 0,
      audioSource: 'ext:1',
      video: 0,
      subtitle: null,
    });
    driver.need(1, 20 * RATE);
    const { end, frames } = await driver.videoDone(1);
    expect(end.type).toBe('videoend');
    expect(frames.at(-1)?.time).toBeGreaterThan(19.9);
    await expect.poll(() => external.stalled.length).toBeGreaterThan(0);
    expect(driver.worklet.some((m) => m.type === 'eof')).toBe(false);
  });
});

describe('外掛音軌在輸出中失敗', () => {
  test('讀取失敗：非致命的 audiofailed、送出 eof、丟掉 instance，主來源的影片照常解碼到結尾', async () => {
    const main = stallable(new Uint8Array(await mediaBytes(MAIN)));
    const data = new Uint8Array(await mediaBytes(EXTERNAL));
    let failing = false;
    const external: ByteSource = {
      size: data.length,
      read: (offset, length) =>
        failing
          ? Promise.reject(new Error('讀取失敗'))
          : Promise.resolve(data.subarray(offset, offset + length)),
    };
    const { driver } = await withExternal(MAIN, {
      openSource: (wire) =>
        Promise.resolve(wire.kind === 'bytes' && wire.name === EXTERNAL ? external : main.source),
    });
    failing = true;
    driver.post({
      type: 'start',
      epoch: 1,
      time: 1,
      audio: 0,
      audioSource: 'ext:1',
      video: 0,
      subtitle: null,
    });
    driver.need(1, 20 * RATE);
    expect(await driver.waitFor((m) => m.type === 'audiofailed')).toMatchObject({
      epoch: 1,
      source: 'ext:1',
      error: { fatal: false },
    });
    await expect
      .poll(() => driver.worklet.some((m) => m.type === 'eof' && m.epoch === 1))
      .toBe(true);
    const { end, frames } = await driver.videoDone(1);
    expect(end.type).toBe('videoend');
    expect(frames.at(-1)?.time).toBeGreaterThan(19.9);
    expect((await driver.stats()).libavInstances).toBe(1);
    // 之後的輸出不再有音訊。
    const seeked = await driver.seek(2, 2);
    expect(seeked.left).toHaveLength(0);
    expect(driver.messages.some((m) => m.type === 'error' || m.type === 'crash')).toBe(false);
  });
});

describe('外掛音軌的 0 點', () => {
  test('是選用的 stream 的第一個可播放 sample（不是容器的 start_time）：解碼的時間與 seek 都依它換算', async () => {
    const driver = await WorkerDriver.init(inPage());
    await driver.load(await bytes(MAIN));
    const track = await driver.addAudio('ext:1', await bytes(LATE_START));
    expect(track).toMatchObject({ streamIndex: 1, default: true });
    driver.post({
      type: 'start',
      epoch: 1,
      time: 0,
      audio: 1,
      audioSource: 'ext:1',
      video: null,
      subtitle: null,
    });
    const pcm = await driver.collect(1, 2 * RATE);
    // stream 1 的第一聲（加倍為 1320 Hz）在媒體 0 秒。
    expectOnsets(onsets(pcm).slice(0, 2), [0, 1]);
    expect(amplitudeAt(pcm.left, RATE, 1320, 480, 2400)).toBeGreaterThan(0.3);
    // 媒體 3.25 秒是 stream 的 3.25 秒（容器的 15.25 秒），下一聲在媒體 4 秒。
    const seeked = await driver.seek(3.25, 2, 2 * RATE);
    expect(seeked.time).toBe(3.25);
    expectOnsets(onsets(seeked).slice(0, 2), [0.75, 1.75]);
    expect(amplitudeAt(seeked.left, RATE, 660, 0.75 * RATE + 480, 2400)).toBeGreaterThan(0.3);
  });
});

describe('極大的有限 offset', () => {
  test.each([Number.MAX_VALUE, -Number.MAX_VALUE])(
    '外掛音軌 offset %s：不出錯，媒體範圍內都是靜音',
    async (offset) => {
      const { driver, media } = await withExternal();
      driver.post({
        type: 'start',
        epoch: 1,
        time: 0,
        audio: 0,
        audioSource: 'ext:1',
        audioOffset: offset,
        video: 0,
        subtitle: null,
      });
      // 靜音只補到媒體的長度。
      const pcm = await driver.collect(1);
      expect(pcm.left.length).toBeLessThanOrEqual(Math.round(media.duration * RATE));
      expect(peak(pcm.left)).toBe(0);
      expect(
        driver.messages.filter(
          (m) => m.type.endsWith('error') || m.type === 'crash' || m.type === 'audiofailed',
        ),
      ).toEqual([]);
    },
  );

  test.each([
    ['audio/flac.flac', 0, null],
    [MAIN, 1, 0],
  ])('容器內音軌（%s）offset ±Number.MAX_VALUE：不出錯，都是靜音', async (path, audio, video) => {
    for (const offset of [Number.MAX_VALUE, -Number.MAX_VALUE]) {
      const driver = await WorkerDriver.init(inPage());
      await driver.load(await bytes(path));
      driver.post({
        type: 'start',
        epoch: 1,
        time: 0,
        audio,
        audioOffset: offset,
        video,
        subtitle: null,
      });
      const pcm = await driver.collect(1);
      expect(peak(pcm.left)).toBe(0);
      expect(
        driver.messages.filter(
          (m) => m.type.endsWith('error') || m.type === 'crash' || m.type === 'audiofailed',
        ),
      ).toEqual([]);
    }
  });
});

describe('輸出的取代與結束', () => {
  test.each([0, 4])('改用 offset %s：中止卡住的另開 instance', async (offset) => {
    const data = new Uint8Array(await mediaBytes(MAIN));
    const stalled: AbortSignal[] = [];
    let opens = 0;
    const driver = await WorkerDriver.init(
      inPage({
        openSource: (_wire, signal) => {
          if (++opens !== 2) {
            return Promise.resolve({
              size: data.length,
              read: (offset: number, length: number) =>
                Promise.resolve(data.subarray(offset, offset + length)),
            });
          }
          // 第二次開檔（另開的 instance）卡住，也不理會 signal。
          stalled.push(signal);
          return new Promise<ByteSource>(() => undefined);
        },
      }),
    );
    await driver.load(await bytes(MAIN));
    driver.post({ type: 'start', epoch: 1, time: 0, audio: 1, video: 0, subtitle: null });
    await driver.collect(1, RATE);
    const select = { type: 'select', time: 1, audio: 1, video: 0, subtitle: null } as const;
    driver.post({ ...select, epoch: 2, audioOffset: 3 });
    await expect.poll(() => stalled.length).toBe(1);
    driver.post({ ...select, epoch: 3, audioOffset: offset });
    const pcm = await driver.collect(3, RATE);
    expect(pcm.time).toBe(1);
    expect(stalled[0]?.aborted).toBe(true);
    expect((await driver.stats()).libavInstances).toBe(offset === 0 ? 1 : 2);
  });

  test('所有軌都不選：關掉影片的 decoder、丟掉另開的 instance', async () => {
    let closed = 0;
    const driver = await WorkerDriver.init(
      inPage({
        createVideoDecoder: (init) => {
          const decoder = createWebVideoDecoder(init);
          const close = decoder.close.bind(decoder);
          decoder.close = () => {
            closed++;
            close();
          };
          return decoder;
        },
      }),
    );
    await driver.load(await bytes('video/h264-aac.mp4'));
    driver.post({
      type: 'start',
      epoch: 1,
      time: 0,
      audio: 1,
      audioOffset: 3,
      video: 0,
      subtitle: null,
    });
    await driver.collect(1, RATE);
    expect((await driver.stats()).libavInstances).toBe(2);
    driver.post({ type: 'select', epoch: 2, time: 1, audio: null, video: null, subtitle: null });
    await expect
      .poll(() => driver.worklet.some((m) => m.type === 'eof' && m.epoch === 2))
      .toBe(true);
    const stats = await driver.stats();
    expect(stats.libavInstances).toBe(1);
    expect(stats.packetQueue).toEqual({ audioSeconds: 0, videoSeconds: 0, bytes: 0 });
    expect(stats.video).toBeNull();
    expect(closed).toBe(1);
  });

  test.each([false, true])('外掛音軌、背景暫停=%s：主來源超限仍回報致命錯誤', async (suspended) => {
    const driver = await WorkerDriver.init(inPage(), { limits: { packetQueueBytes: 64 * 1024 } });
    const media = await driver.load(await bytes('video/bad-interleave.mp4'));
    const video = media.tracks.find((t) => t.kind === 'video');
    if (!video?.supported) return;
    await driver.addAudio('ext:1', await bytes(EXTERNAL));
    if (suspended) driver.post({ type: 'videosuspend', suspended: true, time: 0 });
    driver.post({
      type: 'start',
      epoch: 1,
      time: 0,
      audio: 0,
      audioSource: 'ext:1',
      video: video.streamIndex,
      subtitle: null,
    });
    // 只要開頭的一秒資料；錯誤回報不應等外掛音軌播完，也不應等影片恢復。
    driver.need(1, RATE);
    expect(await driver.waitFor((m) => m.type === 'error')).toMatchObject({
      epoch: 1,
      error: { code: 'MEMORY_LIMIT', fatal: true },
    });
  });
});
