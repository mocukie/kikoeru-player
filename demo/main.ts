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
} from '../src/index.js';

declare global {
  var engine: Engine;
}

/**
 * 頁面 URL 的 query 可以覆蓋部分 `EngineOptions`，供 E2E 與實機測試製造網路不足的情況：
 * `readahead`（`limits.readaheadSeconds`）、`cacheMiB`（`limits.cacheBytes`，MiB）、`stallTimeout`、
 * `stallAttempts`。例如 `/demo/?readahead=1&stallTimeout=3000`。log 等級由頁面上的選單決定（query `logLevel`
 * 給初始值）。
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
  return {
    limits: {
      ...(readaheadSeconds !== undefined && { readaheadSeconds }),
      ...(cacheMiB !== undefined && { cacheBytes: cacheMiB * 1024 * 1024 }),
    },
    ...(stallTimeout !== undefined && { stallTimeout }),
    ...(stallAttempts !== undefined && { stallAttempts }),
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
  const target = createEngine({ ...options, ...logOptions() });
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

/** URL 路徑的最後一段（解碼後）；沒有時用整個 URL。 */
function fileName(url: string): string {
  const name = new URL(url, location.href).pathname.split('/').pop();
  return name ? decodeURIComponent(name) : url;
}

setupEngine();

// ───────────────────────────── 操作 ─────────────────────────────

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
  mediaTitle = title;
  command(`load ${name}${paused ? '' : '（paused: false）'}`, () =>
    engine.load(source, { paused }).then((info) => info.format),
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
        `bufferAhead ${bufferAhead.toFixed(1)} s，封包佇列 ${packetQueue.audioSeconds.toFixed(1)} s`;
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
  durationText.textContent = String(engine.duration);
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
