// Demo 頁：以公開 API 操作 Engine，顯示狀態並記錄事件（docs/testing.md「實機清單」、「E2E」）。
// E2E 與實機除錯可以從 console 以 `engine` 直接使用同一個 Engine。

import { attachBackgroundPlayback, type BackgroundPlayback } from '../src/background/index.js';
import {
  createEngine,
  EngineError,
  isAbortError,
  type Engine,
  type EngineOptions,
  type LogEntry,
  type LogLevel,
  type Source,
  type SubtitleCue,
  type Track,
  type TrackKind,
  type TrackSelection,
} from '../src/index.js';

declare global {
  var engine: Engine;
}

/**
 * 頁面 URL 的 query 可以覆蓋部分 `EngineOptions`，供 E2E 與實機測試製造網路不足的情況：
 * `readahead`（`limits.readaheadSeconds`）、`cacheMiB`（`limits.cacheBytes`，MiB）、`stallTimeout`、
 * `stallAttempts`，以及 `suspendVideoWhenHidden=0`（背景時照常解碼影片）。例如 `/demo/?readahead=1&stallTimeout=3000`。
 * log 等級由頁面上的選單決定（query `logLevel` 給初始值）。
 */
function engineOptions(query: URLSearchParams): EngineOptions {
  const number = (name: string) => {
    const value = query.get(name);
    return value === null ? undefined : Number(value);
  };
  const readaheadSeconds = number('readahead');
  const cacheMiB = number('cacheMiB');
  const stallTimeout = number('stallTimeout');
  const stallAttempts = number('stallAttempts');
  const suspendVideoWhenHidden = query.get('suspendVideoWhenHidden');
  return {
    limits: {
      ...(readaheadSeconds !== undefined && { readaheadSeconds }),
      ...(cacheMiB !== undefined && { cacheBytes: cacheMiB * 1024 * 1024 }),
    },
    ...(stallTimeout !== undefined && { stallTimeout }),
    ...(stallAttempts !== undefined && { stallAttempts }),
    ...(suspendVideoWhenHidden !== null && {
      suspendVideoWhenHidden: suspendVideoWhenHidden !== '0',
    }),
  };
}

const options = engineOptions(new URLSearchParams(location.search));
/** 目前的 Engine；destroy 之後以「建立新的 Engine」換一個新的（E2E 的 leak 測試也用它）。 */
let engine: Engine;

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`找不到 #${id}`);
  return found;
}

const mediaSelect = element('media', HTMLSelectElement);
const faultSelect = element('fault', HTMLSelectElement);
const faultInput = element('fault-custom', HTMLInputElement);
const urlInput = element('url', HTMLInputElement);
const fileInput = element('file', HTMLInputElement);
const logList = element('log', HTMLOListElement);
const logLevelSelect = element('log-level', HTMLSelectElement);
const initialLogLevel = new URLSearchParams(location.search).get('logLevel');
if (initialLogLevel && [...logLevelSelect.options].some((o) => o.value === initialLogLevel)) {
  logLevelSelect.value = initialLogLevel;
}
const autoplayInput = element('autoplay', HTMLInputElement);
const backgroundInput = element('background', HTMLInputElement);
// 背景播放模組預設 attach（App 的典型用法）；query `background=0` 時不 attach，只測 Engine 本身的 E2E 用。
backgroundInput.checked = new URLSearchParams(location.search).get('background') !== '0';
const mediaSessionInput = element('media-session', HTMLInputElement);
// Demo 頁預設扮演 App 設定 Media Session；query `mediasession=0` 時不設定（例如驗證 Now Playing 是 AudioContext 時）。
mediaSessionInput.checked = new URLSearchParams(location.search).get('mediasession') !== '0';
const nextOnEndedInput = element('next-on-ended', HTMLInputElement);
const videoCanvas = element('video', HTMLCanvasElement);
const attachCanvasInput = element('attach-canvas', HTMLInputElement);
const subtitleLangInput = element('subtitle-lang', HTMLInputElement);
// query `subtitleLang` 給初始值（E2E 用）。
subtitleLangInput.value = new URLSearchParams(location.search).get('subtitleLang') ?? '';
element('engine-options', HTMLElement).textContent =
  `EngineOptions（由頁面 query 覆蓋）：${JSON.stringify(options)}`;

// ───────────────────────────── 事件 log ─────────────────────────────

const logLines: string[] = [];

function log(message: string): void {
  const line = `${(performance.now() / 1000).toFixed(3)}s ${message}`;
  logLines.push(line);
  const item = document.createElement('li');
  item.textContent = line;
  logList.append(item);
  // 只捲動 log 本身：scrollIntoView() 也會捲動頁面，頁面比視窗高時，按鈕會在 E2E 點下去之前被移走。
  logList.scrollTop = logList.scrollHeight;
}

// 分頁切到背景、回到前景（`suspendVideoWhenHidden` 在這時暫停、恢復影片解碼；log 等級 info 以上時有 Engine 的 log）。
document.addEventListener('visibilitychange', () => {
  log(`visibilitychange ${document.visibilityState}`);
});

element('copy-log', HTMLElement).addEventListener('click', () => {
  const text = [navigator.userAgent, ...logLines].join('\n');
  navigator.clipboard.writeText(text).then(
    () => {
      log('log 已複製');
    },
    (error: unknown) => {
      log(`無法複製 log：${String(error)}`);
    },
  );
});

function describeError(error: unknown): string {
  if (error instanceof EngineError) {
    const detail = Object.keys(error.detail).length > 0 ? ` ${JSON.stringify(error.detail)}` : '';
    return `${error.code}${error.fatal ? '（fatal）' : ''} position=${error.position.toFixed(3)}${detail}：${error.message}`;
  }
  return error instanceof Error ? `${error.name}：${error.message}` : String(error);
}

/** 指令的結果也記進 log；被取代的指令只記一行。 */
function command(name: string, run: () => Promise<unknown>): void {
  log(`→ ${name}`);
  run().then(
    (result) => {
      log(`← ${name} resolve${result === undefined ? '' : ` ${JSON.stringify(result)}`}`);
    },
    (error: unknown) => {
      log(`← ${name} ${isAbortError(error) ? '被取代' : `reject ${describeError(error)}`}`);
    },
  );
}

/** Engine 的診斷 log 記進事件 log：`[scope] level message data`。 */
function logEntry(entry: LogEntry): void {
  const data = entry.data ? ` ${JSON.stringify(entry.data)}` : '';
  log(`[${entry.scope}] ${entry.level} ${entry.message}${data}`);
}

/** 選單的 log 等級；`off` 時不設定 hook（不輸出任何 log）。Engine 與背景播放模組共用。 */
function logOptions(): Pick<EngineOptions, 'log' | 'logLevel'> {
  const level = logLevelSelect.value;
  return level === 'off' ? {} : { log: logEntry, logLevel: level as LogLevel };
}

/** 建立 Engine 並接上事件 log；`globalThis.engine` 指向新的 Engine。 */
function setupEngine(): void {
  const target = createEngine({
    ...options,
    ...logOptions(),
    canvas: attachCanvasInput.checked ? videoCanvas : null,
  });
  engine = target;
  globalThis.engine = target;
  target.addEventListener('statechange', (e) => {
    log(`statechange ${e.previous} → ${e.state} paused=${String(e.paused)} reason=${e.reason}`);
    updateMediaSession();
  });
  target.addEventListener('durationchange', (e) => {
    log(`durationchange ${String(e.duration)}`);
    updateMediaSession();
  });
  target.addEventListener('trackschange', (e) => {
    log(`trackschange ${String(e.tracks.length)} 軌 selected=${JSON.stringify(e.selected)}`);
    resetCues(e.selected.subtitle);
    renderTracks(e.tracks, e.selected);
  });
  target.addEventListener('cues', (e) => {
    const first = e.cues[0];
    const last = e.cues.at(-1);
    log(
      `cues ${e.trackId} ${String(e.cues.length)} 個` +
        (first && last ? ` [${first.start.toFixed(3)}, ${last.end.toFixed(3)}]` : ''),
    );
    addCues(e.trackId, e.cues);
  });
  target.addEventListener('videoresize', (e) => {
    log(
      `videoresize ${e.size ? `${String(e.size.width)}×${String(e.size.height)} rotation=${String(e.size.rotation)}` : 'null'}`,
    );
  });
  target.addEventListener('seeked', (e) => {
    log(`seeked ${e.currentTime.toFixed(3)}`);
    updateMediaSession();
  });
  target.addEventListener('ended', () => {
    log('ended');
  });
  target.addEventListener('error', (e) => {
    log(`error ${describeError(e.error)}`);
  });
  target.addEventListener('bufferedchange', (e) => {
    log(
      `bufferedchange ${e.buffered.map((r) => `[${r.start.toFixed(3)}, ${r.end.toFixed(3)}]`).join(' ') || '[]'}`,
    );
  });
  target.addEventListener('stall', (e) => {
    log(
      `stall position=${e.position.toFixed(3)} since=${(e.since / 1000).toFixed(3)}s，中止讀取並重新 seek`,
    );
  });
  target.addEventListener('stallrecovered', (e) => {
    log(`stallrecovered stalledMs=${e.stalledMs.toFixed(0)} attempts=${String(e.attempts)}`);
  });
  target.addEventListener('beforeaudiostart', (e) => {
    log(`beforeaudiostart cause=${e.cause}`);
  });
  target.addEventListener('destroy', () => {
    log('destroy');
    // 背景播放模組已經自己 detach。
    if (engine === target) background = null;
    // state 已是 idle，可能沒有 statechange。
    updateMediaSession();
  });
  target.addEventListener('ended', () => {
    if (nextOnEndedInput.checked) playNext();
  });
  if (backgroundInput.checked) attachBackground();
  updateMediaSession();
}

// ───────────────────────────── 軌道 ─────────────────────────────

/**
 * 列出所有軌道（包括不支援的），各 kind 一個選單：選了就 `selectTracks()`。選單顯示 `selectedTracks`（生效的值），
 * 被 reject 或被取代時回到它。E2E 以 `#select-<kind>` 的 value（track id，空字串是關閉）操作。
 */
const trackSelects = {
  audio: element('select-audio', HTMLSelectElement),
  video: element('select-video', HTMLSelectElement),
  subtitle: element('select-subtitle', HTMLSelectElement),
};
const trackList = element('track-list', HTMLUListElement);

function describeTrack(track: Track): string {
  const parts = [track.id, track.codec];
  if (track.language) parts.push(track.language);
  if (track.title) parts.push(`「${track.title}」`);
  if (track.kind === 'audio') {
    parts.push(
      `${String(track.sampleRate)} Hz ${track.channelLayout ?? `${String(track.channels)}ch`}`,
    );
    if (track.sampleFormat) parts.push(track.sampleFormat);
  }
  if (track.kind === 'video')
    parts.push(`${String(track.codedWidth)}×${String(track.codedHeight)}`);
  if (track.default) parts.push('default');
  if (track.forced) parts.push('forced');
  if (!track.supported) parts.push(`不支援（${track.unsupportedReason ?? '?'}）`);
  return parts.join(' ');
}

function renderTracks(tracks: readonly Track[], selected: Readonly<TrackSelection>): void {
  for (const kind of ['audio', 'video', 'subtitle'] as const) {
    const select = trackSelects[kind];
    select.replaceChildren(
      new Option('關閉（null）', ''),
      ...tracks.filter((t) => t.kind === kind).map((t) => new Option(describeTrack(t), t.id)),
    );
    select.value = selected[kind] ?? '';
    select.disabled = tracks.length === 0;
  }
  trackList.replaceChildren(
    ...tracks.map((track) => {
      const item = document.createElement('li');
      item.dataset.id = track.id;
      item.textContent = `${track.kind} ${describeTrack(track)}`;
      return item;
    }),
  );
}

for (const [kind, select] of Object.entries(trackSelects) as [TrackKind, HTMLSelectElement][]) {
  select.addEventListener('change', () => {
    const id = select.value === '' ? null : select.value;
    const target = engine;
    command(`selectTracks({ ${kind}: ${JSON.stringify(id)} })`, () =>
      target.selectTracks({ [kind]: id }).finally(() => {
        // reject、被取代：選單回到生效的值。
        if (engine === target) select.value = target.selectedTracks[kind] ?? '';
      }),
    );
  });
}
renderTracks([], { audio: null, video: null, subtitle: null });

// ───────────────────────────── 內嵌字幕 ─────────────────────────────

/**
 * 扮演 App 累積內嵌字幕的 cue：以 `id` 去重（seek 後可能重送），依開始時間排列；選中的字幕軌改變時清空。
 * 「目前的 cue」在 render() 內依 `currentTime` 挑選；ASS 顯示 Dialogue 行（字幕的繪製由 App 負責）。
 */
const cueStore = new Map<string, SubtitleCue>();
let cueTrack: string | null = null;
let cueRepeats = 0;
const cueLog = element('cue-log', HTMLOListElement);
const cueCountText = element('cue-count', HTMLElement);
const subtitleTrackText = element('subtitle-track', HTMLElement);
const currentCueText = element('current-cue', HTMLElement);

function cueText(cue: SubtitleCue): string {
  return 'dialogue' in cue ? cue.dialogue : cue.text;
}

function resetCues(track: string | null): void {
  if (track === cueTrack) return;
  cueTrack = track;
  cueStore.clear();
  cueRepeats = 0;
  cueLog.replaceChildren();
  updateCueCount();
}

function addCues(trackId: string, cues: readonly SubtitleCue[]): void {
  if (trackId !== cueTrack) return;
  for (const cue of cues) {
    if (cueStore.has(cue.id)) {
      cueRepeats++;
      continue;
    }
    cueStore.set(cue.id, cue);
    const item = document.createElement('li');
    item.dataset.id = cue.id;
    item.dataset.start = String(cue.start);
    item.textContent = `${cue.start.toFixed(3)}–${cue.end.toFixed(3)} ${cueText(cue)}`;
    const after = [...cueLog.children].find(
      (li) => Number((li as HTMLElement).dataset.start) > cue.start,
    );
    cueLog.insertBefore(item, after ?? null);
  }
  updateCueCount();
}

function updateCueCount(): void {
  cueCountText.textContent =
    cueTrack === null ? '—' : `${String(cueStore.size)} 個，重送 ${String(cueRepeats)} 個`;
}

function renderCues(time: number): void {
  subtitleTrackText.textContent = cueTrack ?? '—';
  const current = [...cueStore.values()]
    .filter((cue) => cue.start <= time && time < cue.end)
    .map(cueText)
    .join('\n');
  if (currentCueText.textContent !== current) currentCueText.textContent = current;
}

// ───────────────────────────── 背景播放模組 ─────────────────────────────

/** 目前 Engine 上的背景播放模組；沒有 attach 時為 null。 */
let background: BackgroundPlayback | null = null;

function attachBackground(): void {
  background = attachBackgroundPlayback(engine, logOptions());
  log('背景播放模組 attach');
}

backgroundInput.addEventListener('change', () => {
  if (backgroundInput.checked) {
    if (!background) attachBackground();
  } else if (background) {
    background.detach();
    background = null;
    log('背景播放模組 detach');
  }
});

/**
 * 播完後接目前分組的下一個媒體（實機清單的「背景接下一首」）：`ended` 時 `paused` 仍為 false，
 * 以 `load(…, { paused: false })` 接續，anchor 不中斷、不需要 gesture。
 */
function playNext(): void {
  const current = mediaSelect.selectedOptions[0];
  if (!current) return;
  const group = current.parentElement;
  if (!(group instanceof HTMLOptGroupElement)) return;
  const choices = [...group.querySelectorAll('option')];
  const next = choices[(choices.indexOf(current) + 1) % choices.length];
  if (!next) return;
  mediaSelect.value = next.value;
  const url = mediaUrl();
  mediaTitle = fileName(url);
  command(`load ${url}（下一首，paused: false）`, () =>
    engine.load({ kind: 'http', url }, { paused: false }).then((info) => info.format),
  );
}

// ───────────────────────────── Media Session ─────────────────────────────

/** 目前媒體的檔名（Media Session 的 title）；在呼叫 `load()` 之前設定，`reload()` 沿用。 */
let mediaTitle = '';

/**
 * 扮演 App 回報 Media Session 的 metadata、playbackState 與 position（ADR-0006：由 App 負責），供實機清單檢查鎖屏與
 * 通知的進度條。不設任何 action handler：鎖屏按鍵經 anchor 鏡像的行為要在沒有 handler 時驗證，handler 屬於 kikoeru。
 * position 只在 statechange、durationchange、seeked 與改變 playbackRate 時更新，之間由 OS 依速度推算。
 * 讀取目前的 `engine`，舊 Engine 的事件呼叫到也無妨。
 */
function updateMediaSession(): void {
  if (!mediaSessionInput.checked) return;
  const session = navigator.mediaSession;
  const title = engine.state === 'idle' ? null : mediaTitle;
  if ((session.metadata?.title ?? null) !== title) {
    session.metadata = title === null ? null : new MediaMetadata({ title });
  }
  session.playbackState = engine.paused ? 'paused' : 'playing';
  const duration = engine.duration;
  if (Number.isFinite(duration)) {
    // position 超出 [0, duration] 時 setPositionState() 會丟出 TypeError。
    const position = Math.min(Math.max(engine.currentTime, 0), duration);
    session.setPositionState({ duration, position, playbackRate: engine.playbackRate });
  } else {
    session.setPositionState();
  }
}

function clearMediaSession(): void {
  const session = navigator.mediaSession;
  session.metadata = null;
  session.playbackState = 'none';
  session.setPositionState();
}

mediaSessionInput.addEventListener('change', () => {
  if (mediaSessionInput.checked) {
    updateMediaSession();
    log('Media Session 開始設定');
  } else {
    clearMediaSession();
    log('Media Session 清除');
  }
});

setupEngine();

// ───────────────────────────── 操作 ─────────────────────────────

/**
 * URL 路徑的最後一段（解碼後）；沒有時用整個 URL。不是 UTF-8 的百分比編碼（例如 `%E9`）仍是可讀取的 URL，
 * 解碼失敗時保留原始片段，不讓 Media Session 的 title 擋住 load。
 */
function fileName(url: string): string {
  const name = new URL(url, location.href).pathname.split('/').pop();
  if (!name) return url;
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/** 本機檔案 → URL → 測試媒體，依序取第一個有值的。 */
function selectedSource(): { name: string; title: string; source: Source } {
  const file = fileInput.files?.[0];
  if (file) return { name: file.name, title: file.name, source: { kind: 'blob', blob: file } };
  const url = urlInput.value.trim() || mediaUrl();
  return { name: url, title: fileName(url), source: { kind: 'http', url } };
}

let loadSeq = 0;

/**
 * 測試媒體的 URL，加上選擇的故障參數（test/server/faults.ts）。每次 load 帶一個新的 `id`，故障的請求計數
 * 從頭開始；`reload()` 沿用同一個 URL，所以 `401@4` 這類只發生一次的故障在 reload 後不再出現。
 */
function mediaUrl(): string {
  const url = new URL(`/media/${mediaSelect.value}`, location.href);
  const faults = faultInput.value.trim() || faultSelect.value;
  if (faults) {
    url.search = `id=${String(Date.now())}-${String(++loadSeq)}&${faults.replace(/^\?/, '')}`;
  }
  return url.href;
}

element('load', HTMLElement).addEventListener('click', () => {
  const { name, title, source } = selectedSource();
  const paused = !autoplayInput.checked;
  const subtitle = subtitleLangInput.value
    .split(',')
    .map((lang) => lang.trim())
    .filter((lang) => lang !== '');
  mediaTitle = title;
  command(
    `load ${name}${paused ? '' : '（paused: false）'}${subtitle.length > 0 ? ` 字幕偏好 ${subtitle.join(',')}` : ''}`,
    () =>
      engine
        .load(source, { paused, ...(subtitle.length > 0 && { preferredLanguages: { subtitle } }) })
        .then((info) => info.format),
  );
});
element('play', HTMLElement).addEventListener('click', () => {
  command('play', () => engine.play());
});
element('pause', HTMLElement).addEventListener('click', () => {
  command('pause', () => engine.pause());
});
element('unlock', HTMLElement).addEventListener('click', () => {
  log('→ unlockAudio');
  engine.unlockAudio();
});
element('reload', HTMLElement).addEventListener('click', () => {
  command('reload', () => engine.reload().then((info) => info.format));
});
element('unload', HTMLElement).addEventListener('click', () => {
  command('unload', () => engine.unload());
});
element('destroy', HTMLElement).addEventListener('click', () => {
  command('destroy', () => engine.destroy());
});
/** destroy 目前的 Engine（沒有 destroy 時，避免留著它的 Worker 與 AudioContext），建立新的並沿用音量。 */
function recreateEngine(reason: string): void {
  const previous = engine;
  command('destroy（舊的 Engine）', () => previous.destroy());
  setupEngine();
  engine.volume = Number(volumeInput.value);
  engine.muted = mutedInput.checked;
  engine.playbackRate = Number(rateInput.value);
  updateMediaSession();
  log(`建立新的 Engine（${reason}）`);
}

element('recreate', HTMLElement).addEventListener('click', () => {
  recreateEngine('按鈕');
});
// logLevel 是 createEngine() 的選項：改變時換一個新的 Engine。
logLevelSelect.addEventListener('change', () => {
  recreateEngine(`logLevel ${logLevelSelect.value}`);
});

// 進度條：拖曳中只更新顯示的時間，放開（change）時才 seek；其餘時候跟著 currentTime。
const seekBar = element('seek', HTMLInputElement);
const seekTime = element('seek-time', HTMLOutputElement);
let seekDragging = false;
seekBar.addEventListener('input', () => {
  seekDragging = true;
  seekTime.value = Number(seekBar.value).toFixed(3);
});
seekBar.addEventListener('change', () => {
  seekDragging = false;
  const time = Number(seekBar.value);
  command(`seek ${time.toFixed(3)}`, () => engine.seek(time));
});
// 音量：拖曳中即時套用（Engine 以 setTargetAtTime 平滑），放開時記進 log。
const volumeInput = element('volume', HTMLInputElement);
const volumeValue = element('volume-value', HTMLOutputElement);
const mutedInput = element('muted', HTMLInputElement);
volumeInput.addEventListener('input', () => {
  engine.volume = Number(volumeInput.value);
  volumeValue.value = engine.volume.toFixed(2);
});
volumeInput.addEventListener('change', () => {
  log(`volume = ${engine.volume.toFixed(2)}`);
});
mutedInput.addEventListener('change', () => {
  engine.muted = mutedInput.checked;
  log(`muted = ${String(engine.muted)}`);
});
// 播放速度（不變調）：拖曳中即時套用，放開時記進 log；ring 內舊速度的資料播完（約 0.2 秒）才聽到新的速度。
const rateInput = element('rate', HTMLInputElement);
const rateValue = element('rate-value', HTMLOutputElement);
function applyRate(): void {
  engine.playbackRate = Number(rateInput.value);
  rateValue.value = engine.playbackRate.toFixed(2);
  updateMediaSession();
}
rateInput.addEventListener('input', applyRate);
rateInput.addEventListener('change', () => {
  log(`playbackRate = ${engine.playbackRate.toFixed(2)}`);
});
element('rate-reset', HTMLElement).addEventListener('click', () => {
  rateInput.value = '1';
  applyRate();
  log(`playbackRate = ${engine.playbackRate.toFixed(2)}`);
});

attachCanvasInput.addEventListener('change', () => {
  engine.attachCanvas(attachCanvasInput.checked ? videoCanvas : null);
  log(`attachCanvas(${attachCanvasInput.checked ? 'canvas' : 'null'})`);
});

// 選了本機檔案或填了 URL 之後，清掉另一個，避免不知道用的是哪一個。
fileInput.addEventListener('change', () => {
  urlInput.value = '';
});
urlInput.addEventListener('input', () => {
  fileInput.value = '';
});

// ───────────────────────────── 狀態 ─────────────────────────────

const stateText = element('state', HTMLElement);
const pausedText = element('paused', HTMLElement);
const unlockedText = element('audio-unlocked', HTMLElement);
const currentTimeText = element('current-time', HTMLElement);
const durationText = element('duration', HTMLElement);
const videoSizeText = element('video-size', HTMLElement);
const mediaText = element('media-info', HTMLElement);
const errorText = element('error', HTMLElement);
const audioStatsText = element('audio-stats', HTMLElement);
const bufferedText = element('buffered', HTMLElement);
const cacheStatsText = element('cache-stats', HTMLElement);
const networkStatsText = element('network-stats', HTMLElement);
const resourcesText = element('resources', HTMLElement);
const wasmVideoText = element('wasm-video-stats', HTMLElement);
const statsPanel = element('stats-panel', HTMLDetailsElement);
const statsJson = element('stats-json', HTMLElement);
const backgroundText = element('background-state', HTMLElement);

const MiB = 1024 * 1024;

// getStats() 是非同步的：每秒取一次 ring 水位、underrun、輸出延遲（實機檢查藍牙延遲用）、Range 快取、網路、
// wasm heap 與存活的資源數；展開的面板顯示完整的快照。
setInterval(() => {
  engine.getStats().then(
    (stats) => {
      const { audio, cache, network, bufferAhead, packetQueue, resources, wasmHeapBytes, video } =
        stats;
      audioStatsText.textContent =
        `ring ${audio.ringMs.toFixed(0)} ms／target ${String(audio.targetMs)} ms，` +
        `underruns ${String(audio.underruns)}，outputLatency ${audio.outputLatencyMs.toFixed(1)} ms`;
      cacheStatsText.textContent =
        `${(cache.bytes / MiB).toFixed(2)}／${(cache.limitBytes / MiB).toFixed(0)} MiB，` +
        `預讀 ${(cache.aheadBytes / MiB).toFixed(2)}／${(cache.readaheadTarget / MiB).toFixed(2)} MiB` +
        `${cache.fetching ? '（抓取中）' : ''}，hits ${String(cache.hits)}／misses ${String(cache.misses)}，` +
        `bufferAhead ${bufferAhead.toFixed(1)} s，封包佇列 音訊 ${packetQueue.audioSeconds.toFixed(1)} s` +
        `／影片 ${packetQueue.videoSeconds.toFixed(1)} s`;
      networkStatsText.textContent =
        `已讀 ${(network.bytesLoaded / MiB).toFixed(2)} MiB，進行中 ${String(network.inflight.length)} 個` +
        network.inflight
          .map((r) => ` [${String(r.start)}-${String(r.end)} ${r.elapsedMs.toFixed(0)} ms]`)
          .join('');
      resourcesText.textContent =
        `workers ${String(resources.workers)}，libavInstances ${String(resources.libavInstances)}，` +
        `openVideoFrames ${String(resources.openVideoFrames)}`;
      wasmVideoText.textContent =
        `wasm heap ${(wasmHeapBytes / MiB).toFixed(1)} MiB，封包佇列 ${(packetQueue.bytes / MiB).toFixed(2)} MiB，` +
        (video
          ? `video decoded ${String(video.decoded)}／dropped ${String(video.dropped)}，` +
            `queue ${String(video.decodeQueueSize)}，avg ${video.avgDecodeMs.toFixed(1)} ms`
          : 'video —');
      if (statsPanel.open) statsJson.textContent = JSON.stringify(stats, null, 2);
    },
    () => undefined,
  );
}, 1000);

function render(): void {
  stateText.textContent = engine.state;
  pausedText.textContent = String(engine.paused);
  unlockedText.textContent = String(engine.audioUnlocked);
  currentTimeText.textContent = engine.currentTime.toFixed(3);
  renderCues(engine.currentTime);
  durationText.textContent = String(engine.duration);
  const size = engine.videoSize;
  videoSizeText.textContent = size
    ? `${String(size.width)}×${String(size.height)} rotation=${String(size.rotation)}`
    : '—';
  bufferedText.textContent =
    engine.buffered.map((r) => `[${r.start.toFixed(1)}, ${r.end.toFixed(1)}]`).join(' ') || '—';
  const duration = engine.duration;
  seekBar.disabled = !Number.isFinite(duration);
  seekBar.max = Number.isFinite(duration) ? String(duration) : '0';
  if (!seekDragging) {
    seekBar.value = String(engine.currentTime);
    seekTime.value = engine.currentTime.toFixed(3);
  }
  errorText.textContent = engine.error ? describeError(engine.error) : '—';
  backgroundText.textContent = background ? 'attached' : 'detached';
  const media = engine.media;
  mediaText.textContent = media
    ? `${media.format}，${String(media.size)} bytes，${media.tracks
        .map((t) => `${t.id} ${t.kind} ${t.codec}${t.supported ? '' : '（不支援）'}`)
        .join('、')}`
    : '—';
  requestAnimationFrame(render);
}
render();

// ───────────────────────────── 媒體清單 ─────────────────────────────

async function listMedia(): Promise<void> {
  const response = await fetch('/media/index.json');
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  const paths = (await response.json()) as string[];
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const path of paths) {
    const dir = path.slice(0, path.indexOf('/'));
    let group = groups.get(dir);
    if (!group) {
      group = document.createElement('optgroup');
      group.label = dir;
      groups.set(dir, group);
      mediaSelect.append(group);
    }
    group.append(new Option(path, path, false, path === 'audio/flac.flac'));
  }
}

listMedia().catch((error: unknown) => {
  log(`無法取得媒體清單：${String(error)}`);
});
