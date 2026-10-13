// PROTOTYPE — App 端如何使用 engine.d.ts 的範例，用完即丟。
// 以 kikoeru webui 的情境寫，但不依賴 Vue；只為了讓 API 的手感能被看見。

import {
  createEngine,
  isAbortError,
  type Engine,
  type EngineError,
  type SubtitleCue,
  type TrackSelection,
} from './engine';

// ─── 1. 建立：整個 App 一個 Engine，換檔用 load() ───

const canvas = document.querySelector<HTMLCanvasElement>('#video')!;
canvas.style.objectFit = 'contain'; // canvas.width/height 由 Engine 設定，版面由 App 決定

const engine: Engine = createEngine({
  canvas,
  log: (e) => console[e.level === 'debug' ? 'log' : e.level](`[engine:${e.scope}]`, e.message, e.data ?? ''),
  logLevel: 'info',
});

engine.on('statechange', ({ state }) => renderPlayButton(state === 'playing' || state === 'buffering'));
engine.on('timeupdate', ({ currentTime }) => renderSeekbar(currentTime, engine.duration));
engine.on('bufferedchange', ({ buffered }) => renderBufferedBar(buffered));
engine.on('trackschange', ({ tracks, selected }) => renderTrackMenu(tracks, selected));
engine.on('stall', ({ position }) => showToast(`讀取卡住（${position.toFixed(1)}s），正在恢復…`));
engine.on('stallrecovered', () => hideToast());
engine.on('ended', () => playNextInQueue());

// ─── 2. 開檔並播放（使用者點了一首曲目，是 user gesture） ───

async function openWork(fileUrl: string) {
  // 在 gesture 的同步段內解鎖；之後的 await 不影響。
  engine.unlockAudio();
  try {
    const media = await engine.load(
      { kind: 'http', url: fileUrl },
      { paused: false, preferredLanguages: { audio: ['jpn'], subtitle: ['zho', 'chi'] } },
    );
    document.title = `${media.format} ${formatTime(media.duration)}`;
  } catch (e) {
    if (isAbortError(e)) return; // 使用者在載入中又點了別首，這次被取代，忽略
    handleEngineError(e as EngineError);
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

// ─── 5. 外掛音軌與 offset（例如另一個語言的配音 flac） ───

async function useDubbedAudio(flacUrl: string) {
  const track = await engine.addExternalAudio({ kind: 'http', url: flacUrl }, { label: '中文配音' });
  await engine.selectTracks({ audio: track.id });
  // 配音比畫面早了 0.35 秒 → 讓聲音晚一點出現
  await engine.setAudioOffset(track.id, 0.35);
}

// ─── 6. 內嵌字幕 cue（字幕由 App 自己畫，例如交給 JASSUB） ───

const cueStore = new Map<string, SubtitleCue>();

engine.on('trackschange', ({ tracks, selected }) => {
  const sub = tracks.find((t) => t.id === selected.subtitle);
  if (sub?.kind === 'subtitle' && sub.header) assRenderer.setHeader(sub.header);
});

engine.on('cues', ({ cues }) => {
  for (const cue of cues) {
    if (cueStore.has(cue.id)) continue; // seek 後可能重送
    cueStore.set(cue.id, cue);
    if ('dialogue' in cue) assRenderer.addEvent(cue.dialogue);
    else textRenderer.add(cue.start, cue.end, cue.text);
  }
});

// ─── 7. session 失效：401 → 重新登入 → 從原位置接續 ───

function handleEngineError(error: EngineError) {
  switch (error.code) {
    case 'SOURCE_UNAUTHORIZED':
      return resumeAfterLogin(error);
    case 'CODEC_UNSUPPORTED':
      return showToast(`這個瀏覽器無法播放 ${error.detail.codec ?? '此格式'}`);
    case 'AUDIO_LOCKED':
      return showTapToPlayOverlay();
    default:
      return showToast(`播放失敗：${error.code}`);
  }
}

engine.on('error', ({ error }) => handleEngineError(error)); // 播放途中的致命錯誤也走同一條

async function resumeAfterLogin(_error: EngineError) {
  await session.reLogin(); // App 的 session 失效流程
  // 位置、播放意圖、選軌、外掛音軌與 offset 都由 Engine 保留，原地接續。
  await engine.reload().catch(ignoreAbort);
}

// ─── 8. 診斷 ───

debugPanelButton.onclick = async () => {
  const stats = await engine.getStats();
  console.table({
    bufferAhead: stats.bufferAhead,
    dropped: stats.video?.dropped,
    cacheMiB: stats.cache.bytes / 2 ** 20,
    wasmMiB: stats.wasmHeapBytes / 2 ** 20,
    inflight: stats.network.inflight.length,
  });
};

// ─── 9. 離開播放頁 ───

async function leavePlayerPage() {
  await engine.destroy(); // 中止讀取、終止 Worker、關閉 AudioContext；未完成的指令 AbortError
}

// ─── 10. 測試：讀記憶體中的資料，不碰網路 ───

async function testLoadFromMemory(bytes: Uint8Array) {
  const e = createEngine();
  const media = await e.load({ kind: 'bytes', data: bytes, name: 'sine-44100.flac' });
  console.assert(media.tracks[0]?.kind === 'audio');
  await e.destroy();
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
declare function currentSource(): import('./engine').Source;
declare function renderPlayButton(playing: boolean): void;
declare function renderSeekbar(time: number, duration: number): void;
declare function renderBufferedBar(ranges: readonly import('./engine').TimeRange[]): void;
declare function renderTrackMenu(tracks: readonly import('./engine').Track[], selected: Readonly<TrackSelection>): void;
declare function showToast(message: string): void;
declare function hideToast(): void;
declare function showTapToPlayOverlay(): void;
declare function playNextInQueue(): void;
declare function formatTime(seconds: number): string;
export { openWork, chooseAudio, audioOnly, useDubbedAudio, leavePlayerPage, testLoadFromMemory };
