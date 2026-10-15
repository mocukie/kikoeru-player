import { describe, expect, it } from 'vitest';
import type { ProbedTrack } from '../protocol/index.js';
import { selectInitialTracks, toContainerTracks } from './tracks.js';

const base = { codec: 'x', supported: true, default: false, forced: false };
const audio = (streamIndex: number, extra: Partial<ProbedTrack> = {}): ProbedTrack =>
  ({
    ...base,
    kind: 'audio',
    streamIndex,
    sampleRate: 48_000,
    channels: 2,
    ...extra,
  }) as ProbedTrack;
const video = (streamIndex: number, extra: Partial<ProbedTrack> = {}): ProbedTrack =>
  ({
    ...base,
    kind: 'video',
    streamIndex,
    codedWidth: 1920,
    codedHeight: 1080,
    display: { width: 1920, height: 1080, rotation: 0 },
    ...extra,
  }) as ProbedTrack;
const subtitle = (streamIndex: number, extra: Partial<ProbedTrack> = {}): ProbedTrack =>
  ({ ...base, kind: 'subtitle', streamIndex, format: 'ass', ...extra }) as ProbedTrack;

function tracksOf(...probed: ProbedTrack[]) {
  let seq = 0;
  return toContainerTracks(probed, () => ++seq);
}

const noPreference = { audio: [], subtitle: [] };

describe('toContainerTracks', () => {
  it('以 kind 前綴與遞增序號指派 id，音軌的 offset 為 0', () => {
    const tracks = tracksOf(audio(0), video(1), subtitle(2));
    expect(tracks.map((t) => t.id)).toEqual(['a:1', 'v:2', 's:3']);
    expect(tracks.every((t) => t.origin === 'container')).toBe(true);
    expect(tracks[0]).toMatchObject({ offset: 0 });
  });
});

describe('selectInitialTracks', () => {
  it('音軌依偏好語言 → default → 第一條，影片軌依 default → 第一條', () => {
    const tracks = tracksOf(
      audio(0, { language: 'en' }),
      audio(1, { language: 'ja', default: true }),
      audio(2, { language: 'zh-TW' }),
      video(3),
      video(4, { default: true }),
    );

    expect(selectInitialTracks(tracks, undefined, { audio: ['zh'], subtitle: [] })).toEqual({
      audio: 'a:3',
      video: 'v:5',
      subtitle: null,
    });
    expect(selectInitialTracks(tracks, undefined, noPreference).audio).toBe('a:2');
    expect(
      selectInitialTracks(
        tracks.filter((t) => !t.default),
        undefined,
        noPreference,
      ),
    ).toEqual({ audio: 'a:1', video: 'v:4', subtitle: null });
  });

  it('只從 supported 的軌中選', () => {
    const tracks = tracksOf(
      audio(0, { supported: false, default: true }),
      audio(1),
      video(2, { supported: false }),
    );
    expect(selectInitialTracks(tracks, undefined, noPreference)).toEqual({
      audio: 'a:2',
      video: null,
      subtitle: null,
    });
  });

  it('字幕只在命中偏好語言或 forced 時開啟，偏好語言優先', () => {
    const tracks = tracksOf(
      subtitle(0, { language: 'en', forced: true }),
      subtitle(1, { language: 'ja' }),
    );
    expect(selectInitialTracks(tracks, undefined, { audio: [], subtitle: ['ja'] }).subtitle).toBe(
      's:2',
    );
    expect(selectInitialTracks(tracks, undefined, noPreference).subtitle).toBe('s:1');
    expect(selectInitialTracks(tracks.slice(1), undefined, noPreference).subtitle).toBeNull();
  });

  it('指定的 kind 優先；null 表示關閉；不存在或不支援的 id 改用預設規則', () => {
    const tracks = tracksOf(
      audio(0, { default: true }),
      audio(1),
      audio(2, { supported: false }),
      video(3),
    );
    expect(selectInitialTracks(tracks, { audio: 'a:2', video: null }, noPreference)).toEqual({
      audio: 'a:2',
      video: null,
      subtitle: null,
    });
    expect(selectInitialTracks(tracks, { audio: 'a:3' }, noPreference).audio).toBe('a:1');
    expect(selectInitialTracks(tracks, { audio: 'a:99' }, noPreference).audio).toBe('a:1');
  });
});
