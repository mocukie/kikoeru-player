// probe 結果轉成公開的 Track，以及 load 時的初始選軌。

import type { ProbedTrack } from '../protocol/index.js';
import type { Track, TrackKind, TrackSelection } from './types.js';

const idPrefix: Record<TrackKind, string> = { audio: 'a', video: 'v', subtitle: 's' };

/** 以 Engine 內遞增的序號指派 track id（例如 `'a:1'`），跨 load 不重複。 */
export function toContainerTracks(probed: readonly ProbedTrack[], nextId: () => number): Track[] {
  return probed.map((track): Track => {
    const id = `${idPrefix[track.kind]}:${String(nextId())}`;
    return track.kind === 'audio'
      ? { ...track, id, origin: 'container', offset: 0 }
      : { ...track, id, origin: 'container' };
  });
}

/**
 * `reload()` 重新 probe 的結果與先前的容器內軌道是否同一個結構：軌道數、各軌的 kind、stream index 與 codec 相同。
 * 外掛音軌不在比較之列。
 */
export function sameTrackStructure(
  tracks: readonly Track[],
  probed: readonly ProbedTrack[],
): boolean {
  const container = tracks.filter((t) => t.origin === 'container');
  return (
    container.length === probed.length &&
    container.every((t, i) => {
      const p = probed[i];
      return p?.kind === t.kind && p.streamIndex === t.streamIndex && p.codec === t.codec;
    })
  );
}

/**
 * load 時的軌道選擇（`LoadOptions.tracks` 的 TSDoc）。`requested` 指定的 kind 優先，但只接受存在且 supported 的軌；
 * 其餘只從 supported 的軌中選：音軌依偏好語言 → default 旗標 → 第一條；影片軌依 default 旗標 → 第一條；
 * 字幕只在命中偏好語言或 forced 時開啟。
 */
export function selectInitialTracks(
  tracks: readonly Track[],
  requested: Partial<TrackSelection> | undefined,
  preferredLanguages: { audio: readonly string[]; subtitle: readonly string[] },
): TrackSelection {
  const pick = (kind: TrackKind, fallback: (candidates: Track[]) => Track | undefined) => {
    const candidates = tracks.filter((t) => t.kind === kind && t.supported);
    const wanted = requested?.[kind];
    if (wanted === null) return null;
    if (wanted !== undefined && candidates.some((t) => t.id === wanted)) return wanted;
    return fallback(candidates)?.id ?? null;
  };

  return {
    audio: pick(
      'audio',
      (c) => byLanguage(c, preferredLanguages.audio) ?? c.find((t) => t.default) ?? c[0],
    ),
    video: pick('video', (c) => c.find((t) => t.default) ?? c[0]),
    subtitle: pick(
      'subtitle',
      (c) => byLanguage(c, preferredLanguages.subtitle) ?? c.find((t) => t.forced),
    ),
  };
}

/** 依偏好語言的順序找第一條符合的軌；BCP 47 以 subtag 為界比對前綴（`zh` 符合 `zh-TW`）。 */
function byLanguage(tracks: readonly Track[], preferred: readonly string[]): Track | undefined {
  for (const language of preferred) {
    const found = tracks.find(
      (t) => t.language !== undefined && languageMatches(t.language, language),
    );
    if (found) return found;
  }
  return undefined;
}

function languageMatches(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || x.startsWith(`${y}-`) || y.startsWith(`${x}-`);
}
