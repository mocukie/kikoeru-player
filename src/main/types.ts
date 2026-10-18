// 公開 API 的型別。對外的時間一律在媒體時間軸上，單位是秒：0 是媒體第一個可播放的 sample，已扣掉容器的 start_time。

import type { EngineError } from './errors.js';
import type {
  BeforeAudioStartEvent,
  BufferedChangeEvent,
  CuesEvent,
  DurationChangeEvent,
  EngineErrorEvent,
  SeekedEvent,
  StallEvent,
  StallRecoveredEvent,
  StateChangeEvent,
  TimeUpdateEvent,
  TracksChangeEvent,
  VideoResizeEvent,
} from './events.js';

// ───────────────────────────── 建立與設定 ─────────────────────────────

/**
 * `createEngine()` 的選項。所有欄位都可省略；數值超出範圍時 `createEngine()` 丟 `RangeError`。
 *
 * 部分預設值依平台分級（iOS／iPadOS、Android、桌面）。平台在 `createEngine()` 時判斷一次，
 * `audioBuffer` 與 `limits` 共用同一個判斷。
 */
export interface EngineOptions {
  /**
   * wasm、glue、Worker 與 AudioWorklet 資產的位置。預設由套件以 `new URL(..., import.meta.url)` 解析，
   * 交給 App 的 bundler 處理。`.wasm` 與 glue 必須與頁面同源，`.wasm` 以 `Content-Type: application/wasm` 提供。
   */
  assets?: {
    wasmUrl?: string | URL;
    /** libav.js 的 glue（`libav-….wasm.mjs`），由 media Worker 以動態 import 載入，不經過 bundler。 */
    glueUrl?: string | URL;
    workerUrl?: string | URL;
    workletUrl?: string | URL;
  };
  /** 繪製影片的 canvas，也可以之後用 `attachCanvas()` 設定。 */
  canvas?: HTMLCanvasElement | null;
  /** `timeupdate` 的最小間隔（ms），必須大於 0。預設 250。 */
  timeUpdateInterval?: number;
  /**
   * 記憶體與預讀。預讀發生在 bytes 層的 Range 快取；封包佇列、影片 frame 佇列與 wasm heap 的上限
   * 都是內部常數，不在這裡設定。
   */
  limits?: {
    /**
     * Range 快取（LRU）的上限，bytes，必須大於 0。主來源與外掛音軌共用；只有 http 來源經過快取。
     * 預設：桌面 128 MiB，Android 與 iOS 64 MiB。
     */
    cacheBytes?: number;
    /**
     * 每個選用中來源的預讀目標，秒（以位元組率換算成 bytes），必須大於 0。達到目標就停止抓取，
     * 掉到一半以下才恢復；單一來源最多用掉 `cacheBytes` 的 75%。暫停、ready 與背景時也繼續預讀。預設 60。
     */
    readaheadSeconds?: number;
  };
  /**
   * 讀取失敗的自動重試：只針對 5xx 與網路錯誤，以指數退避重試；401／403／404 不重試、直接回報。
   * `attempts` 是 0 以上的整數，`baseDelayMs` 不得為負。預設 `{ attempts: 3, baseDelayMs: 500 }`。
   */
  retry?: { attempts?: number; baseDelayMs?: number };
  /**
   * 卡住偵測（ms），必須大於 0：buffering 超過這個時間就中止讀取、從目前位置重新 seek，並發出 `stall`。
   * 預設 8000。
   */
  stallTimeout?: number;
  /** 卡住後自動恢復的次數上限，0 以上的整數；用完仍卡住就以最後一次的讀取錯誤進入 `'error'`。預設 2。 */
  stallAttempts?: number;
  /** 預設的偏好語言（BCP 47），`load()` 的 `preferredLanguages` 會覆蓋。預設沒有偏好。 */
  preferredLanguages?: { audio?: string[]; subtitle?: string[] };
  /** 背景（`document.hidden`）時停止解碼影片、只播聲音，回前景時從 keyframe 重新同步。預設 true。 */
  suspendVideoWhenHidden?: boolean;
  /**
   * AudioWorklet ring buffer 的水位（ms）：低於 `refillMs` 就向 media Worker 要資料，補到 `targetMs`，
   * 最多存放 `capacityMs`。load、seek 與 underrun 之後，ring 補到 `targetMs` 才開始出聲。
   *
   * 必須 `0 < refillMs < targetMs < capacityMs`，否則丟 `RangeError`。只給部分欄位時，其餘以平台預設補上後再檢查。
   * 預設（target／refill／capacity）：桌面 150／75／400，Android 250／125／600，iOS 300／150／750。
   * 預設值會依實機量測調整。
   */
  audioBuffer?: { targetMs?: number; refillMs?: number; capacityMs?: number };
  /**
   * pause、seek、選軌與 underrun 時淡入淡出的長度（ms），範圍 0–100，超出丟 `RangeError`；0 表示硬切。預設 10。
   */
  audioFadeMs?: number;
  /** 診斷用的 log hook；未設定時 Engine 不輸出任何 log。 */
  log?: LogHook;
  /** 送進 log hook 的最低等級，預設 `'warn'`。 */
  logLevel?: LogLevel;
}

// ───────────────────────────── Engine ─────────────────────────────

/**
 * Engine 的狀態（實際狀況），與播放意圖 `paused` 分開。
 *
 * - `'idle'`：沒有載入任何媒體（初始、`unload()` 之後）。
 * - `'loading'`：`load()`／`reload()` 進行中：開檔、probe、填第一段緩衝。
 * - `'ready'`：載入完成、還沒開始播放過。
 * - `'playing'`：音訊時鐘在走。
 * - `'paused'`：使用者暫停。
 * - `'buffering'`：想播但資料不夠，時鐘停住。
 * - `'seeking'`：`seek()` 進行中，直到目標位置的 frame／sample 備妥。
 * - `'ended'`：播到結尾。`paused` 維持 false（與 `HTMLMediaElement` 不同），App 不接下一首時自己 `pause()`。
 * - `'error'`：當前媒體發生致命錯誤，見 `engine.error`；`load()` 或 `reload()` 可以重新開始。
 */
export type EngineState =
  'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'buffering' | 'seeking' | 'ended' | 'error';

/**
 * headless 播放引擎。整個 App 建立一個，換檔用 `load()`；以 `createEngine()` 建立。
 *
 * **唯讀狀態**：同步讀取主執行緒的鏡像；持續變動、只存在於 media Worker 的數字放在 `getStats()`。
 * - 順序保證：指令的 Promise resolve 時，相關 getter 已是新值，對應事件也已發出。
 * - getter 顯示「已生效」的值，例如 `selectTracks()` 進行中，`selectedTracks` 仍是舊軌，新軌出聲後才更新。
 *   唯一的例外是 `paused`，它是使用者意圖。
 * - `tracks` 在 `load()` 之後只因指令或降級改變（`addExternalAudio()`、`removeExternalAudio()`、
 *   `setAudioOffset()`、`selectTracks()` 發現 codec 實際不支援、播放中影片解碼失敗而退回只播音訊）。
 *   播放中才出現的軌道只記 log、不加入。
 *
 * **指令**（`load`、`reload`、`play`、`pause`、`seek`、`selectTracks`、`addExternalAudio`、
 * `removeExternalAudio`、`setAudioOffset`、`unload`、`destroy`）一律回傳 Promise，依呼叫順序執行。
 * 被較新的指令取代時以 `DOMException`（name `'AbortError'`）reject，App 用 `isAbortError()` 判斷後忽略：
 * - `load()`／`reload()`／`unload()`／`destroy()` 取代所有尚未完成的指令。
 * - `seek()` 取代尚未完成的 `seek()`（包括執行中的，它的讀取會被中止）。
 * - `selectTracks()` 同一 kind 只保留最後一個。
 * - `play()` 與 `pause()` 互相取代。
 *
 * `volume`、`muted`、`playbackRate` 是同步屬性，不進指令佇列。
 *
 * **背景播放**（iOS 的 audio session、靜音 anchor `<audio>`）不在這裡，由選配的背景播放模組
 * `kikoeru-player/background` 處理。Engine 提供它所需的時機點與狀態：`beforeaudiostart` 事件、帶 reason 的
 * `statechange`，以及偵測 Engine 以外對 AudioContext 的 suspend／resume。
 */
export interface Engine extends EventTarget {
  // ── 唯讀狀態 ──

  /** 目前的狀態。 */
  readonly state: EngineState;
  /**
   * 使用者的播放意圖，與 `state` 分開：loading、seeking、buffering 結束後依此回到 playing 或 paused。
   * `play()` 設為 false、`pause()` 設為 true，在呼叫當下就改變，並在呼叫內同步發出 `statechange`
   * （`state` 沒變時 `state === previous`），供背景播放模組與 Media Session 跟上。
   */
  readonly paused: boolean;
  /** 目前聽到的位置（秒）。播放中依音訊時鐘內插，已扣除輸出延遲。 */
  readonly currentTime: number;
  /** 總長度（秒）；未知時為 NaN。 */
  readonly duration: number;
  /**
   * 已緩衝的範圍，依起點排序、不重疊。是估計值：http 來源最多一段，從 `currentTime` 起長 `bufferAhead` 秒，
   * 播放位置之前仍在快取中的資料不列入；`bytes`／`blob` 來源為 `[0, duration]`。
   */
  readonly buffered: readonly TimeRange[];
  /** 當前媒體的 probe 結果；idle 時為 null。 */
  readonly media: MediaInfo | null;
  /** 當前媒體的所有軌道，包括不支援的軌（`supported: false`）與外掛音軌。 */
  readonly tracks: readonly Track[];
  /** 各 kind 目前生效的軌道 id，null 表示沒有選用。 */
  readonly selectedTracks: Readonly<TrackSelection>;
  /** state 為 `'error'` 時的錯誤，其他狀態為 null。 */
  readonly error: EngineError | null;
  /** 影片的顯示尺寸（已套用旋轉與 SAR）；沒有影片軌時為 null。 */
  readonly videoSize: VideoSize | null;

  // ── 同步設定（即時生效、最後一次勝出，不經過指令佇列） ──

  /** 音量 0–1，套用時有 gain ramp。 */
  volume: number;
  /** 靜音；不影響音訊時鐘。 */
  muted: boolean;
  /** 不變調的播放速度，0.5–2；超出範圍丟 `RangeError`。 */
  playbackRate: number;

  // ── 音訊解鎖 ──

  /**
   * 在 user gesture 的同步段內呼叫，建立或 resume AudioContext。`play()` 在 user gesture 內被呼叫時也會自動解鎖，
   * 所以多數 App 不需要直接呼叫。之後沒有 gesture 就 `play()` 時以 `AUDIO_LOCKED` 拒絕。
   * 建立或 resume AudioContext 之前會同步發出 `beforeaudiostart`。
   */
  unlockAudio(): void;
  /** AudioContext 是否已經解鎖。 */
  readonly audioUnlocked: boolean;

  // ── 指令 ──

  /**
   * 載入新媒體，並中止舊媒體的讀取。resolve 時 state 為 `'ready'`（`options.paused === false` 時為 `'playing'`）。
   *
   * 只要還有一條可播的音軌或影片軌就成功；不支援的軌照樣列在 `tracks`（`supported: false`），
   * 影片軌不支援或 configure 失敗時 `selectedTracks.video` 為 null、只播音訊。
   * 沒有任何可播的軌時 reject `EngineError('CODEC_UNSUPPORTED')`。其他失敗也 reject `EngineError`，
   * state 變為 `'error'`。
   */
  load(source: Source, options?: LoadOptions): Promise<MediaInfo>;

  /**
   * 以同一份媒體重新開檔，用於 session 失效等錯誤之後的接續；`'ready'` 以後的任何狀態與 `'error'` 都可呼叫。
   * 保留位置（`'error'` 時取 `error.position`）、`paused`、軌道選擇、外掛音軌、各音軌 offset、音量與速度；
   * track id 不變。重新開檔後軌道的組成（軌道數、各軌的 kind 與 codec）與先前不同時 reject 致命的
   * `EngineError('SOURCE_CHANGED')`，state 變為 `'error'`。
   *
   * 執行期間 state 為 `'loading'`，`media`、`tracks`、`selectedTracks` 維持原狀，期間的 `seek()` 改寫起點；
   * resolve 時 state 同 `load()`：`paused` 時為 `'ready'`，否則為 `'playing'`。最近一次 `load()` 沒有完成就失敗時
   *（例如 401），以同樣的來源與選項重新 load。沒有載入過媒體（state 為 `'idle'`）時以 `DOMException`
   *（name `'InvalidStateError'`）reject。
   */
  reload(): Promise<MediaInfo>;

  /**
   * 設定 `paused = false`，resolve 於 state 真正進入 `'playing'`（音訊開始輸出）。
   * 在 `'ended'` 時呼叫會從頭播放。之後若有 `pause()` 或 `load()` 先完成，reject AbortError。
   * 執行時沒有媒體（state 為 `'idle'` 或 `'error'`）則以 `DOMException`（name `'InvalidStateError'`）reject，
   * `paused` 仍然改為 false。
   *
   * 在呼叫內同步 resume AudioContext，所以在 user gesture 內呼叫時會自動解鎖。沒有 gesture 而 AudioContext
   * 無法開始時，以非致命的 `EngineError('AUDIO_LOCKED')` reject，`paused` 回到 true。
   */
  play(): Promise<void>;

  /** 設定 `paused = true`，resolve 於淡出結束、時鐘停止。 */
  pause(): Promise<void>;

  /**
   * 精準 seek（影片到 frame、音訊到 sample），resolve 實際落點（夾在 `[0, duration]`）。
   * 執行期間 state 為 `'seeking'`；完成時發出 `seeked` 並補發一次 `timeupdate`，之後依 `paused` 回到
   * `'playing'` 或 `'paused'`（還沒播放過時為 `'ready'`）。`'ended'` 時 seek 也一樣，從新的位置繼續。
   * 連續呼叫時只執行最後一個，被取代的 reject AbortError。
   * loading 期間呼叫時改寫該次 load 的起點，於 load 完成時一起 resolve。
   * `time` 不是有限數時 reject `TypeError`；執行時沒有媒體（state 為 `'idle'` 或 `'error'`）則以
   * `DOMException`（name `'InvalidStateError'`）reject。
   */
  seek(time: number): Promise<number>;

  /**
   * 播放中切換軌道，不重新載入、時間不跳。只帶要改的 kind；null 表示關閉該類軌道
   * （例如影片檔只播音訊、關掉字幕）。同一 kind 連續呼叫只保留最後一個。不改變 state。
   *
   * 選到 `supported: false` 的軌，或新軌 configure／首個 keyframe 失敗時，reject 非致命的
   * `EngineError('CODEC_UNSUPPORTED')` 並保留原本的軌；後者會把該軌改為 `supported: false` 並發出 `trackschange`。
   */
  selectTracks(selection: Partial<TrackSelection>): Promise<void>;

  /**
   * 以另一個來源加入外掛音軌，resolve 新的 `AudioTrack`（`origin: 'external'`）。
   * 不會自動選用，要用 `selectTracks({ audio: track.id })` 切過去。
   * 外掛音軌屬於當前媒體：下一次 `load()`／`unload()` 時一併移除，`reload()` 時保留。
   *
   * 載入失敗時 reject 非致命的 `EngineError`，主媒體繼續播放。
   * 每份媒體最多 4 條外掛音軌，超過時 reject 非致命的 `EngineError('MEMORY_LIMIT')`。
   */
  addExternalAudio(
    source: Source,
    options?: { offset?: number; label?: string },
  ): Promise<AudioTrack>;

  /** 移除 `addExternalAudio()` 加入的外掛音軌。 */
  removeExternalAudio(trackId: string): Promise<void>;

  /**
   * 設定指定音軌的音軌 offset（秒），容器內與外掛音軌都適用；正值表示聲音較晚出現。
   * 每條音軌各自記住；改的是目前選中的軌時會立即重新同步（短暫 seeking）。
   */
  setAudioOffset(trackId: string, offset: number): Promise<void>;

  /** 卸載當前媒體、回到 `'idle'`，並 terminate media Worker；保留 AudioContext，供之後的 `load()` 使用。 */
  unload(): Promise<void>;

  /**
   * 立即釋放所有資源：中止讀取、關閉 decoder、terminate Worker、關閉 AudioContext。
   * 所有未完成的指令 reject AbortError，之後任何指令都 reject `EngineError('DESTROYED')`。可重複呼叫。
   * 完成後 state 為 `'idle'`、`paused` 為 true。
   */
  destroy(): Promise<void>;

  // ── 影片輸出 ──

  /**
   * 指定繪製目標；null 表示不再繪製（影片仍會解碼以維持同步，除非也關掉影片軌）。
   * Engine 會把 `canvas.width`／`height` 設為影片顯示尺寸，版面縮放由 App 用 CSS（例如 `object-fit: contain`）處理。
   */
  attachCanvas(canvas: HTMLCanvasElement | null): void;

  // ── 事件（標準 EventTarget，支援 `{ once, signal }`） ──

  /** 依 `EngineEventMap` 帶型別的 `addEventListener`。 */
  addEventListener<K extends keyof EngineEventMap>(
    type: K,
    listener: (this: Engine, event: EngineEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  /** 依 `EngineEventMap` 帶型別的 `removeEventListener`。 */
  removeEventListener<K extends keyof EngineEventMap>(
    type: K,
    listener: (this: Engine, event: EngineEventMap[K]) => unknown,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;

  // ── 診斷 ──

  /** 取一次統計快照；非同步，因為大部分數字在 media Worker 內。 */
  getStats(): Promise<EngineStats>;
}

/** `load()` 的選項。 */
export interface LoadOptions {
  /**
   * 起始位置（秒），預設 0。用於 session 失效後重新載入。夾在 `[0, duration]`，與 `seek()` 一樣精準：
   * 輸出的第一個 sample 就在這個位置。loading 期間的 `seek()` 改寫它。
   */
  startTime?: number;
  /** false 時載入完成後直接播放（等同 load 完成再 `play()`）。預設 true：停在 `'ready'`。 */
  paused?: boolean;
  /**
   * 初始的軌道選擇。未指定的 kind 只從 `supported` 的軌中選：音軌依偏好語言 → default 旗標 → 第一條；
   * 影片軌依 default 旗標 → 第一條；字幕只在 forced 或命中偏好語言時開啟。
   */
  tracks?: Partial<TrackSelection>;
  /** 偏好語言（BCP 47），覆蓋 `EngineOptions.preferredLanguages`。 */
  preferredLanguages?: { audio?: string[]; subtitle?: string[] };
  /** 外部取消；效果等同被下一個 `load()` 取代。 */
  signal?: AbortSignal;
}

// ───────────────────────────── 來源 ─────────────────────────────

/**
 * Engine 讀取位元組的對象。用可序列化的描述而不是物件，讓 Engine 能在任何執行緒重建讀取器；
 * 測試用 `'bytes'`，本機的 `File` 用 `'blob'`。
 */
export type Source = HttpSource | BytesSource | BlobSource;

/** 以 HTTP Range 分段讀取的來源。 */
export interface HttpSource {
  kind: 'http';
  url: string | URL;
  /** 預設 `'same-origin'`：同源請求自動帶 cookie。 */
  credentials?: RequestCredentials;
  /** 每個請求附帶的 header。 */
  headers?: Record<string, string>;
  /** 已知的來源大小（bytes），可省掉一次探測。 */
  size?: number;
}

/** 記憶體中的資料。 */
export interface BytesSource {
  kind: 'bytes';
  data: ArrayBuffer | Uint8Array;
  /** 用於 log 與錯誤訊息。 */
  name?: string;
}

/** `Blob`（例如本機的 `File`）。 */
export interface BlobSource {
  kind: 'blob';
  blob: Blob;
}

// ───────────────────────────── 媒體與軌道 ─────────────────────────────

/** 一次載入的 probe 結果。 */
export interface MediaInfo {
  /** libavformat 的格式名稱，例如 `'matroska,webm'`、`'mov,mp4,m4a,3gp,3g2,mj2'`、`'wav'`。 */
  format: string;
  /** 總長度（秒）；未知時為 NaN。 */
  duration: number;
  /** 主來源的大小（bytes）。 */
  size: number;
  tracks: readonly Track[];
}

/** 媒體內一條可單獨選用的音訊、影片或字幕資料。 */
export type Track = AudioTrack | VideoTrack | SubtitleTrack;
/** 軌道的種類。 */
export type TrackKind = Track['kind'];

/** 各種軌道共有的欄位。 */
export interface TrackBase {
  /** Engine 內唯一、跨 load 不重複（`reload()` 保留），例如 `'a:1'`、`'ext:3'`。 */
  id: string;
  /** `'container'`：容器內的軌道；`'external'`：`addExternalAudio()` 加入的來源。 */
  origin: 'container' | 'external';
  /** 軌道在容器內的 index（libavformat 的 stream index）；外掛音軌為其來源內的 index。 */
  streamIndex: number;
  /** FFmpeg 的 codec 名稱，例如 `'aac'`、`'flac'`、`'h264'`、`'ass'`。 */
  codec: string;
  /** WebCodecs 的 codec string（只有影片軌），例如 `'avc1.640028'`。 */
  codecString?: string;
  /** false 時無法選用，原因見 `unsupportedReason`。播放中發現實際無法解碼時會改為 false 並發出 `trackschange`。 */
  supported: boolean;
  /**
   * - `'codec'`：Engine 本身不支援，例如 wasm 沒有這個 decoder，或沒對應到 WebCodecs 的影片 codec。
   * - `'platform'`：Engine 支援、這個瀏覽器不支援，例如沒有 WebCodecs、`isConfigSupported` 為 false、
   *   configure 或首個 keyframe 失敗。
   * - `'bitmap-subtitle'`：圖形字幕（PGS、DVD），Engine 不解碼。
   */
  unsupportedReason?: 'codec' | 'platform' | 'bitmap-subtitle';
  /** 正規化為 BCP 47，例如 `'ja'`、`'zh'`；容器標 `'und'` 或無法對照時為 undefined。 */
  language?: string;
  /** 容器內的原值，例如 `'jpn'`、`'chi'`。 */
  rawLanguage?: string;
  title?: string;
  /** 容器的 default 旗標。 */
  default: boolean;
  /** 容器的 forced 旗標。 */
  forced: boolean;
}

/** 音軌。 */
export interface AudioTrack extends TrackBase {
  kind: 'audio';
  sampleRate: number;
  channels: number;
  /** FFmpeg 的 channel layout 描述，例如 `'stereo'`、`'5.1(side)'`。 */
  channelLayout?: string;
  /** 原始的取樣格式，例如 `'s16'`、`'s24'`、`'fltp'`；輸出一律轉為 float。 */
  sampleFormat?: string;
  /** 目前設定的音軌 offset（秒）。 */
  offset: number;
}

/** 影片軌。 */
export interface VideoTrack extends TrackBase {
  kind: 'video';
  codedWidth: number;
  codedHeight: number;
  display: VideoSize;
  frameRate?: number;
}

/** 內嵌字幕軌。 */
export interface SubtitleTrack extends TrackBase {
  kind: 'subtitle';
  format: 'ass' | 'ssa' | 'subrip' | 'webvtt' | 'mov_text' | 'bitmap';
  /** ASS／SSA 的 header（Matroska CodecPrivate）原文，含 `[Script Info]`、`[V4+ Styles]`、`[Events]` 的 Format 行。 */
  header?: string;
}

/** 影片的顯示尺寸。 */
export interface VideoSize {
  /** 套用旋轉與 SAR 後的顯示寬度。 */
  width: number;
  /** 套用旋轉與 SAR 後的顯示高度。 */
  height: number;
  /** 順時針旋轉的角度。 */
  rotation: 0 | 90 | 180 | 270;
}

/** 各 kind 選用的軌道 id；null 表示關閉該類軌道。 */
export interface TrackSelection {
  audio: string | null;
  video: string | null;
  subtitle: string | null;
}

/** 媒體時間軸上的一段範圍（秒）。 */
export interface TimeRange {
  start: number;
  end: number;
}

// ───────────────────────────── 字幕 cue ─────────────────────────────

/** 內嵌字幕的 cue，隨 demux 進度串流送出；同一個 cue 可能因 seek 重新送出，App 以 id 去重。 */
export type SubtitleCue = TextCue | AssCue;

/** 各種 cue 共有的欄位。 */
export interface CueBase {
  trackId: string;
  /** 穩定的 id（由 pts 與 ReadOrder 組成），可用來去重。 */
  id: string;
  start: number;
  end: number;
}

/** 文字字幕的 cue。 */
export interface TextCue extends CueBase {
  format: 'subrip' | 'webvtt' | 'mov_text';
  /** 封包內的原始文字，不解析標記。 */
  text: string;
}

/** ASS／SSA 字幕的 cue。 */
export interface AssCue extends CueBase {
  format: 'ass' | 'ssa';
  /** Matroska 封包原文：`ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text`（不含時間）。 */
  raw: string;
  readOrder: number;
  /** 依 header 的 Format 重組的完整 `Dialogue:` 行，可以直接餵給 libass／JASSUB。 */
  dialogue: string;
}

// ───────────────────────────── 事件 ─────────────────────────────

/**
 * Engine 的事件。每種事件是一個 `Event` 子類別，欄位直接放在事件上（不用 `CustomEvent.detail`）。
 * 事件一律在主執行緒同步 dispatch；指令 resolve 前，對應的事件已經發出。
 */
export interface EngineEventMap {
  /** `state` 或 `paused` 改變。 */
  statechange: StateChangeEvent;
  /** 播放位置前進，依 `timeUpdateInterval` 節流；seek 完成時一定會補發一次。 */
  timeupdate: TimeUpdateEvent;
  /** `duration` 改變。 */
  durationchange: DurationChangeEvent;
  /** seek 完成。 */
  seeked: SeekedEvent;
  /** 播到結尾。 */
  ended: Event;
  /**
   * fatal 時 state 同時變為 `'error'`。非致命的只在播放中自動降級時發出（例如影片解碼失敗、退回只播音訊），
   * state 不變；指令自己的失敗只出現在該指令的 reject，不另外發事件。
   */
  error: EngineErrorEvent;
  /** 軌道清單或選擇改變（load 完成、加入外掛音軌、selectTracks 完成、offset 改變、影片解碼失敗退回只播音訊）。 */
  trackschange: TracksChangeEvent;
  /** `buffered` 改變。 */
  bufferedchange: BufferedChangeEvent;
  /** `videoSize` 改變。 */
  videoresize: VideoResizeEvent;
  /** 一批新的內嵌字幕 cue（只送選中的字幕軌）。 */
  cues: CuesEvent;
  /** buffering 超過 `stallTimeout`，Engine 開始自動恢復。 */
  stall: StallEvent;
  /** 卡住後恢復播放。 */
  stallrecovered: StallRecoveredEvent;
  /**
   * 即將建立或 resume AudioContext（`unlockAudio()`、gesture 內的 `play()`、中斷後恢復）。
   * 在 user gesture 的同步段內 dispatch；listener 必須同步完成，例如設定
   * `navigator.audioSession.type = "playback"`、啟動靜音 anchor `<audio>`。
   */
  beforeaudiostart: BeforeAudioStartEvent;
}

/**
 * `state` 或 `paused` 改變的原因。
 * - `'command'`：App 的指令（load、play、pause、seek、selectTracks…）。
 * - `'media'`：播放本身的進展（載入完成、緩衝用完或補上、seek 完成、播到結尾）。
 * - `'stall'`：卡住偵測與自動恢復。
 * - `'error'`：致命錯誤。
 * - `'interrupted'`：系統中斷音訊（iOS 來電、其他 App 搶走 audio session）；`paused` 變為 true，結束後不自動恢復。
 * - `'external'`：AudioContext 被 Engine 以外的人 suspend／resume（例如 iOS 鎖屏控制直接操作 AudioContext）；
 *   `paused` 跟著變。
 */
export type StateChangeReason =
  'command' | 'media' | 'stall' | 'error' | 'interrupted' | 'external';

// ───────────────────────────── 錯誤 ─────────────────────────────

/**
 * `EngineError` 的種類。
 *
 * 取檔：
 * - `SOURCE_UNAUTHORIZED`：401；App 應走 session 失效流程，之後 `reload()`。
 * - `SOURCE_FORBIDDEN`：403。
 * - `SOURCE_NOT_FOUND`：404／410。
 * - `SOURCE_SERVER`：5xx，自動重試後仍失敗。
 * - `SOURCE_NETWORK`：網路中斷、CORS、DNS，自動重試後仍失敗。
 * - `SOURCE_RANGE_UNSUPPORTED`：伺服器不回 206。
 * - `SOURCE_CHANGED`：`reload()` 時軌道的組成與先前不同。
 *
 * 格式與解碼：
 * - `FORMAT_UNSUPPORTED`：probe 失敗、不認得的容器。
 * - `FORMAT_CORRUPT`：demux 途中資料損毀。
 * - `CODEC_UNSUPPORTED`：`load()` 時沒有任何可播的軌；`selectTracks()` 選到不支援的軌，或 configure、首個 keyframe 失敗。
 * - `DECODE_FAILED`：播放中解碼錯誤。音訊連續失敗超過 1 媒體秒為致命；影片重新設定後仍失敗為非致命，退回只播音訊。
 *
 * 輸出與環境：
 * - `AUDIO_LOCKED`：沒有 user gesture 就要求播放，或 AudioContext 無法在沒有 gesture 時恢復。
 * - `AUDIO_OUTPUT`：AudioContext／AudioWorklet 無法啟動或恢復。
 * - `ASSET_LOAD_FAILED`：wasm、glue、Worker 或 worklet 載入失敗。
 * - `DESTROYED`：`destroy()` 之後呼叫指令。
 * - `MEMORY_LIMIT`：wasm heap 到達上限，或交錯不良的媒體讓封包佇列超過硬上限（致命），重新載入也無法解決；
 *   建立 wasm instance 時配置不到記憶體（致命），釋放記憶體後重新載入可能恢復；外掛音軌超過 4 條（非致命）。
 * - `INTERNAL`：media Worker 崩潰等 Engine 內部的錯誤。
 */
export type EngineErrorCode =
  | 'SOURCE_UNAUTHORIZED'
  | 'SOURCE_FORBIDDEN'
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_SERVER'
  | 'SOURCE_NETWORK'
  | 'SOURCE_RANGE_UNSUPPORTED'
  | 'SOURCE_CHANGED'
  | 'FORMAT_UNSUPPORTED'
  | 'FORMAT_CORRUPT'
  | 'CODEC_UNSUPPORTED'
  | 'DECODE_FAILED'
  | 'AUDIO_LOCKED'
  | 'AUDIO_OUTPUT'
  | 'ASSET_LOAD_FAILED'
  | 'DESTROYED'
  | 'MEMORY_LIMIT'
  | 'INTERNAL';

// ───────────────────────────── 診斷 ─────────────────────────────

/** log 的等級，由低到高。 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 接收 Engine 診斷 log 的 hook。 */
export type LogHook = (entry: LogEntry) => void;

/** 一筆診斷 log。 */
export interface LogEntry {
  level: LogLevel;
  /** 產生 log 的子系統；`'background'` 是背景播放模組。 */
  scope: 'io' | 'demux' | 'audio' | 'video' | 'subtitle' | 'command' | 'worker' | 'background';
  message: string;
  /** `performance.now()` 時間（主執行緒的時基）。 */
  time: number;
  data?: Record<string, unknown>;
}

/** `getStats()` 的統計快照。 */
export interface EngineStats {
  /** 從 `currentTime` 往後已備妥的秒數：封包佇列的秒數加上預讀 bytes 換算的秒數，是估計值。 */
  bufferAhead: number;
  /**
   * 音訊輸出。`ringMs`：ring buffer 目前的水位；`underruns`：ring 用完的次數；
   * `outputLatencyMs`：輸出延遲；`targetMs`：實際生效的 `audioBuffer.targetMs`。
   */
  audio: { ringMs: number; underruns: number; outputLatencyMs: number; targetMs: number };
  /** 影片解碼；沒有選用影片軌時為 null。 */
  video: {
    decoded: number;
    dropped: number;
    decodeQueueSize: number;
    avgDecodeMs: number;
  } | null;
  /** demux 與解碼之間的封包佇列。 */
  packetQueue: { audioSeconds: number; videoSeconds: number; bytes: number };
  /**
   * Range 快取。`bytes`／`limitBytes`：目前用量與上限；`aheadBytes`：選用中來源已預讀、在播放位置之後的 bytes 合計；
   * `readaheadTarget`：預讀目標的 bytes 合計；`fetching`：是否有來源處於抓取階段；`hits`／`misses`：命中與未命中次數。
   */
  cache: {
    bytes: number;
    limitBytes: number;
    aheadBytes: number;
    readaheadTarget: number;
    fetching: boolean;
    hits: number;
    misses: number;
  };
  /** 網路。`bytesLoaded`：累計讀取的 bytes；`inflight`：進行中的請求。 */
  network: {
    bytesLoaded: number;
    inflight: { url: string; start: number; end: number; elapsedMs: number }[];
  };
  /** 所有 wasm instance 的 heap 合計（bytes）。 */
  wasmHeapBytes: number;
  /**
   * 存活中的資源數，用於診斷 leak：`destroy()` 後全為 0；換檔後 `workers` 為 1、
   * `libavInstances` 等於來源數（主來源加外掛音軌）。
   */
  resources: { workers: number; libavInstances: number; openVideoFrames: number };
}

// ───────────────────────────── 授權 ─────────────────────────────

/** Engine 內含的第三方元件的授權聲明，供 App 的「關於」頁顯示。 */
export interface ThirdPartyNotice {
  /** 元件名稱，例如 `'FFmpeg'`。 */
  name: string;
  /** SPDX license expression，例如 `'LGPL-2.1-or-later'`。 */
  license: string;
  /** 對應原始碼的下載位置（wasm Release）。 */
  sourceUrl: string;
  /** 聲明全文。 */
  noticeText: string;
}
