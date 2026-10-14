// PROTOTYPE — [engine-v1] Prototype: Engine 公開 API（#2）的草稿，用完即丟。
// 只描述 App 看得到的形狀，不代表內部執行緒分工（見「執行緒分工與 wasm 銜接方式」）。
// 標 `Q<n>` 的地方是待 user 定案的問題，清單在 README.md。
// 時間一律以秒為單位（number），位於「媒體時間軸」：已扣掉容器的 start_time，0 是第一個可播放的 sample。

// ───────────────────────────── 建立與設定 ─────────────────────────────

export declare function createEngine(options?: EngineOptions): Engine;

/**
 * 檢查目前瀏覽器能否執行 Engine（WebAssembly、AudioWorklet、Worker）。不檢查 codec，也不要求 WebCodecs：
 * 沒有 WebCodecs 時影片軌標為不支援，只播音訊（ADR-0003）。
 */
export declare function isEngineSupported(): boolean;

export interface EngineOptions {
  /**
   * wasm 與 Worker 資產的位置。預設由套件以 `new URL(..., import.meta.url)` 解析，
   * 交給 App 的 bundler 處理；`.wasm` 必須同源、`Content-Type: application/wasm`。
   */
  assets?: { wasmUrl?: string | URL; workerUrl?: string | URL; workletUrl?: string | URL };
  /** 繪製影片的 canvas，也可之後用 `attachCanvas()` 設定。 */
  canvas?: HTMLCanvasElement | null;
  /** timeupdate 的最小間隔（ms），預設 250。 */
  timeUpdateInterval?: number;
  /** 記憶體上限；數值待「記憶體上限」一題定案，這裡只留入口。 */
  limits?: {
    /** Range 快取（LRU）上限，bytes。 */
    cacheBytes?: number;
    /** 解碼前封包佇列上限，秒。 */
    packetQueueSeconds?: number;
  };
  /**
   * 讀取失敗的自動重試：只針對 5xx 與網路錯誤，以指數退避重試；401／403／404 不重試、直接回報。
   * 預設 { attempts: 3, baseDelayMs: 500 }。
   */
  retry?: { attempts?: number; baseDelayMs?: number };
  /** 卡住偵測：buffering 超過此毫秒數就中止讀取、從目前位置重新 seek，並發出 `stall`。預設 8000。 */
  stallTimeout?: number;
  /** 卡住後自動恢復的次數上限，用完仍卡住就以最後一次的讀取錯誤進入 'error'。預設 2。 */
  stallAttempts?: number;
  /** 預設的偏好語言（BCP 47），load() 的 preferredLanguages 會覆蓋。 */
  preferredLanguages?: { audio?: string[]; subtitle?: string[] };
  /** 背景（document.hidden）時停止解碼影片、只播聲音，回前景時從 keyframe 重新同步。預設 true。 */
  suspendVideoWhenHidden?: boolean;
  /** 診斷用 log hook；未設定時 Engine 不輸出任何 log。 */
  log?: LogHook;
  /** 送進 log hook 的最低等級，預設 'warn'。 */
  logLevel?: LogLevel;
}

// ───────────────────────────── Engine ─────────────────────────────

export type EngineState =
  | 'idle' //      沒有載入任何媒體（初始、unload() 之後）
  | 'loading' //   load() 進行中：開檔、probe、填第一段緩衝
  | 'ready' //     載入完成、還沒開始播放過
  | 'playing' //   音訊時鐘在走
  | 'paused' //    使用者暫停
  | 'buffering' // 想播但資料不夠，時鐘停住
  | 'seeking' //   seek() 進行中，直到目標位置的 frame/sample 備妥
  | 'ended' //     播到結尾；paused 維持 false（與 HTMLMediaElement 不同），App 不接下一首時自己 pause()
  | 'error'; //    當前媒體發生致命錯誤，見 `engine.error`；load() 可重新開始

/**
 * 背景播放（iOS audioSession、靜音 anchor `<audio>`）不在 core，由選配的背景播放模組
 * `kikoeru-player/background` 處理（見 background.d.ts、ADR-0006）。
 * core 只提供所需的時機點與狀態：`beforeaudiostart` 事件、帶 reason 的 statechange、
 * 以及偵測外部對 AudioContext 的 suspend／resume。
 */
export interface Engine extends EventTarget {
  // ── 唯讀狀態 ──
  //
  // 同步讀取：主執行緒保留鏡像，由 Worker 在值改變時推送；持續變動又只存在於 Worker 的數字放在 getStats()。
  // 規則：
  // - 順序保證：指令的 Promise resolve 時，相關 getter 已是新值，對應事件也已發出。
  // - getter 顯示「已生效」的值：例如 selectTracks() 進行中，selectedTracks 仍是舊軌，新軌出聲後才更新。
  //   唯一例外是 paused，它是使用者意圖，play()／pause() 呼叫當下就改變，
  //   並在呼叫內同步發出 statechange（state 沒變時 state === previous），供背景播放模組與 Media Session 跟上。
  // - tracks 在 load() 之後只因指令或降級改變（addExternalAudio、removeExternalAudio、setAudioOffset、
  //   selectTracks 發現 codec 實際不支援、播放中影片解碼失敗而退回只播音訊）。播放中才出現的 stream 只記 log、不加入。

  readonly state: EngineState;
  /**
   * 使用者的播放意圖，與 state 分開。seeking／buffering／loading 結束後
   * 依此回到 playing 或 paused。play() 設為 false、pause() 設為 true。
   */
  readonly paused: boolean;
  /** 目前播放位置。播放中依音訊時鐘內插，已扣除 outputLatency。 */
  readonly currentTime: number;
  /** 總長度；未知時為 NaN。 */
  readonly duration: number;
  /** 已緩衝範圍（媒體時間），依起點排序、不重疊。 */
  readonly buffered: readonly TimeRange[];
  /** 當前媒體的 probe 結果；idle 時為 null。 */
  readonly media: MediaInfo | null;
  readonly tracks: readonly Track[];
  readonly selectedTracks: Readonly<TrackSelection>;
  /** state 為 'error' 時的錯誤，其他狀態為 null。 */
  readonly error: EngineError | null;
  /** 影片的顯示尺寸（已套用旋轉與 SAR）；沒有影片軌時為 null。 */
  readonly videoSize: VideoSize | null;

  // ── 同步設定（即時生效、最後一次勝出，不經過指令佇列） ──

  /** 0–1，套用時有 gain ramp。 */
  volume: number;
  muted: boolean;
  /** 不變調的播放速度，0.5–2；超出範圍丟 RangeError。 */
  playbackRate: number;

  // ── 音訊解鎖 ──

  /**
   * 在 user gesture 的同步段內呼叫，建立或 resume AudioContext。
   * play() 若在 user gesture 內被呼叫也會自動解鎖，所以多數 App 不需要直接呼叫。
   * 若之後沒有 gesture 就 play()，會以 AUDIO_LOCKED 拒絕。
   * 建立或 resume AudioContext 之前會同步發出 `beforeaudiostart`。
   */
  unlockAudio(): void;
  readonly audioUnlocked: boolean;

  // ── 指令（全部進同一個指令佇列，一律回傳 Promise） ──

  /**
   * 載入新媒體。取代所有尚未完成的 load／seek／selectTracks／external audio 指令（以 AbortError 結束），
   * 並中止舊媒體的讀取。resolve 時 state 為 ready（或 options.paused === false 時為 playing）。
   * 失敗時 reject EngineError，state 變為 'error'。
   * 只要還有一條可播的音軌或影片軌就成功；不支援的軌照樣列在 tracks（supported: false），
   * 影片軌不支援或 configure 失敗時 selectedTracks.video 為 null、只播音訊。
   * 沒有任何可播的軌時 reject EngineError('CODEC_UNSUPPORTED')。
   */
  load(source: Source, options?: LoadOptions): Promise<MediaInfo>;

  /**
   * 以同一份媒體重新開檔，用於 session 失效等錯誤之後的接續；ready 以後的任何狀態與 'error' 都可呼叫。
   * 保留：位置（error 時取 error.position）、paused、軌道選擇、外掛音軌、各音軌 offset、音量與速度。
   * track id 不變。重新開檔後 stream 結構與先前不同時 reject EngineError('SOURCE_CHANGED')。
   * 取代規則與 load() 相同。
   */
  reload(): Promise<MediaInfo>;

  /**
   * 設定 paused = false。resolve 於 state 真正進入 playing（音訊開始輸出）。
   * 在 ended 時呼叫會從頭播放。之後若有 pause() 或 load() 先完成，reject AbortError。
   */
  play(): Promise<void>;

  /** 設定 paused = true，resolve 於 gain ramp 結束、時鐘停止。 */
  pause(): Promise<void>;

  /**
   * 精準 seek（影片到 frame、音訊到 sample）。連續呼叫時只有最後一個會執行，
   * 被取代的以 AbortError 結束。resolve 實際落點（會被夾在 [0, duration]）。
   * loading 期間呼叫時改寫該次 load 的起點，於 load 完成時一起 resolve。
   */
  seek(time: number): Promise<number>;

  /**
   * 播放中切換軌道，不重新載入、時間不跳。只帶要改的 kind；null 表示關閉該類軌道
   * （例如影片檔只播音訊、關掉字幕）。同一 kind 連續呼叫只保留最後一個。
   * 選到 supported: false 的軌，或新軌 configure／首個 keyframe 失敗時，reject 非致命的
   * EngineError('CODEC_UNSUPPORTED')，保留原本的軌；後者會把該軌改為 supported: false 並發出 trackschange。
   */
  selectTracks(selection: Partial<TrackSelection>): Promise<void>;

  /**
   * 以另一個來源加入外掛音軌，回傳新的 AudioTrack（origin: 'external'）。
   * 不會自動選用；要用 selectTracks({ audio: track.id }) 切過去。
   * 外掛音軌屬於當前媒體，下一次 load()／unload() 時一併移除，reload() 時保留。
   * 載入失敗時 reject 非致命的 EngineError（fatal: false），主媒體繼續播放。
   */
  addExternalAudio(source: Source, options?: { offset?: number; label?: string }): Promise<AudioTrack>;
  removeExternalAudio(trackId: string): Promise<void>;

  /**
   * 設定音軌的 offset（秒），容器內與外掛音軌都適用。正值表示聲音比影片晚出現。
   * 每條音軌各自記住；改的是目前選中的軌時會立即重新同步（短暫 seeking）。
   */
  setAudioOffset(trackId: string, offset: number): Promise<void>;

  /** 卸載當前媒體、回到 idle，保留 AudioContext，供之後 load() 使用；media Worker 會被 terminate（ADR-0002）。 */
  unload(): Promise<void>;

  /**
   * 立即釋放所有資源：中止讀取、關閉 decoder、終止 Worker、關閉 AudioContext。
   * 所有未完成的指令以 AbortError 結束。之後任何指令都 reject EngineError('DESTROYED')。可重複呼叫。
   */
  destroy(): Promise<void>;

  // ── 影片輸出 ──

  /**
   * 指定繪製目標，null 表示不再繪製（影片仍會解碼以維持同步，除非也關掉影片軌）。
   * Engine 會設定 canvas.width／height 為影片顯示尺寸；版面縮放由 App 用 CSS
   * （例如 `object-fit: contain`）處理。
   */
  attachCanvas(canvas: HTMLCanvasElement | null): void;

  // ── 事件（標準 EventTarget；支援 { once, signal }） ──

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

  /** 取一次統計快照；非同步，因為大部分數字在 Worker 內。 */
  getStats(): Promise<EngineStats>;
}

export interface LoadOptions {
  /** 起始位置，預設 0。用於 session 失效後的重新載入。 */
  startTime?: number;
  /** false 時載入完成後直接播放（等同 load 完再 play()）。預設 true：停在 ready。 */
  paused?: boolean;
  /**
   * 初始軌道選擇。未指定的 kind 只從 supported 的軌中選：音軌依偏好語言 → default 旗標 → 第一條；
   * 影片軌選 default 旗標 → 第一條；字幕只在 forced 或命中偏好語言時開啟。
   */
  tracks?: Partial<TrackSelection>;
  /** 偏好語言（BCP 47），覆蓋 EngineOptions.preferredLanguages。 */
  preferredLanguages?: { audio?: string[]; subtitle?: string[] };
  /** 外部取消；效果等同被下一個 load() 取代。 */
  signal?: AbortSignal;
}

// ───────────────────────────── 來源 ─────────────────────────────

/**
 * 檔案來源。用可序列化的描述而不是物件，讓 Engine 能在任何執行緒重建讀取器；
 * 測試用 'bytes'，本機檔案用 'blob'。之後若需要 App 自訂讀法，再加入新的 kind。
 */
export type Source = HttpSource | BytesSource | BlobSource;

export interface HttpSource {
  kind: 'http';
  url: string | URL;
  /** 預設 'same-origin'：同源請求自動帶 cookie。 */
  credentials?: RequestCredentials;
  headers?: Record<string, string>;
  /** 已知的檔案大小，可省掉一次 HEAD／Range 探測。 */
  size?: number;
}

export interface BytesSource {
  kind: 'bytes';
  data: ArrayBuffer | Uint8Array;
  /** 用於 log 與錯誤訊息。 */
  name?: string;
}

export interface BlobSource {
  kind: 'blob';
  blob: Blob;
}

// ───────────────────────────── 媒體與軌道 ─────────────────────────────

export interface MediaInfo {
  /** libavformat 的格式名稱，例如 'matroska,webm'、'mov,mp4,m4a,3gp,3g2,mj2'、'wav'。 */
  format: string;
  duration: number;
  size: number;
  tracks: readonly Track[];
}

export type Track = AudioTrack | VideoTrack | SubtitleTrack;
export type TrackKind = Track['kind'];

export interface TrackBase {
  /** Engine 內唯一、跨 load 不重複（reload() 保留），例如 'a:1'、'ext:3'。 */
  id: string;
  /** 'container'：容器內的 stream；'external'：addExternalAudio() 加入的來源。 */
  origin: 'container' | 'external';
  /** 容器內的 stream index；外掛音軌為其來源內的 index。 */
  streamIndex: number;
  /** FFmpeg codec 名稱，例如 'aac'、'flac'、'h264'、'ass'。 */
  codec: string;
  /** WebCodecs codec string（只有影片軌），例如 'avc1.640028'。 */
  codecString?: string;
  /** false 時無法選用；原因見 unsupportedReason。播放中發現實際無法解碼時會改為 false 並發出 trackschange。 */
  supported: boolean;
  /**
   * - 'codec'：Engine 本身不支援，例如 wasm 沒有這個 decoder，或沒對應到 WebCodecs 的影片 codec。
   * - 'platform'：Engine 支援、這個瀏覽器不支援，例如沒有 WebCodecs、isConfigSupported 為 false、
   *   configure 或首個 keyframe 失敗。
   * - 'bitmap-subtitle'：圖形字幕（PGS、DVD），Engine 不解碼。
   */
  unsupportedReason?: 'codec' | 'platform' | 'bitmap-subtitle';
  /** 正規化為 BCP 47，例如 'ja'、'zh'；容器標 'und' 或無法對照時為 undefined。 */
  language?: string;
  /** 容器內的原值，例如 'jpn'、'chi'。 */
  rawLanguage?: string;
  title?: string;
  default: boolean;
  forced: boolean;
}

export interface AudioTrack extends TrackBase {
  kind: 'audio';
  sampleRate: number;
  channels: number;
  /** FFmpeg 的 channel layout 描述，例如 'stereo'、'5.1(side)'。 */
  channelLayout?: string;
  /** 原始取樣格式，例如 's16'、's24'、'fltp'；輸出一律轉為 float。 */
  sampleFormat?: string;
  /** 目前設定的 offset（秒）。 */
  offset: number;
}

export interface VideoTrack extends TrackBase {
  kind: 'video';
  codedWidth: number;
  codedHeight: number;
  display: VideoSize;
  frameRate?: number;
}

export interface SubtitleTrack extends TrackBase {
  kind: 'subtitle';
  format: 'ass' | 'ssa' | 'subrip' | 'webvtt' | 'mov_text' | 'bitmap';
  /** ASS／SSA 的 header（Matroska CodecPrivate）原文，含 [Script Info]、[V4+ Styles]、[Events] Format 行。 */
  header?: string;
}

export interface VideoSize {
  /** 套用旋轉與 SAR 後的顯示寬高。 */
  width: number;
  height: number;
  /** 0、90、180、270，順時針。 */
  rotation: 0 | 90 | 180 | 270;
}

export interface TrackSelection {
  audio: string | null;
  video: string | null;
  subtitle: string | null;
}

export interface TimeRange {
  start: number;
  end: number;
}

// ───────────────────────────── 字幕 cue ─────────────────────────────

/** 隨 demux 進度串流送出；同一 cue 可能因 seek 重新送出，App 以 id 去重。 */
export type SubtitleCue = TextCue | AssCue;

export interface CueBase {
  trackId: string;
  /** 穩定的 id（由 pts 與 ReadOrder 組成），可用來去重。 */
  id: string;
  start: number;
  end: number;
}

export interface TextCue extends CueBase {
  format: 'subrip' | 'webvtt' | 'mov_text';
  /** 封包內的原始文字，不解析標記。 */
  text: string;
}

export interface AssCue extends CueBase {
  format: 'ass' | 'ssa';
  /** Matroska 封包原文：`ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text`（不含時間）。 */
  raw: string;
  readOrder: number;
  /** 依 header 的 Format 重組的完整 `Dialogue:` 行，方便直接餵給 libass／JASSUB。 */
  dialogue: string;
}

// ───────────────────────────── 事件 ─────────────────────────────

// 每種事件一個 Event 子類別，欄位直接放在事件上（不用 CustomEvent.detail）。
// 事件一律在主執行緒同步 dispatch；指令 resolve 前，對應事件已經發出。

export interface EngineEventMap {
  statechange: StateChangeEvent;
  /** 依 timeUpdateInterval 節流；seek 完成時一定會補發一次。 */
  timeupdate: TimeUpdateEvent;
  durationchange: DurationChangeEvent;
  seeked: SeekedEvent;
  ended: Event;
  /**
   * fatal 時 state 同時變為 'error'。非致命的只在播放中自動降級時發出（例如影片解碼失敗、
   * 退回只播音訊），state 不變；指令自己的失敗只出現在該指令的 reject，不另發事件。
   */
  error: EngineErrorEvent;
  /** 軌道清單或選擇改變（load 完成、加入外掛音軌、selectTracks 完成、offset 改變、影片解碼失敗退回只播音訊）。 */
  trackschange: TracksChangeEvent;
  bufferedchange: BufferedChangeEvent;
  videoresize: VideoResizeEvent;
  /** 一批新的內嵌字幕 cue（只送選中的字幕軌）。 */
  cues: CuesEvent;
  /** buffering 超過 stallTimeout，Engine 開始自動恢復。 */
  stall: StallEvent;
  /** 卡住後恢復播放。 */
  stallrecovered: StallRecoveredEvent;
  /**
   * 即將建立或 resume AudioContext（unlockAudio()、gesture 內的 play()、中斷後恢復）。
   * 在 user gesture 的同步段內 dispatch；listener 必須同步完成，例如設定
   * `navigator.audioSession.type = "playback"`、啟動靜音 anchor `<audio>`。
   */
  beforeaudiostart: BeforeAudioStartEvent;
}

/**
 * state 或 paused 改變的原因。
 * - 'command'：App 的指令（load、play、pause、seek、selectTracks…）。
 * - 'media'：播放本身的進展（載入完成、緩衝用完或補上、seek 完成、播到結尾）。
 * - 'stall'：卡住偵測與自動恢復。
 * - 'error'：致命錯誤。
 * - 'interrupted'：系統中斷音訊（iOS 來電、其他 App 搶走 audio session）；paused 變為 true，結束後不自動恢復。
 * - 'external'：AudioContext 被 Engine 以外的人 suspend／resume（例如 iOS 鎖屏控制直接操作 AudioContext）；
 *   paused 跟著變。
 */
export type StateChangeReason = 'command' | 'media' | 'stall' | 'error' | 'interrupted' | 'external';

export declare class StateChangeEvent extends Event {
  readonly state: EngineState;
  readonly previous: EngineState;
  readonly paused: boolean;
  readonly reason: StateChangeReason;
}
export declare class TimeUpdateEvent extends Event {
  readonly currentTime: number;
}
export declare class DurationChangeEvent extends Event {
  readonly duration: number;
}
export declare class SeekedEvent extends Event {
  readonly currentTime: number;
}
export declare class EngineErrorEvent extends Event {
  readonly error: EngineError;
}
export declare class TracksChangeEvent extends Event {
  readonly tracks: readonly Track[];
  readonly selected: Readonly<TrackSelection>;
}
export declare class BufferedChangeEvent extends Event {
  readonly buffered: readonly TimeRange[];
}
export declare class VideoResizeEvent extends Event {
  readonly size: VideoSize | null;
}
export declare class CuesEvent extends Event {
  readonly trackId: string;
  readonly cues: readonly SubtitleCue[];
}
export declare class StallEvent extends Event {
  /** 開始卡住的 performance.now() 時間。 */
  readonly since: number;
  readonly position: number;
}
export declare class StallRecoveredEvent extends Event {
  readonly stalledMs: number;
  readonly attempts: number;
}
export declare class BeforeAudioStartEvent extends Event {
  /** 'unlock'：第一次建立或解鎖；'resume'：暫停或中斷後恢復。 */
  readonly cause: 'unlock' | 'resume';
}

// ───────────────────────────── 錯誤 ─────────────────────────────

export type EngineErrorCode =
  // 取檔
  | 'SOURCE_UNAUTHORIZED' //     401：App 應走 session 失效流程
  | 'SOURCE_FORBIDDEN' //        403
  | 'SOURCE_NOT_FOUND' //        404／410
  | 'SOURCE_SERVER' //           5xx（已自動重試後仍失敗）
  | 'SOURCE_NETWORK' //          網路中斷、CORS、DNS（已自動重試後仍失敗）
  | 'SOURCE_RANGE_UNSUPPORTED' // 伺服器不回 206
  | 'SOURCE_CHANGED' //          reload() 時 stream 結構不同；[延] 讀到一半檔案被換掉（ETag／If-Range）
  // 格式與解碼
  | 'FORMAT_UNSUPPORTED' //      probe 失敗、不認得的容器
  | 'FORMAT_CORRUPT' //          demux 途中資料損毀
  | 'CODEC_UNSUPPORTED' //       load()：沒有任何可播的軌；selectTracks()：選到不支援的軌、configure 或首個 keyframe 失敗
  | 'DECODE_FAILED' //           播放中解碼錯誤：音訊連續失敗超過 1 媒體秒（致命）；影片重新設定後仍失敗（非致命，退回只播音訊）
  // 輸出與環境
  | 'AUDIO_LOCKED' //            沒有 user gesture 就要求播放
  | 'AUDIO_OUTPUT' //            AudioContext／AudioWorklet 無法啟動或恢復
  | 'ASSET_LOAD_FAILED' //       wasm／Worker／worklet 載入失敗
  | 'DESTROYED' //               destroy() 之後呼叫指令
  | 'INTERNAL';

/**
 * Engine 的錯誤。被取代或取消的指令不使用 EngineError，而是 `DOMException` name 為 'AbortError'，
 * App 用 `isAbortError()` 判斷後忽略即可。
 */
export declare class EngineError extends Error {
  readonly name: 'EngineError';
  readonly code: EngineErrorCode;
  /**
   * 致命錯誤會讓 state 進入 'error'。非致命的出現在指令的 reject（例如外掛音軌載入失敗），
   * 或播放中自動降級時的 error 事件（例如影片解碼失敗、退回只播音訊）。
   */
  readonly fatal: boolean;
  /** 發生時的播放位置，供重新載入時接續。 */
  readonly position: number;
  readonly detail: {
    status?: number;
    url?: string;
    trackId?: string;
    codec?: string;
  };
  readonly cause?: unknown;
}

export declare function isAbortError(error: unknown): boolean;

// ───────────────────────────── 診斷 ─────────────────────────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogHook = (entry: LogEntry) => void;

export interface LogEntry {
  level: LogLevel;
  /** 產生 log 的子系統。 */
  scope: 'io' | 'demux' | 'audio' | 'video' | 'subtitle' | 'command' | 'worker' | 'background';
  message: string;
  /** performance.now() 時間（主執行緒時基）。 */
  time: number;
  data?: Record<string, unknown>;
}

export interface EngineStats {
  /** 從 currentTime 往後已備妥的秒數。 */
  bufferAhead: number;
  audio: { ringMs: number; underruns: number; outputLatencyMs: number };
  video: { decoded: number; dropped: number; decodeQueueSize: number; avgDecodeMs: number } | null;
  packetQueue: { audioSeconds: number; videoSeconds: number; bytes: number };
  cache: { bytes: number; limitBytes: number; hits: number; misses: number };
  network: { bytesLoaded: number; inflight: { url: string; start: number; end: number; elapsedMs: number }[] };
  /** 所有 wasm instance 的 heap 合計。 */
  wasmHeapBytes: number;
  /**
   * 存活中的資源數，用於診斷 leak：destroy() 後全為 0；換檔後 workers 為 1、
   * libavInstances 等於來源數（主來源加外掛音軌）。
   */
  resources: { workers: number; libavInstances: number; openVideoFrames: number };
}
