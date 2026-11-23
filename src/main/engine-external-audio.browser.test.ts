// 外掛音軌（#53）：真實的 AudioContext、AudioWorklet 與 media Worker。外掛來源在同一個 Worker 內的第二個 libav instance，
// 切過去之後只聽到它的聲音，移除時丟掉 instance、切回容器內的預設音軌。音軌 offset 與 currentTime 的對齊由 E2E 量測。
import { afterEach, beforeEach, expect, test } from 'vitest';
import { captureDestination, type DestinationCapture } from '../../test/audio-capture.js';
import { amplitudeAt, beepOnsets, mediaUrl } from '../../test/media-worker-harness.js';
import { createEngine } from './engine.js';
import type { Engine } from './types.js';
import { until } from '../../test/until.js';

let capture: DestinationCapture;
let engine: Engine | null = null;

beforeEach(() => {
  capture = captureDestination();
});

afterEach(async () => {
  await engine?.destroy();
  engine = null;
  capture.restore();
});

/** 從現在起錄 `seconds` 秒，回傳每個 beep 在 440 Hz 與 880 Hz 的振幅。 */
async function beepsFor(seconds: number): Promise<{ hz440: number; hz880: number }[]> {
  const from = capture.frames;
  const sampleRate = capture.context?.sampleRate ?? 48_000;
  await until(() => capture.frames > from + sampleRate * seconds);
  const after = capture.channels()[0].subarray(from);
  return beepOnsets(after, sampleRate).map((onset) => {
    const start = Math.round(onset * sampleRate) + 240;
    return {
      hz440: amplitudeAt(after, sampleRate, 440, start, 2400),
      hz880: amplitudeAt(after, sampleRate, 880, start, 2400),
    };
  });
}

test('加入外掛音軌開第二個 instance；切過去之後只聽到它（440 Hz），移除時切回容器內的音軌（880 Hz）', async () => {
  const target = (engine = createEngine());
  await target.load({ kind: 'http', url: mediaUrl('video/multi-track.mkv') }, { paused: false });
  if (target.state !== 'playing') return;
  const container = target.selectedTracks.audio;

  const track = await target.addExternalAudio(
    { kind: 'http', url: mediaUrl('video/external-audio-440.flac') },
    { label: 'dub' },
  );
  expect(track).toMatchObject({ origin: 'external', codec: 'flac', title: 'dub', offset: 0 });
  expect(target.selectedTracks.audio).toBe(container);
  expect((await target.getStats()).resources.libavInstances).toBe(2);

  await until(() => target.currentTime > 1.3);
  await target.selectTracks({ audio: track.id });
  expect(target.state).toBe('playing');
  const external = await beepsFor(2.2);
  expect(external.length).toBeGreaterThanOrEqual(2);
  for (const beep of external) {
    expect(beep.hz440).toBeGreaterThan(0.2);
    expect(beep.hz880).toBeLessThan(0.02);
  }

  await target.removeExternalAudio(track.id);
  expect(target.selectedTracks.audio).toBe(container);
  expect(target.tracks.some((t) => t.id === track.id)).toBe(false);
  expect((await target.getStats()).resources.libavInstances).toBe(1);
  const back = await beepsFor(2.2);
  expect(back.length).toBeGreaterThanOrEqual(2);
  for (const beep of back) expect(beep.hz880).toBeGreaterThan(0.2);
});

test('外掛音軌載入失敗：reject 非致命的錯誤，主媒體繼續播放', async () => {
  const target = (engine = createEngine());
  await target.load({ kind: 'http', url: mediaUrl('video/multi-track.mkv') }, { paused: false });
  if (target.state !== 'playing') return;
  await expect(
    target.addExternalAudio({ kind: 'http', url: mediaUrl('audio/missing.flac') }),
  ).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND', fatal: false });
  expect(target.state).toBe('playing');
  expect((await target.getStats()).resources.libavInstances).toBe(1);
  const at = target.currentTime;
  await until(() => target.currentTime > at + 0.3);
});
