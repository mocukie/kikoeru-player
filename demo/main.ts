// Demo 頁：以公開 API 操作 Engine，顯示狀態並記錄事件（docs/testing.md「實機清單」、「E2E」）。
// E2E 與實機除錯可以從 console 以 `engine` 直接使用同一個 Engine。

import { attachBackgroundPlayback, type BackgroundPlayback } from '../src/background/index.js';
import {
  createEngine,
  EngineError,
  isAbortError,
  type Engine,
  type LogEntry,
  type Source,
} from '../src/index.js';

declare global {
  var engine: Engine;
}

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
const autoplayInput = element('autoplay', HTMLInputElement);
const backgroundInput = element('background', HTMLInputElement);
const nextOnEndedInput = element('next-on-ended', HTMLInputElement);

// ───────────────────────────── 事件 log ─────────────────────────────

const logLines: string[] = [];

function log(message: string): void {
  const line = `${(performance.now() / 1000).toFixed(3)}s ${message}`;
  logLines.push(line);
  const item = document.createElement('li');
  item.textContent = line;
  logList.append(item);
  item.scrollIntoView({ block: 'nearest' });
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

/** 建立 Engine 並接上事件 log；`globalThis.engine` 指向新的 Engine。 */
function setupEngine(): void {
  const target = createEngine();
  engine = target;
  globalThis.engine = target;
  target.addEventListener('statechange', (e) => {
    log(`statechange ${e.previous} → ${e.state} paused=${String(e.paused)} reason=${e.reason}`);
  });
  target.addEventListener('durationchange', (e) => {
    log(`durationchange ${String(e.duration)}`);
  });
  target.addEventListener('trackschange', (e) => {
    log(`trackschange ${String(e.tracks.length)} 軌 selected=${JSON.stringify(e.selected)}`);
  });
  target.addEventListener('seeked', (e) => {
    log(`seeked ${e.currentTime.toFixed(3)}`);
  });
  target.addEventListener('ended', () => {
    log('ended');
  });
  target.addEventListener('error', (e) => {
    log(`error ${describeError(e.error)}`);
  });
  target.addEventListener('beforeaudiostart', (e) => {
    log(`beforeaudiostart cause=${e.cause}`);
  });
  target.addEventListener('destroy', () => {
    log('destroy');
    // 背景播放模組已經自己 detach。
    if (engine === target) background = null;
  });
  target.addEventListener('ended', () => {
    if (nextOnEndedInput.checked) playNext();
  });
  if (backgroundInput.checked) attachBackground();
}

// ───────────────────────────── 背景播放模組 ─────────────────────────────

/** 目前 Engine 上的背景播放模組；沒有 attach 時為 null。 */
let background: BackgroundPlayback | null = null;

function logBackground(entry: LogEntry): void {
  const data = entry.data ? ` ${JSON.stringify(entry.data)}` : '';
  log(`[${entry.scope}] ${entry.level} ${entry.message}${data}`);
}

function attachBackground(): void {
  background = attachBackgroundPlayback(engine, { log: logBackground });
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
 * 播完後接 CI 組媒體清單的下一個（實機清單的「背景接下一首」）：`ended` 時 `paused` 仍為 false，
 * 以 `load(…, { paused: false })` 接續，anchor 不中斷、不需要 gesture。
 */
function playNext(): void {
  const options = [...mediaSelect.options];
  const next = options[(mediaSelect.selectedIndex + 1) % options.length];
  if (!next) return;
  mediaSelect.value = next.value;
  const url = mediaUrl();
  command(`load ${url}（下一首，paused: false）`, () =>
    engine.load({ kind: 'http', url }, { paused: false }).then((info) => info.format),
  );
}

setupEngine();

// ───────────────────────────── 操作 ─────────────────────────────

/** 本機檔案 → URL → CI 組媒體，依序取第一個有值的。 */
function selectedSource(): { name: string; source: Source } {
  const file = fileInput.files?.[0];
  if (file) return { name: file.name, source: { kind: 'blob', blob: file } };
  const url = urlInput.value.trim() || mediaUrl();
  return { name: url, source: { kind: 'http', url } };
}

let loadSeq = 0;

/**
 * CI 組媒體的 URL，加上選擇的故障參數（test/server/faults.ts）。每次 load 帶一個新的 `id`，故障的請求計數
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
  const { name, source } = selectedSource();
  const paused = !autoplayInput.checked;
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
element('recreate', HTMLElement).addEventListener('click', () => {
  // 沒有 destroy 的舊 Engine 先 destroy，避免留著它的 Worker 與 AudioContext。
  const previous = engine;
  command('destroy（舊的 Engine）', () => previous.destroy());
  setupEngine();
  engine.volume = Number(volumeInput.value);
  engine.muted = mutedInput.checked;
  log('建立新的 Engine');
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
const resourcesText = element('resources', HTMLElement);
const backgroundText = element('background-state', HTMLElement);

// getStats() 是非同步的：每秒取一次 ring 水位、underrun、輸出延遲（實機檢查藍牙延遲用）與存活的資源數。
setInterval(() => {
  engine.getStats().then(
    ({ audio, resources }) => {
      audioStatsText.textContent =
        `ring ${audio.ringMs.toFixed(0)} ms／target ${String(audio.targetMs)} ms，` +
        `underruns ${String(audio.underruns)}，outputLatency ${audio.outputLatencyMs.toFixed(1)} ms`;
      resourcesText.textContent =
        `workers ${String(resources.workers)}，libavInstances ${String(resources.libavInstances)}，` +
        `openVideoFrames ${String(resources.openVideoFrames)}`;
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
