// media Worker 的內嵌字幕 cue（以協定驅動，MediaWorker 直接在頁面內執行）：probe 列出的字幕軌、選中的軌隨 demux
// 送出的 cue（起訖、原文、ASS 的 header 與 Dialogue 行）、seek 後重送的 cue 有相同的 id、圖形字幕不支援。
// 媒體的特徵見 test/media/README.md。
import { describe, expect, test } from 'vitest';
import { mediaBytes, WorkerDriver, type WorkerEndpoint } from '../../test/media-worker-harness.js';
import type {
  ProbedMedia,
  ProbedSubtitleTrack,
  WireAssCue,
  WireCue,
  WireTextCue,
  WorkerToMainMessage,
} from '../protocol/index.js';
import { WorkerError } from './errors.js';
import type { WorkerHost } from './host.js';
import { MediaWorker, type MediaWorkerDeps } from './media-worker.js';

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

async function open(path: string) {
  const driver = await WorkerDriver.init(inPage());
  const media = await driver.load({ kind: 'bytes', data: await mediaBytes(path) });
  return { driver, media };
}

function streamOf(media: ProbedMedia, kind: 'audio' | 'video'): number {
  const track = media.tracks.find((t) => t.kind === kind);
  if (!track) throw new Error(`沒有 ${kind} 軌`);
  return track.streamIndex;
}

function subtitles(media: ProbedMedia): ProbedSubtitleTrack[] {
  return media.tracks.filter((t): t is ProbedSubtitleTrack => t.kind === 'subtitle');
}

function subtitle(media: ProbedMedia, format: ProbedSubtitleTrack['format']): ProbedSubtitleTrack {
  const track = subtitles(media).find((t) => t.format === format);
  if (!track) throw new Error(`沒有 ${format} 字幕軌`);
  return track;
}

/**
 * 容器的時間軸與媒體時間軸差 `start_time`（AAC 的 priming 讓 Matroska 的 start_time 略小於 0），cue 與 beep、白框
 * 一起平移，所以起點只比對到 30 ms；時長則是容器記錄的 0.5 秒。
 */
const START_TOLERANCE = 0.03;

function expectSchedule(cues: readonly WireCue[], seconds: readonly number[]): void {
  expect(cues.map((c) => Math.round(c.start))).toEqual(seconds);
  for (const [i, cue] of cues.entries()) {
    expect(Math.abs(cue.start - (seconds[i] ?? NaN))).toBeLessThan(START_TOLERANCE);
    expect(cue.end - cue.start).toBeCloseTo(0.5, 6);
  }
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

/** gen-subs.py 寫進 embedded-zh.ass 的 header，Matroska 的 CodecPrivate 原樣保留。 */
const assHeader =
  '[Script Info]\nScriptType: v4.00+\nPlayResX: 640\nPlayResY: 360\n\n' +
  '[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, ' +
  'Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, ' +
  'Alignment, MarginL, MarginR, MarginV, Encoding\n' +
  'Style: Default,sans-serif,28,&H0000FF00,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,0,8,10,10,20,1\n\n' +
  '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';

describe('multi-track.mkv', () => {
  test('SRT：選中的軌送出每個 cue，文字是原文，其他字幕軌不送', async () => {
    const { driver, media } = await open('video/multi-track.mkv');
    const srt = subtitle(media, 'subrip');
    await driver.decode(streamOf(media, 'audio'), {
      video: streamOf(media, 'video'),
      subtitle: srt.streamIndex,
    });
    const cues = driver.cues(1);
    expect(cues.every((c) => c.format === 'subrip')).toBe(true);
    expectSchedule(cues, range(0, 20));
    expect((cues as WireTextCue[]).map((c) => c.text)).toEqual(
      range(0, 20).map((n) => `[embedded srt] ${String(n)}秒目、ビープ音が鳴りました。`),
    );
  });

  test('ASS：header 與 raw 和來源逐字一致，dialogue 是依 Format 重組的 Dialogue 行', async () => {
    const { driver, media } = await open('video/multi-track.mkv');
    const ass = subtitle(media, 'ass');
    expect(ass.header).toBe(assHeader);
    await driver.decode(streamOf(media, 'audio'), { subtitle: ass.streamIndex });
    const cues = driver.cues(1) as WireAssCue[];
    expectSchedule(cues, range(0, 20));
    for (const [n, cue] of cues.entries()) {
      const text = `{\\fad(50,50)}[embedded ass] 第${String(n)}秒，聽到嗶聲了。`;
      expect(cue.raw).toBe(`${String(n)},0,Default,,0,0,0,,${text}`);
      expect(cue.readOrder).toBe(n);
      // libass 依 Format 解析：Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text。
      const fields = /^Dialogue: (\d+),(\d+:\d\d:\d\d\.\d\d),(\d+:\d\d:\d\d\.\d\d),(.*)$/.exec(
        cue.dialogue,
      );
      expect(fields?.[1]).toBe('0');
      expect(parseAssTime(fields?.[2] ?? '')).toBeCloseTo(cue.start, 2);
      expect(parseAssTime(fields?.[3] ?? '')).toBeCloseTo(cue.end, 2);
      expect(fields?.[4]).toBe(`Default,,0,0,0,,${text}`);
    }
  });

  test('seek 後從新位置繼續送出 cue，重送的 cue 有相同的 id', async () => {
    const { driver, media } = await open('video/multi-track.mkv');
    const ass = subtitle(media, 'ass');
    const audio = streamOf(media, 'audio');
    await driver.decode(audio, { video: streamOf(media, 'video'), subtitle: ass.streamIndex });
    const first = new Map(driver.cues(1).map((c) => [Math.round(c.start), c.id]));

    await driver.seek(12.2, 2);
    const after = driver.cues(2);
    // 從 12.2 秒往前的 keyframe（每秒一個）開始 demux：12 秒的 cue 還在畫面上，要重新送出。
    expectSchedule(after, range(12, 20));
    for (const cue of after) expect(cue.id).toBe(first.get(Math.round(cue.start)));
  });

  test('select 換字幕軌：新 epoch 從目前位置送出新軌的 cue，舊軌不再送', async () => {
    const { driver, media } = await open('video/multi-track.mkv');
    const srt = subtitle(media, 'subrip');
    const ass = subtitle(media, 'ass');
    const audio = streamOf(media, 'audio');
    const video = streamOf(media, 'video');
    await driver.decode(audio, { video, subtitle: srt.streamIndex, frames: 48_000 });
    driver.post({ type: 'select', epoch: 2, time: 6.2, audio, video, subtitle: ass.streamIndex });
    await driver.collect(2);
    const after = driver.cues(2);
    expect(after.every((c) => c.format === 'ass')).toBe(true);
    expectSchedule(after, range(6, 20));

    // 關掉字幕：之後的 seek 也不再送。
    driver.post({ type: 'select', epoch: 3, time: 2, audio, video, subtitle: null });
    await driver.collect(3);
    await driver.seek(10, 4);
    expect(driver.cues(3)).toEqual([]);
    expect(driver.cues(4)).toEqual([]);
  });

  test('沒有選字幕軌時不送 cue', async () => {
    const { driver, media } = await open('video/multi-track.mkv');
    await driver.decode(streamOf(media, 'audio'), { video: streamOf(media, 'video') });
    expect(driver.messages.some((m) => m.type === 'cues')).toBe(false);
  });

  test('音軌與影片軌都不選、只選字幕軌：音訊立即 eof，字幕照常送出', async () => {
    const { driver, media } = await open('video/multi-track.mkv');
    const srt = subtitle(media, 'subrip');
    await driver.decode(null, { subtitle: srt.streamIndex });
    await expect.poll(() => driver.cues(1).length).toBe(20);
    expectSchedule(driver.cues(1), range(0, 20));
  });

  test('只選字幕軌時 demux 失敗：照一般的讀取錯誤回報（不當成正常結束）', async () => {
    const data = new Uint8Array(await mediaBytes('video/multi-track.mkv'));
    let failing = false;
    const driver = await WorkerDriver.init(
      inPage({
        openSource: () =>
          Promise.resolve({
            size: data.length,
            read: (offset: number, length: number) =>
              failing
                ? Promise.reject(new WorkerError('SOURCE_UNAUTHORIZED', 'HTTP 401'))
                : Promise.resolve(data.subarray(offset, offset + length)),
          }),
      }),
    );
    const media = await driver.load({ kind: 'bytes', data: data.buffer });
    failing = true;
    driver.post({
      type: 'start',
      epoch: 1,
      time: 0,
      audio: null,
      video: null,
      subtitle: subtitle(media, 'subrip').streamIndex,
    });
    expect(await driver.waitFor((m) => m.type === 'error')).toMatchObject({
      epoch: 1,
      error: { code: 'SOURCE_UNAUTHORIZED' },
    });
    expect(driver.cues(1).length).toBeLessThan(20);
  });
});

describe('其他格式', () => {
  test('subtitle-formats.mkv：WebVTT 的 cue；PGS 是圖形字幕，回報 bitmap-subtitle', async () => {
    const { driver, media } = await open('video/subtitle-formats.mkv');
    expect(subtitles(media)).toMatchObject([
      { format: 'webvtt', codec: 'webvtt', supported: true },
      {
        format: 'bitmap',
        codec: 'hdmv_pgs_subtitle',
        supported: false,
        unsupportedReason: 'bitmap-subtitle',
      },
    ]);
    await driver.decode(streamOf(media, 'audio'), {
      subtitle: subtitle(media, 'webvtt').streamIndex,
    });
    const cues = driver.cues(1) as WireTextCue[];
    expectSchedule(cues, [0, 1]);
    expect(cues.map((c) => c.text)).toEqual(['[embedded webvtt] 0', '[embedded webvtt] 1']);
  });

  test('mov-text.mp4：mov_text 的文字，清空畫面的空 sample 不是 cue', async () => {
    const { driver, media } = await open('video/mov-text.mp4');
    const track = subtitle(media, 'mov_text');
    await driver.decode(streamOf(media, 'audio'), { subtitle: track.streamIndex });
    const cues = driver.cues(1) as WireTextCue[];
    expectSchedule(cues, [0, 1]);
    expect(cues.map((c) => c.text)).toEqual(['[embedded mov_text] 0', '[embedded mov_text] 1']);
  });
});

function parseAssTime(text: string): number {
  const [h = '0', m = '0', s = '0'] = text.split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}
