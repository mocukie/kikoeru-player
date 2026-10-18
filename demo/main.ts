// Demo 頁：以公開 API 操作 Engine，顯示狀態並記錄事件（docs/testing.md「實機清單」、「E2E」）。
// E2E 與實機除錯可以從 console 以 `engine` 直接使用同一個 Engine。

import { createEngine, EngineError, isAbortError, type Engine, type Source } from '../src/index.js';

declare global {
  var engine: Engine;
}

const engine = createEngine();
globalThis.engine = engine;

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`找不到 #${id}`);
  return found;
}

const mediaSelect = element('media', HTMLSelectElement);
const urlInput = element('url', HTMLInputElement);
const fileInput = element('file', HTMLInputElement);
const logList = element('log', HTMLOListElement);

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
    return `${error.code}${error.fatal ? '（fatal）' : ''}：${error.message}`;
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

engine.addEventListener('statechange', (e) => {
  log(`statechange ${e.previous} → ${e.state} paused=${String(e.paused)} reason=${e.reason}`);
});
engine.addEventListener('durationchange', (e) => {
  log(`durationchange ${String(e.duration)}`);
});
engine.addEventListener('trackschange', (e) => {
  log(`trackschange ${String(e.tracks.length)} 軌 selected=${JSON.stringify(e.selected)}`);
});
engine.addEventListener('seeked', (e) => {
  log(`seeked ${e.currentTime.toFixed(3)}`);
});
engine.addEventListener('ended', () => {
  log('ended');
});
engine.addEventListener('error', (e) => {
  log(`error ${describeError(e.error)}`);
});

// ───────────────────────────── 操作 ─────────────────────────────

/** 本機檔案 → URL → CI 組媒體，依序取第一個有值的。 */
function selectedSource(): { name: string; source: Source } {
  const file = fileInput.files?.[0];
  if (file) return { name: file.name, source: { kind: 'blob', blob: file } };
  const url = urlInput.value.trim() || new URL(`/media/${mediaSelect.value}`, location.href).href;
  return { name: url, source: { kind: 'http', url } };
}

element('load', HTMLElement).addEventListener('click', () => {
  const { name, source } = selectedSource();
  command(`load ${name}`, () => engine.load(source).then((info) => info.format));
});
element('play', HTMLElement).addEventListener('click', () => {
  command('play', () => engine.play());
});
element('pause', HTMLElement).addEventListener('click', () => {
  command('pause', () => engine.pause());
});
element('reload', HTMLElement).addEventListener('click', () => {
  command('reload', () => engine.reload().then((info) => info.format));
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
const currentTimeText = element('current-time', HTMLElement);
const durationText = element('duration', HTMLElement);
const mediaText = element('media-info', HTMLElement);

function render(): void {
  stateText.textContent = engine.state;
  pausedText.textContent = String(engine.paused);
  currentTimeText.textContent = engine.currentTime.toFixed(3);
  durationText.textContent = String(engine.duration);
  const duration = engine.duration;
  seekBar.disabled = !Number.isFinite(duration);
  seekBar.max = Number.isFinite(duration) ? String(duration) : '0';
  if (!seekDragging) {
    seekBar.value = String(engine.currentTime);
    seekTime.value = engine.currentTime.toFixed(3);
  }
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
