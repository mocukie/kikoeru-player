// 公開 API 的型別測試：App 的典型用法要能通過型別檢查，誤用要被擋下（`@ts-expect-error`）。
// 只由 `pnpm typecheck` 檢查，不執行；以 kikoeru webui 的情境寫，但不依賴 Vue。

import { attachBackgroundPlayback } from '../../src/background/index.ts';
import {
  createEngine,
  EngineError,
  isAbortError,
  isEngineSupported,
  thirdPartyNotices,
  type Engine,
  type EngineStats,
  type LogHook,
  type Source,
  type SubtitleCue,
  type TimeRange,
  type Track,
  type TrackSelection,
} from '../../src/index.ts';

// ─── 1. 建立：整個 App 一個 Engine，換檔用 load() ───

if (!isEngineSupported()) showToast('這個瀏覽器無法播放');

const canvas = document.querySelector<HTMLCanvasElement>('#video');
if (canvas) canvas.style.objectFit = 'contain'; // canvas.width/height 由 Engine 設定，版面由 App 決定

const engineLog: LogHook = (e) => {
  console[e.level === 'debug' ? 'log' : e.level](`[engine:${e.scope}]`, e.message, e.data ?? '');
};

const engine: Engine = createEngine({
  canvas,
  log: engineLog,
  logLevel: 'info',
  audioBuffer: { targetMs: 200 },
  audioFadeMs: 20,
  limits: { cacheBytes: 64 * 2 ** 20 },
  assets: { glueUrl: new URL('/assets/libav.wasm.mjs', location.href) },
});

// 播放頁卸載時用同一個 AbortController 移除所有 listener。
const listeners = new AbortController();
const on = { signal: listeners.signal };

engine.addEventListener(
  'statechange',
  (e) => {
    renderPlayButton(!e.paused);
  },
  on,
);
engine.addEventListener(
  'timeupdate',
  (e) => {
    renderSeekbar(e.currentTime, engine.duration);
  },
  on,
);
engine.addEventListener(
  'bufferedchange',
  (e) => {
    renderBufferedBar(e.buffered);
  },
  on,
);
engine.addEventListener(
  'trackschange',
  (e) => {
    renderTrackMenu(e.tracks, e.selected);
  },
  on,
);
engine.addEventListener(
  'stall',
  (e) => {
    showToast(`讀取卡住（${e.position.toFixed(1)}s），正在恢復…`);
  },
  on,
);
engine.addEventListener(
  'stallrecovered',
  () => {
    hideToast();
  },
  on,
);
engine.addEventListener(
  'ended',
  () => {
    playNextInQueue();
  },
  on,
);
engine.addEventListener(
  'videoresize',
  (e) => {
    console.log(e.size?.width, e.size?.rotation);
  },
  on,
);
engine.addEventListener(
  'beforeaudiostart',
  (e) => {
    console.log(e.cause === 'unlock');
  },
  {
    once: true,
  },
);

// Media Session 的 playbackState 跟著 paused 走；鎖屏控制或系統中斷造成的暫停也會反映在這裡。
engine.addEventListener(
  'statechange',
  (e) => {
    navigator.mediaSession.playbackState = e.paused ? 'paused' : 'playing';
    if (e.reason === 'interrupted') showToast('播放被系統中斷');
  },
  on,
);

// 背景與鎖屏播放：audioSession 與靜音 anchor 交給背景播放模組。Media Session 仍由 App 負責。
const background = attachBackgroundPlayback(engine, { log: engineLog, logLevel: 'info' });

// ─── 2. 開檔並播放（使用者點了一首曲目，是 user gesture） ───

async function openWork(fileUrl: string) {
  // 在 gesture 的同步段內解鎖；之後的 await 不影響。
  engine.unlockAudio();
  try {
    const media = await engine.load(
      { kind: 'http', url: fileUrl },
      { paused: false, preferredLanguages: { audio: ['ja'], subtitle: ['zh-Hant', 'zh'] } },
    );
    document.title = `${media.format} ${formatTime(media.duration)}`;
  } catch (e) {
    if (isAbortError(e)) return; // 使用者在載入中又點了別首，這次被取代，忽略
    if (e instanceof EngineError) handleEngineError(e);
    else throw e;
  }
}

// ─── 3. 播放控制 ───

playButton.onclick = () => {
  // 被下一個 pause() 取代時 reject AbortError；App 不需要等 play() 完成。
  if (engine.paused) engine.play().catch(ignoreAbort);
  else engine.pause().catch(ignoreAbort);
};

// 拖曳進度條：每個 input 事件都 seek，Engine 只執行最後一個，前面的以 AbortError 結束。
seekbar.oninput = () => {
  engine.seek(Number(seekbar.value)).catch(ignoreAbort);
};

volumeSlider.oninput = () => {
  engine.volume = Number(volumeSlider.value); // 同步設定，不經過指令佇列
};
speedSelect.onchange = () => {
  engine.playbackRate = Number(speedSelect.value); // 0.5–2，不變調
};

// ─── 4. 切軌 ───

async function chooseAudio(trackId: string) {
  await engine.selectTracks({ audio: trackId }).catch(ignoreAbort);
}

async function audioOnly() {
  // 影片檔只聽聲音：關掉影片軌，Engine 停止讀與解碼影片封包。
  await engine.selectTracks({ video: null }).catch(ignoreAbort);
}

// ─── 5. 外掛音軌與音軌 offset（例如另一個語言的配音 flac） ───

async function useDubbedAudio(flacUrl: string) {
  const track = await engine.addExternalAudio(
    { kind: 'http', url: flacUrl },
    { label: '中文配音' },
  );
  await engine.selectTracks({ audio: track.id });
  // 配音比畫面早了 0.35 秒 → 讓聲音晚一點出現
  await engine.setAudioOffset(track.id, 0.35);
  console.log(track.origin === 'external', track.offset);
}

// ─── 6. 內嵌字幕 cue（字幕由 App 自己畫，例如交給 JASSUB） ───

const cueStore = new Map<string, SubtitleCue>();

engine.addEventListener(
  'trackschange',
  ({ tracks, selected }) => {
    const sub = tracks.find((t) => t.id === selected.subtitle);
    if (sub?.kind === 'subtitle' && sub.header) assRenderer.setHeader(sub.header);
  },
  on,
);

engine.addEventListener(
  'cues',
  ({ cues }) => {
    for (const cue of cues) {
      if (cueStore.has(cue.id)) continue; // seek 後可能重送
      cueStore.set(cue.id, cue);
      if ('dialogue' in cue) assRenderer.addEvent(cue.dialogue);
      else textRenderer.add(cue.start, cue.end, cue.text);
    }
  },
  on,
);

// ─── 7. session 失效：401 → 重新登入 → 從原位置接續 ───

function handleEngineError(error: EngineError) {
  switch (error.code) {
    case 'SOURCE_UNAUTHORIZED':
      void resumeAfterLogin(error);
      return;
    case 'CODEC_UNSUPPORTED':
      showToast(`這個瀏覽器無法播放 ${error.detail.codec ?? '此格式'}`);
      return;
    case 'AUDIO_LOCKED':
      showTapToPlayOverlay();
      return;
    case 'MEMORY_LIMIT':
      showToast('檔案太大，無法播放');
      return;
    default:
      showToast(`播放失敗：${error.code}`);
  }
}

engine.addEventListener(
  'error',
  ({ error }) => {
    // 非致命：播放中自動降級（例如影片解碼失敗、退回只播音訊），播放繼續。
    if (!error.fatal) {
      showToast('影片無法解碼，改為只播放聲音');
      return;
    }
    handleEngineError(error); // 播放途中的致命錯誤也走同一條
  },
  on,
);

async function resumeAfterLogin(error: EngineError) {
  await session.reLogin(); // App 的 session 失效流程
  // 位置、播放意圖、選軌、外掛音軌與 offset 都由 Engine 保留，原地接續。
  console.log('從', error.position, '接續');
  await engine.reload().catch(ignoreAbort);
}

// ─── 8. 診斷 ───

debugPanelButton.onclick = async () => {
  const stats: EngineStats = await engine.getStats();
  console.table({
    bufferAhead: stats.bufferAhead,
    targetMs: stats.audio.targetMs,
    dropped: stats.video?.dropped,
    cacheMiB: stats.cache.bytes / 2 ** 20,
    aheadMiB: stats.cache.aheadBytes / 2 ** 20,
    wasmMiB: stats.wasmHeapBytes / 2 ** 20,
    inflight: stats.network.inflight.length,
    workers: stats.resources.workers,
  });
};

// ─── 9. 「關於」頁 ───

function renderAbout(): string {
  return thirdPartyNotices
    .map((n) => `${n.name}（${n.license}）原始碼：${n.sourceUrl}\n${n.noticeText}`)
    .join('\n\n');
}

// ─── 10. 離開播放頁 ───

async function leavePlayerPage() {
  listeners.abort();
  background.detach();
  await engine.destroy(); // 中止讀取、終止 Worker、關閉 AudioContext；未完成的指令 AbortError
}

// ─── 11. 測試：讀記憶體中的資料，不碰網路 ───

async function testLoadFromMemory(bytes: Uint8Array) {
  const e = createEngine();
  const source: Source = { kind: 'bytes', data: bytes, name: 'sine-44100.flac' };
  const media = await e.load(source);
  console.assert(media.tracks[0]?.kind === 'audio');
  await e.destroy();
}

// ─── 誤用要被型別擋下 ───

function misuse(e: Engine) {
  // @ts-expect-error state 是唯讀的，只能經由指令改變
  e.state = 'playing';
  // @ts-expect-error 事件欄位依事件名稱帶型別
  e.addEventListener('timeupdate', (event) => event.duration);
  // @ts-expect-error 事件的欄位是唯讀的，listener 不能改寫
  e.addEventListener('statechange', (event) => (event.paused = true));
  // @ts-expect-error 沒有 'custom' 這種來源
  void e.load({ kind: 'custom', read: () => null });
  // @ts-expect-error selectTracks 的值是 track id 或 null
  void e.selectTracks({ audio: 1 });
  // @ts-expect-error EngineErrorCode 沒有 'UNKNOWN' 這個錯誤碼
  new EngineError('UNKNOWN', { fatal: true, position: 0 });
  // @ts-expect-error thirdPartyNotices 是唯讀陣列
  thirdPartyNotices[0] = { name: '', license: '', sourceUrl: '', noticeText: '' };
  // @ts-expect-error audioBuffer 的欄位是 targetMs，不是 target
  createEngine({ audioBuffer: { target: 200 } });
  // @ts-expect-error 背景播放模組的 logLevel 也只接受 LogLevel
  attachBackgroundPlayback(e, { logLevel: 'verbose' });
  // @ts-expect-error Worker 由套件以字面寫法建立，位置不能指定
  createEngine({ assets: { workerUrl: '/worker.js' } });
}

// ─── App 端的雜項（stub） ───

function ignoreAbort(e: unknown) {
  if (!isAbortError(e)) throw e;
}
declare const playButton: HTMLButtonElement;
declare const seekbar: HTMLInputElement;
declare const volumeSlider: HTMLInputElement;
declare const speedSelect: HTMLSelectElement;
declare const debugPanelButton: HTMLButtonElement;
declare const session: { reLogin(): Promise<void> };
declare const assRenderer: { setHeader(header: string): void; addEvent(dialogue: string): void };
declare const textRenderer: { add(start: number, end: number, text: string): void };
declare function renderPlayButton(playing: boolean): void;
declare function renderSeekbar(time: number, duration: number): void;
declare function renderBufferedBar(ranges: readonly TimeRange[]): void;
declare function renderTrackMenu(
  tracks: readonly Track[],
  selected: Readonly<TrackSelection>,
): void;
declare function showToast(message: string): void;
declare function hideToast(): void;
declare function showTapToPlayOverlay(): void;
declare function playNextInQueue(): void;
declare function formatTime(seconds: number): string;
export {
  openWork,
  chooseAudio,
  audioOnly,
  useDubbedAudio,
  leavePlayerPage,
  testLoadFromMemory,
  renderAbout,
  misuse,
};
