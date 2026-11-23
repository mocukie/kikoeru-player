// createEngine() 與 Engine 的實作：指令佇列、狀態機與狀態鏡像。

import type {
  ProbedMedia,
  WireCue,
  WireError,
  WorkerBufferMessage,
  WorkerStats,
  WorkerTrackSelection,
  WorkletClockMessage,
  WorkletToMainMessage,
} from '../protocol/index.js';
import { abortError, CommandQueue, deferred, type Deferred } from './command-queue.js';
import { AudioContextLifecycle, type ContextChange, type StartResult } from './audio-context.js';
import { createWebAudioOutput } from './audio-output.js';
import {
  AssetLoadError,
  type AudioOutput,
  type EngineDeps,
  type MediaWorker,
  type WasmAssets,
} from './deps.js';
import { EngineError, fromWireError } from './errors.js';
import { ExternalAudioSources, MAX_EXTERNAL_AUDIO } from './external-audio.js';
import {
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
import { errorScope, fromWorkerTime, Logger } from './log.js';
import { resolveEngineOptions, type ResolvedEngineOptions } from './options.js';
import { createWebMediaWorker } from './media-worker.js';
import { detectPlatform } from './platform.js';
import { sameTrackStructure, selectInitialTracks, toContainerTracks } from './tracks.js';
import { VIDEO_READY_TIMEOUT_MS, VideoOutput } from './video-output.js';
import { documentVisibility } from './visibility.js';
import { loadWasmAssets } from './wasm.js';
import { toWireSource } from './wire-source.js';
import type {
  AudioTrack,
  Engine,
  EngineErrorCode,
  EngineOptions,
  EngineState,
  EngineStats,
  LoadOptions,
  MediaInfo,
  Source,
  StateChangeReason,
  TimeRange,
  Track,
  TrackKind,
  TrackSelection,
  VideoSize,
  VideoTrack,
} from './types.js';

/**
 * 建立 Engine。整個 App 建立一個，換檔用 `load()`。
 *
 * 選項的數值超出範圍時丟 `RangeError`，見 `EngineOptions` 各欄位。平台（iOS／iPadOS、Android、桌面）在這裡判斷一次，
 * 決定 `audioBuffer` 與 `limits` 的預設值。
 */
export function createEngine(options?: EngineOptions): Engine {
  return createEngineWith(
    {
      platform: detectPlatform(globalThis.navigator),
      loadWasm: () => loadWasmAssets(options?.assets),
      createWorker: createWebMediaWorker,
      createAudioOutput: createWebAudioOutput,
      visibility: documentVisibility(),
    },
    options,
  );
}

/** 以指定的 deps 建立 Engine；`createEngine()` 帶真實 deps 呼叫它，Node 測試注入 `test/fakes/`。不放進套件的 `exports`。 */
export function createEngineWith(deps: EngineDeps, options?: EngineOptions): Engine {
  return new EngineImpl(deps, resolveEngineOptions(options, deps.platform));
}

type CommandKind = 'load' | 'unload' | 'play' | 'pause' | 'seek' | 'select' | 'external' | 'offset';

const trackKinds: readonly TrackKind[] = ['audio', 'video', 'subtitle'];

/** 沒有播放（暫停中、idle、error）超過這麼久（ms）才經佇列 `suspend()` AudioContext 以省電（ADR-0004）。 */
const IDLE_SUSPEND_MS = 30_000;
/** Engine 處於 playing 而 worklet 回報的 frame 超過這麼久（ms）沒有前進時，watchdog 介入（ADR-0004）。 */
const WATCHDOG_MS = 1000;
/** worklet starved 超過這麼久（ms）才進入 buffering；更短的只計入 underrun（ADR-0004）。 */
const STARVED_MS = 250;
/** 因網路不足進入 buffering 之後，bufferAhead 要到這麼多秒才恢復（「記憶體上限的數值」#23）。 */
const RESUME_AHEAD_SECONDS = 3;
/** `playbackRate` 的範圍（ADR-0004）。 */
const MIN_RATE = 0.5;
const MAX_RATE = 2;
/** `buffered` 的終點變動至少這麼多秒才發出 bufferedchange。 */
const BUFFERED_CHANGE_SECONDS = 0.5;

const noSelection: Readonly<TrackSelection> = { audio: null, video: null, subtitle: null };

/** `reload()` 沿用的上一份媒體：軌道（含 track id）與選擇。 */
interface ReloadOf {
  info: MediaInfo;
  selection: TrackSelection;
}

/** 一次 buffering 的卡住偵測。 */
interface StallEpisode {
  /** 進入 buffering 的 `performance.now()`。 */
  since: number;
  /** 已經嘗試自動恢復的次數。 */
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** 一次 `selectTracks()` 的要求。同一 kind 由最後一個要求它的呼叫負責：要改的 kind 都被較新的呼叫接手時被取代。 */
interface SelectRequest {
  selection: Partial<TrackSelection>;
}

/** 換軌中新的軌失敗：該軌改為不支援（`unsupportedReason`），或是外掛音軌時移除（`'remove'`）。 */
interface SwitchFailure {
  trackId: string;
  error: WireError;
  mark: 'platform' | 'codec' | 'remove';
}

/** 執行中的換軌：新軌還沒生效（出聲、出畫面）。 */
interface Switching {
  /** 生效時公布的選擇；途中影片退回只播音訊時跟著改。 */
  next: TrackSelection;
  /** 新的影片軌 configure 或首個 keyframe 失敗、新音軌的 decoder 開啟失敗，或新的外掛音軌失敗。 */
  failed: SwitchFailure | null;
}

/** 執行中的 load。 */
interface LoadContext {
  /** 起點；loading 期間的 seek 會改寫它。 */
  startTime: number;
  /** worklet 最後一次 flush 的位置。 */
  flushedAt: number;
  probed: ProbedMedia | null;
  /** 已送出 `start` 之後才有。 */
  info: MediaInfo | null;
  selection: TrackSelection;
  /** loading 期間的 seek，與 load 一起 resolve。 */
  seek: Deferred<number> | null;
}

class EngineImpl extends EventTarget implements Engine {
  readonly #deps: EngineDeps;
  readonly #options: ResolvedEngineOptions;
  readonly #log: Logger;
  readonly #queue = new CommandQueue<CommandKind, SelectRequest>((kind, by, started) => {
    this.#log.log('debug', 'command', `${kind} 被 ${by} 取代`, { started });
  });
  /** 等待狀態改變的指令；每次鏡像更新後重新檢查。 */
  readonly #waiters = new Set<() => void>();

  #state: EngineState = 'idle';
  #paused = true;
  /** 最後一個 statechange 帶的 `paused`；#changeIntent() 到 #announceIntent() 之間與 `#paused` 不同。 */
  #announcedPaused = true;
  /** 鏡像的位置：時鐘停住時就是 `currentTime`；播放中是內插的基準之一（見 `currentTime`）。 */
  #currentTime = 0;
  /** 這個 epoch 最後一個 clock；播放中以它與此刻聽到的 frame 內插 `currentTime`。flush 時清掉。 */
  #clock: WorkletClockMessage | null = null;
  /** 這次進入 playing 之後 `currentTime` 回傳過的最大值；內插的結果不低於它，也不低於開始播放的位置。 */
  #heardFloor = 0;
  /** ring 的 frame 數與累計的 underrun，取自最後一個 clock，供 `getStats().audio`。 */
  #ringFrames = 0;
  #underruns = 0;
  /** playing 期間依 `timeUpdateInterval` 發出 timeupdate 的 timer。 */
  #timeUpdateTimer: ReturnType<typeof setInterval> | null = null;
  #lastTimeUpdate = NaN;
  /** 等待 Worker 回覆的 `stats` 要求；Worker 被 terminate 時以 null resolve。 */
  readonly #statsRequests = new Map<number, (stats: WorkerStats | null) => void>();
  #statsSeq = 0;
  #duration = NaN;
  #media: MediaInfo | null = null;
  #tracks: readonly Track[] = [];
  #selected: Readonly<TrackSelection> = noSelection;
  #error: EngineError | null = null;
  #volume = 1;
  #muted = false;
  #rate = 1;
  /** Worker 最後回報的資料備妥進度；load 時清掉。 */
  #buffer: WorkerBufferMessage | null = null;
  /** worklet 回報 starved 之後、補回之前（時鐘停住）；flush 時清掉。 */
  #starved = false;
  /** starved 之後 `STARVED_MS` 進入 buffering 的 timer。 */
  #starveTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 因網路不足進入 buffering：worklet 先停住，等 bufferAhead ≥ `RESUME_AHEAD_SECONDS`（或已讀到檔尾、預讀不再抓取）
   * 才恢復輸出，避免網路比位元率慢時播一下停一下。離開 buffering 時清掉。
   */
  #holding = false;
  /** 這次 buffering 的卡住偵測：開始的 `performance.now()`、已經嘗試恢復的次數與逾時的 timer。 */
  #stall: StallEpisode | null = null;
  /** Worker 回報的最後一次讀取錯誤；卡住而放棄時以它進入 error。load 時清掉。 */
  #lastReadError: WireError | null = null;
  /** 最後一次 bufferedchange 的終點（沒有範圍時為 null）、節流的 timer 與節流期間是否有變動。 */
  #bufferedEmitted: number | null = null;
  #bufferedTimer: ReturnType<typeof setTimeout> | null = null;
  #bufferedPending = false;

  /**
   * 會改變輸出的指令（load、seek）、致命錯誤與 destroy 遞增；Worker 與 worklet 的訊息 epoch 不符即丟棄。
   * 事件一律同步 dispatch，listener 可以在其中呼叫任何指令，所以 dispatch 之後要先以 epoch 確認
   * 目前的操作沒有被取代，才繼續發布狀態或事件。
   */
  #epoch = 0;
  #trackSeq = 0;
  /** 這份媒體是否播放過；seek 結束時決定回到 `'ready'` 或 `'paused'`。 */
  #played = false;
  #worker: MediaWorker | null = null;
  /**
   * 影片輸出：依音訊時鐘繪製 Worker 送來的 VideoFrame、這個 epoch 的影片是否備妥（還沒時 worklet 先停住，load 與 seek
   * 等它才完成，畫面與聲音一起開始），以及背景中暫停（`suspendVideoWhenHidden`）。
   */
  readonly #video: VideoOutput;
  /** 送出 cue 的字幕軌（已送出 `start`／`select`）；沒有選用字幕軌時為 null。 */
  #subtitleTrackId: string | null = null;
  /** Worker 正在輸出的音軌（已送出 `start`／`select`）；不輸出音訊時為 null。 */
  #audioTrackId: string | null = null;
  /** 每個 kind 最後一個要求它的 `selectTracks()`。 */
  readonly #selectOwners: Partial<Record<TrackKind, SelectRequest>> = {};
  /** 執行中的換軌；新軌生效（或失敗）之前收到的 cue 先留著，生效、發出 trackschange 之後才送出。 */
  #switching: Switching | null = null;
  /**
   * load 完成（軌道公布）或換軌生效之前收到的 cue，帶著收到時的 epoch；完成時送出仍是目前 epoch 的那些。
   */
  #pendingCues: { epoch: number; cues: readonly WireCue[] }[] = [];
  /**
   * Worker 回報音訊已送完（`audioend`）的 epoch：音軌比影片短時，之後的影片 demux 不再受音訊的進度約束，回到前景時要
   * 重新 seek。
   */
  #audioEndedEpoch = -1;
  /** 取消訂閱頁面的可見性；`suspendVideoWhenHidden: false` 時為 null。 */
  #unsubscribeVisibility: (() => void) | null = null;
  /** 建立後還沒 terminate 的 media Worker 數（`getStats().resources.workers`）。 */
  #liveWorkers = 0;
  /** AudioContext 與 worklet；`suspend()`、`resume()`、`close()` 都經它的串行佇列。 */
  readonly #context: AudioContextLifecycle;
  /** 最後一次告訴 worklet 的播放意圖；null 表示這個音訊輸出還沒收到過。 */
  #workletPlay: boolean | null = null;
  /** 這個 epoch 的 worklet 最後回報的輸出；啟動 context 失敗時依它結束等待中的狀態。flush 時清掉。 */
  #lastOutput: 'playing' | 'paused' | null = null;
  /** 最後一次改變播放意圖的原因；worklet 確認之後的 state 轉換沿用它。 */
  #intentReason: StateChangeReason = 'command';
  /** 沒有在播（暫停中、idle、error）且 context 執行中時，`IDLE_SUSPEND_MS` 後 suspend 的 timer。 */
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** watchdog：playing 期間 worklet 回報的最大 frame、逾時的 timer，與目前在第幾步。frame 前進時歸零。 */
  #watchdogFrame = -Infinity;
  #watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  #watchdogStep = 0;
  #wasm: Promise<WasmAssets> | null = null;
  #loadContext: LoadContext | null = null;
  /** 最近一次 `load()` 的來源與選項，`reload()` 以它重新開檔。 */
  #lastLoad: { source: Source; options: LoadOptions } | null = null;
  /** 當前媒體的外掛音軌的來源與 Worker 的回覆；`reload()` 以它在新的 Worker 重新加入。load、unload 時清掉。 */
  readonly #externals = new ExternalAudioSources((get, signal) => this.#waitFor(get, signal));
  #isDestroyed = false;
  #destroying: Promise<void> | null = null;

  constructor(deps: EngineDeps, options: ResolvedEngineOptions) {
    super();
    this.#deps = deps;
    this.#options = options;
    this.#log = new Logger(options.log, options.logLevel);
    this.#video = new VideoOutput({
      clock: () => this.currentTime,
      closed: (source, count) => {
        // 被 terminate 的 Worker 不必再知道。
        if (source === this.#worker) this.#worker?.post({ type: 'frameclosed', count });
      },
      resized: (size) => {
        this.dispatchEvent(new VideoResizeEvent({ size }));
      },
      // 背景中暫停影片解碼（`suspendVideoWhenHidden` 且 `document.hidden`）。
      suspended: options.suspendVideoWhenHidden && deps.visibility.hidden,
      // 換軌等新軌的畫面（#outputReady()）。
      pictured: () => {
        this.#notify();
      },
    });
    this.#video.attach(options.canvas);
    if (options.suspendVideoWhenHidden) {
      this.#unsubscribeVisibility = deps.visibility.subscribe(() => {
        this.#onVisibilityChange();
      });
    }
    const { audioBuffer, audioFadeMs, assets } = options;
    this.#context = new AudioContextLifecycle(
      (handlers, config) => {
        const output = deps.createAudioOutput(handlers, config);
        output.setGain(this.#gain, false);
        output.post({ type: 'rate', rate: this.#rate });
        return output;
      },
      {
        audioBuffer,
        audioFadeMs,
        ...(assets.workletUrl !== undefined && { workletUrl: assets.workletUrl }),
        logLevel: this.#log.wireLevel,
      },
      {
        message: (message) => {
          this.#onWorkletMessage(message);
        },
        beforeStart: (cause) => {
          this.dispatchEvent(new BeforeAudioStartEvent({ cause }));
        },
        changed: (change) => {
          this.#onContextChange(change);
        },
        runningChanged: () => {
          this.#syncWorklet();
          this.#updateIdleSuspend();
        },
        log: (entry) => {
          this.#log.forward(entry);
        },
      },
    );
  }

  get #audio(): AudioOutput | null {
    return this.#context.output;
  }

  get state(): EngineState {
    return this.#state;
  }
  get paused(): boolean {
    return this.#paused;
  }
  get currentTime(): number {
    const clock = this.#clock;
    const audio = this.#audio;
    const state = this.#state;
    const stopped = state === 'paused' || state === 'buffering';
    if ((state !== 'playing' && !stopped) || !clock || !audio) return this.#currentTime;
    const heard = audio.heardFrame();
    if (heard === null) return this.#currentTime;
    // clock：`position` 的 sample 在 context frame `frame` 進入 graph，之後每個 frame 推進 `rate / sampleRate` 秒；
    // 聽到的 frame 已扣掉輸出延遲。
    let time = clock.position + ((heard - clock.frame) * clock.rate) / audio.sampleRate;
    // 時鐘停住（pause 的淡出結束、ring 用完）之後，輸出延遲內聽到的還是停住之前的 sample。
    if (stopped || this.#starved) time = Math.min(time, clock.position);
    time = Math.max(time, this.#heardFloor);
    if (!Number.isNaN(this.#duration)) time = Math.min(time, this.#duration);
    this.#heardFloor = time;
    return time;
  }
  get duration(): number {
    return this.#duration;
  }
  get buffered(): readonly TimeRange[] {
    if (this.#state === 'idle' || this.#state === 'error') return [];
    if (this.#lastLoad?.source.kind !== 'http') {
      // bytes／blob 整個在本機。
      return this.#media && Number.isFinite(this.#duration)
        ? [{ start: 0, end: this.#duration }]
        : [];
    }
    const buffer = this.#buffer;
    // seek 之後、新 epoch 的進度到來之前，舊的進度不代表新位置。
    if (buffer?.epoch !== this.#epoch) return [];
    const start = this.currentTime;
    const end = Number.isNaN(this.#duration) ? buffer.end : Math.min(buffer.end, this.#duration);
    return end > start ? [{ start, end }] : [];
  }
  get media(): MediaInfo | null {
    return this.#media;
  }
  get tracks(): readonly Track[] {
    return this.#tracks;
  }
  get selectedTracks(): Readonly<TrackSelection> {
    return this.#selected;
  }
  get error(): EngineError | null {
    return this.#error;
  }
  get audioUnlocked(): boolean {
    return this.#context.unlocked;
  }
  get videoSize(): VideoSize | null {
    return this.#video.size;
  }

  get volume(): number {
    return this.#volume;
  }
  set volume(value: number) {
    if (!(value >= 0 && value <= 1)) {
      throw new RangeError(`volume 必須在 0–1 之間，收到 ${String(value)}`);
    }
    this.#volume = value;
    this.#audio?.setGain(this.#gain, true);
  }
  get muted(): boolean {
    return this.#muted;
  }
  set muted(value: boolean) {
    this.#muted = value;
    this.#audio?.setGain(this.#gain, true);
  }

  /** worklet 後面的 GainNode 的值；靜音只在這裡，不影響音訊時鐘。 */
  get #gain(): number {
    return this.#muted ? 0 : this.#volume;
  }
  get playbackRate(): number {
    return this.#rate;
  }
  set playbackRate(value: number) {
    if (!(value >= MIN_RATE && value <= MAX_RATE)) {
      throw new RangeError(
        `playbackRate 必須在 ${String(MIN_RATE)}–${String(MAX_RATE)} 之間，收到 ${String(value)}`,
      );
    }
    if (value === this.#rate) return;
    this.#rate = value;
    // 不遞增 epoch：已經送出的 PCM 照舊速度播完（ADR-0004）。worklet 只用它推進沒有音訊時的靜音。
    this.#worker?.post({ type: 'rate', rate: value });
    this.#audio?.post({ type: 'rate', rate: value });
  }

  unlockAudio(): void {
    if (this.#isDestroyed) return;
    void this.#startAudio();
    // 趁使用者操作時先 compile wasm；失敗時 load 再重試並回報。
    if (!this.#destroyedDuring()) this.#loadWasm().catch(() => undefined);
  }

  // ───────────────────────────── 指令 ─────────────────────────────

  load(source: Source, options: LoadOptions = {}): Promise<MediaInfo> {
    if (this.#isDestroyed) return Promise.reject(this.#destroyedError());
    // 外部取消等同被取代：已經 abort 時什麼都不做。
    if (options.signal?.aborted) return Promise.reject(abortError());
    this.#log.log('debug', 'command', 'load', {
      source: source.kind,
      ...(source.kind === 'http' && { url: String(source.url) }),
      ...(options.startTime !== undefined && { startTime: options.startTime }),
      ...(options.paused !== undefined && { paused: options.paused }),
    });
    // 與 play() 一樣在呼叫內同步解鎖。
    const starting = options.paused === false ? this.#startAudio() : null;
    // beforeaudiostart 的 listener 可能已經 destroy()。
    if (this.#destroyedDuring()) return Promise.reject(this.#destroyedError());
    return this.#queue.enqueue(
      'load',
      (signal) => this.#runCancelableLoad(source, options, starting, signal),
      () => true,
    );
  }

  reload(): Promise<MediaInfo> {
    if (this.#isDestroyed) return Promise.reject(this.#destroyedError());
    this.#log.log('debug', 'command', 'reload');
    // 保留播放意圖：要接續播放時與 play() 一樣在呼叫內同步解鎖。
    const starting = this.#paused ? null : this.#startAudio();
    if (this.#destroyedDuring()) return Promise.reject(this.#destroyedError());
    return this.#queue.enqueue(
      'load',
      (signal) => this.#runReload(starting, signal),
      () => true,
    );
  }

  play(): Promise<void> {
    if (this.#isDestroyed) return Promise.reject(this.#destroyedError());
    this.#log.log('debug', 'command', 'play');
    // 在呼叫內同步建立或 resume AudioContext，user gesture 才算數。
    const starting = this.#startAudio();
    if (this.#destroyedDuring()) return Promise.reject(this.#destroyedError());
    this.#changeIntent(false);
    const playing = this.#queue.enqueue(
      'play',
      (signal) => this.#runPlay(starting, signal),
      (k) => k === 'pause',
    );
    this.#announceIntent();
    return playing;
  }

  pause(): Promise<void> {
    if (this.#isDestroyed) return Promise.reject(this.#destroyedError());
    this.#log.log('debug', 'command', 'pause');
    this.#changeIntent(true);
    const pausing = this.#queue.enqueue(
      'pause',
      (signal) => this.#runPause(signal),
      (k) => k === 'play',
    );
    this.#announceIntent();
    return pausing;
  }

  seek(time: number): Promise<number> {
    if (this.#isDestroyed) return Promise.reject(this.#destroyedError());
    if (!Number.isFinite(time)) {
      return Promise.reject(new TypeError(`seek() 的時間必須是有限數，收到 ${String(time)}`));
    }
    this.#log.log('debug', 'command', 'seek', { time });
    if (this.#loadContext) return this.#seekWhileLoading(this.#loadContext, time);
    return this.#queue.enqueue(
      'seek',
      (signal) => this.#runSeek(time, signal),
      (k) => k === 'seek',
    );
  }

  selectTracks(selection: Partial<TrackSelection>): Promise<void> {
    if (this.#isDestroyed) return Promise.reject(this.#destroyedError());
    const request: SelectRequest = { selection: {} };
    for (const kind of trackKinds) {
      const value = selection[kind];
      if (value !== undefined) request.selection[kind] = value;
    }
    this.#log.log('debug', 'command', 'selectTracks', { ...request.selection });
    for (const kind of kindsOf(request)) this.#selectOwners[kind] = request;
    const result = this.#queue.enqueue(
      'select',
      (signal) => this.#runSelect(request, signal),
      (kind, tag) =>
        kind === 'select' &&
        tag !== undefined &&
        tag !== request &&
        this.#ownedKinds(tag).length === 0,
      request,
    );
    // 執行中的換軌可能被接手了部分的 kind：讓它以仍負責的 kind 重新輸出（#runSelect）。
    this.#notify();
    return result;
  }
  addExternalAudio(
    source: Source,
    options: { offset?: number; label?: string } = {},
  ): Promise<AudioTrack> {
    if (this.#isDestroyed) return Promise.reject(this.#destroyedError());
    const offset = options.offset ?? 0;
    if (!Number.isFinite(offset)) {
      return Promise.reject(
        new TypeError(`addExternalAudio() 的 offset 必須是有限數，收到 ${String(offset)}`),
      );
    }
    this.#log.log('debug', 'command', 'addExternalAudio', {
      source: source.kind,
      ...(source.kind === 'http' && { url: String(source.url) }),
      offset,
    });
    return this.#queue.enqueue('external', (signal) =>
      this.#runAddExternalAudio(source, offset, options.label, signal),
    );
  }
  removeExternalAudio(trackId: string): Promise<void> {
    if (this.#isDestroyed) return Promise.reject(this.#destroyedError());
    this.#log.log('debug', 'command', 'removeExternalAudio', { trackId });
    return this.#queue.enqueue('external', (signal) =>
      this.#runRemoveExternalAudio(trackId, signal),
    );
  }
  setAudioOffset(trackId: string, offset: number): Promise<void> {
    if (this.#isDestroyed) return Promise.reject(this.#destroyedError());
    if (!Number.isFinite(offset)) {
      return Promise.reject(
        new TypeError(`setAudioOffset() 的 offset 必須是有限數，收到 ${String(offset)}`),
      );
    }
    this.#log.log('debug', 'command', 'setAudioOffset', { trackId, offset });
    return this.#queue.enqueue('offset', (signal) =>
      this.#runSetAudioOffset(trackId, offset, signal),
    );
  }
  unload(): Promise<void> {
    if (this.#isDestroyed) return Promise.reject(this.#destroyedError());
    this.#log.log('debug', 'command', 'unload');
    return this.#queue.enqueue(
      'unload',
      () => {
        this.#clearMedia();
        return Promise.resolve();
      },
      () => true,
    );
  }

  destroy(): Promise<void> {
    if (!this.#destroying) this.#log.log('debug', 'command', 'destroy');
    this.#destroying ??= this.#runDestroy();
    return this.#destroying;
  }

  attachCanvas(canvas: HTMLCanvasElement | null): void {
    this.#video.attach(canvas);
  }
  /**
   * 彙整主執行緒（音訊輸出、buffered、影片的 dropped 與持有的 VideoFrame）與 media Worker（快取、網路、封包佇列、
   * wasm heap、libav instance、影片解碼）的數字。
   */
  async getStats(): Promise<EngineStats> {
    const worker = await this.#workerStats();
    const audio = this.#audio;
    const sampleRate = audio?.sampleRate ?? 0;
    const [range] = this.buffered;
    return {
      bufferAhead: range ? Math.max(0, range.end - this.currentTime) : 0,
      audio: {
        ringMs: sampleRate > 0 ? (this.#ringFrames * 1000) / sampleRate : 0,
        underruns: this.#underruns,
        outputLatencyMs: (audio?.outputLatency() ?? 0) * 1000,
        targetMs: this.#options.audioBuffer.targetMs,
      },
      video: this.#video.track
        ? {
            decoded: worker?.video?.decoded ?? 0,
            dropped: this.#video.dropped,
            decodeQueueSize: worker?.video?.decodeQueueSize ?? 0,
            avgDecodeMs: worker?.video?.avgDecodeMs ?? 0,
          }
        : null,
      packetQueue: worker?.packetQueue ?? { audioSeconds: 0, videoSeconds: 0, bytes: 0 },
      cache: {
        bytes: worker?.cache.bytes ?? 0,
        limitBytes: this.#options.limits.cacheBytes,
        aheadBytes: worker?.cache.aheadBytes ?? 0,
        readaheadTarget: worker?.cache.readaheadTarget ?? 0,
        fetching: worker?.cache.fetching ?? false,
        hits: worker?.cache.hits ?? 0,
        misses: worker?.cache.misses ?? 0,
      },
      network: worker?.network ?? { bytesLoaded: 0, inflight: [] },
      wasmHeapBytes: worker?.wasmHeapBytes ?? 0,
      resources: {
        workers: this.#liveWorkers,
        libavInstances: worker?.libavInstances ?? 0,
        openVideoFrames: this.#video.open + (worker?.openVideoFrames ?? 0),
      },
    };
  }

  // ───────────────────────────── 指令的執行 ─────────────────────────────

  /**
   * 以最近一次 `load()` 的來源重新開檔。媒體的鏡像（`media`、`tracks`、`selectedTracks`、`duration`）在 reload
   * 期間維持原狀；沒有完成過的 load（例如 load 本身失敗）就以同樣的選項重新 load。
   */
  async #runReload(starting: Promise<StartResult> | null, signal: AbortSignal): Promise<MediaInfo> {
    const last = this.#lastLoad;
    if (!last || this.#state === 'idle') {
      throw new DOMException(
        `state 為 '${this.#state}'，沒有可以 reload 的媒體`,
        'InvalidStateError',
      );
    }
    const position =
      this.#state === 'error' ? (this.#error?.position ?? this.#currentTime) : this.currentTime;
    const previous = this.#media ? { info: this.#media, selection: { ...this.#selected } } : null;
    return this.#runLoad(
      last.source,
      { ...last.options, startTime: position, paused: this.#paused },
      starting,
      signal,
      previous,
    );
  }

  /**
   * 帶 `options.signal` 的 load：signal abort 時與被取代一樣中止這個 load，並以 AbortError reject（不論 reason）。
   * 沒有下一個 load 接手，所以由這裡結束媒體、回到 `'idle'`。load 結束後就不再看 signal。
   */
  async #runCancelableLoad(
    source: Source,
    options: LoadOptions,
    starting: Promise<StartResult> | null,
    signal: AbortSignal,
  ): Promise<MediaInfo> {
    const external = options.signal;
    if (!external) return this.#runLoad(source, options, starting, signal);
    const controller = new AbortController();
    const onSuperseded = () => {
      controller.abort(signal.reason);
    };
    const onCanceled = () => {
      controller.abort(abortError());
    };
    signal.addEventListener('abort', onSuperseded);
    external.addEventListener('abort', onCanceled);
    try {
      return await this.#runLoad(source, options, starting, controller.signal);
    } catch (error) {
      if (external.aborted && !signal.aborted) this.#clearMedia();
      throw error;
    } finally {
      signal.removeEventListener('abort', onSuperseded);
      external.removeEventListener('abort', onCanceled);
    }
  }

  async #runLoad(
    source: Source,
    options: LoadOptions,
    starting: Promise<StartResult> | null,
    signal: AbortSignal,
    reloadOf: ReloadOf | null = null,
  ): Promise<MediaInfo> {
    this.#terminateWorker();
    if (!reloadOf) {
      // 外掛音軌屬於上一份媒體。
      this.#externals.clear();
      // reload() 不沿用這次 load 的 signal。
      const rest = { ...options };
      delete rest.signal;
      this.#lastLoad = { source, options: rest };
    }
    const epoch = ++this.#epoch;
    const startTime = Number.isFinite(options.startTime) ? Math.max(0, options.startTime ?? 0) : 0;
    const load: LoadContext = {
      startTime,
      flushedAt: startTime,
      probed: null,
      info: null,
      selection: noSelection,
      seek: null,
    };
    this.#loadContext = load;
    signal.addEventListener('abort', () => {
      load.seek?.reject(abortReason(signal));
      if (this.#loadContext === load) this.#loadContext = null;
    });
    this.#resetMediaState();
    this.#video.stop();
    // reload：畫面上的 frame 留到新的 frame 畫出。
    if (!reloadOf) this.#video.reset(epoch);
    this.#currentTime = startTime;
    if (!reloadOf) this.#publishMedia(null, noSelection);
    signal.throwIfAborted();
    this.#intentReason = 'command';
    this.#setState('loading', 'command', options.paused ?? true);
    signal.throwIfAborted();
    // load() 內的解鎖失敗：播放意圖回到暫停，以 'ready' 完成。
    void starting?.then((result) => {
      if (result !== 'running' && this.#loadContext === load) this.#onStartFailed('command');
    });

    try {
      const audio = this.#audioOutput();
      this.#flushAudio(startTime);
      this.#syncWorklet(true);
      const worker = this.#spawnWorker();
      const [wasm, port] = await abortable(
        Promise.all([this.#loadWasm(), this.#connect(audio)]),
        signal,
      );
      signal.throwIfAborted();
      worker.post(
        {
          type: 'init',
          module: wasm.module,
          glueUrl: wasm.glueUrl,
          workletPort: port,
          sampleRate: audio.sampleRate,
          retry: this.#options.retry,
          limits: this.#options.limits,
          rate: this.#rate,
          logLevel: this.#log.wireLevel,
        },
        [port],
      );
      worker.post({ type: 'load', epoch, source: toWireSource(source) });
      // reload：外掛音軌以同一個 id 在新的 Worker 重新開啟。
      const externals = reloadOf ? this.#externals.entries() : [];
      for (const [id, external] of externals) this.#externals.request(worker, id, external);
      // 背景中 load：一開始就不解碼影片。
      if (this.#video.suspended) worker.post({ type: 'videosuspend', suspended: true, time: 0 });

      const probed = await this.#waitFor(() => load.probed, signal);
      signal.throwIfAborted();
      let tracks: readonly Track[];
      if (reloadOf) {
        // reload：軌道與 track id 沿用，組成不同就不能接續。
        if (!sameTrackStructure(reloadOf.info.tracks, probed.tracks)) {
          throw this.#fatal('SOURCE_CHANGED', '重新開檔後軌道的組成與先前不同');
        }
        tracks = reloadOf.info.tracks;
        load.selection = reloadOf.selection;
        for (const [id] of externals) {
          const before = reloadOf.info.tracks.find((t) => t.id === id);
          const failure = await this.#externals.reopened(
            id,
            before,
            signal,
            () => this.currentTime,
          );
          if (!failure) continue;
          // 外掛音軌重開失敗不影響主媒體：移除它（選用中時改選容器內的預設音軌），發出非致命的 error。
          this.#forgetExternal(id);
          tracks = tracks.filter((t) => t.id !== id);
          if (load.selection.audio === id) {
            load.selection = { ...load.selection, audio: this.#defaultAudio(tracks) };
          }
          this.#logError('warn', failure);
          this.dispatchEvent(new EngineErrorEvent({ error: failure }));
          signal.throwIfAborted();
        }
      } else {
        tracks = toContainerTracks(probed.tracks, () => ++this.#trackSeq);
        load.selection = selectInitialTracks(
          tracks,
          options.tracks,
          this.#preferredLanguages(options.preferredLanguages),
        );
      }
      const info: MediaInfo = {
        format: probed.format,
        duration: probed.duration,
        size: probed.size,
        tracks,
      };
      load.info = info;
      load.startTime = clamp(load.startTime, probed.duration);
      this.#currentTime = load.startTime;
      if (load.startTime !== load.flushedAt) {
        // 起點被 duration 夾住：換一個 epoch，讓 worklet 從新的位置開始。
        this.#epoch++;
        this.#flushAudio(load.startTime);
      }
      // worklet 以 duration 截掉多的音訊、在 eof 之後補靜音並判定 ended；Worker 開始供料之前送到。
      audio.post({ type: 'duration', epoch: this.#epoch, duration: probed.duration });
      const audioTrack = tracks.find((t) => t.id === load.selection.audio);
      const videoTrack = tracks.find(
        (t): t is VideoTrack => t.kind === 'video' && t.id === load.selection.video,
      );
      const subtitleTrack = tracks.find(
        (t) => t.kind === 'subtitle' && t.supported && t.id === load.selection.subtitle,
      );
      if (videoTrack) this.#startVideo(videoTrack);
      this.#audioTrackId = audioTrack?.id ?? null;
      this.#subtitleTrackId = subtitleTrack?.id ?? null;
      worker.post({
        type: 'start',
        epoch: this.#epoch,
        time: load.startTime,
        ...audioSelectionFields(audioTrack?.kind === 'audio' ? audioTrack : undefined),
        video: videoTrack?.streamIndex ?? null,
        subtitle: subtitleTrack?.streamIndex ?? null,
      });

      // worklet 回報後，#applyOutput() 結束 load、發布媒體並離開 loading。
      await this.#until(() => this.#loadContext !== load, signal);
      signal.throwIfAborted();
      // 影片軌 configure 失敗時 info 已換成標為不支援的那份。
      return load.info;
    } catch (error) {
      if (!signal.aborted) this.#fail(this.#toEngineError(error));
      throw error;
    }
  }

  #seekWhileLoading(load: LoadContext, time: number): Promise<number> {
    load.seek?.reject(abortError());
    const seek = deferred<number>();
    load.seek = seek;
    if (load.info) {
      load.startTime = clamp(time, load.info.duration);
      this.#retarget(load.startTime);
    } else {
      // 還沒送出 start：只改起點，probe 之後再夾到 duration。
      load.startTime = Math.max(0, time);
      this.#currentTime = load.startTime;
    }
    return seek.promise;
  }

  async #runPlay(starting: Promise<StartResult>, signal: AbortSignal): Promise<void> {
    this.#assertMedia();
    const result = await abortable(starting, signal);
    signal.throwIfAborted();
    // 播放意圖已經在 #onStartFailed() 回到暫停。
    if (result === 'interrupted') {
      throw new EngineError('AUDIO_OUTPUT', {
        fatal: false,
        position: this.currentTime,
        message: 'AudioContext 處於系統中斷，無法恢復',
      });
    }
    if (result === 'locked') {
      throw new EngineError('AUDIO_LOCKED', {
        fatal: false,
        position: this.currentTime,
        message: '沒有 user gesture，AudioContext 無法開始',
      });
    }
    if (this.#state === 'ended') this.#beginSeek(0);
    await this.#until(() => this.#state === 'playing', signal);
  }

  async #runPause(signal: AbortSignal): Promise<void> {
    await this.#until(() => this.#state !== 'playing' && this.#state !== 'buffering', signal);
  }

  async #runSeek(time: number, signal: AbortSignal): Promise<number> {
    this.#assertMedia();
    const target = clamp(time, this.#duration);
    this.#beginSeek(target);
    // worklet 回報後，#applyOutput() 離開 seeking 並發出 seeked。
    await this.#until(() => this.#state !== 'seeking', signal);
    return target;
  }

  /**
   * selectTracks：只套用這個要求仍負責的 kind（被較新的呼叫接手的 kind 交給它們，其餘沿用已生效的）。先檢查全部的 kind，
   * 有任何一個不能選就整個要求不生效：被取代的換軌可能已經改了 Worker 的輸出，先換回已生效的選擇再 reject。選擇與正在
   * 輸出、已生效的都相同時什麼都不做。換軌途中被接手了部分的 kind 時，以仍負責的 kind 重新輸出，不以舊的選擇發布。
   */
  async #runSelect(request: SelectRequest, signal: AbortSignal): Promise<void> {
    this.#assertMedia();
    for (;;) {
      const owned = this.#ownedKinds(request);
      let next: TrackSelection;
      try {
        next = this.#requestedSelection(request, owned);
      } catch (error) {
        await this.#restoreOutput(signal);
        throw error;
      }
      const output = this.#outputSelection();
      if (sameSelection(next, this.#selected) && sameSelection(next, output)) return;
      const lost = () => this.#ownedKinds(request).length !== owned.length;
      if (await this.#switchTracks(next, signal, undefined, lost)) return;
    }
  }

  /** `request` 以 `owned` 的 kind 套用在已生效的選擇上；不能選的軌丟出（見 `#checkSelectable()`）。 */
  #requestedSelection(request: SelectRequest, owned: readonly TrackKind[]): TrackSelection {
    const next: TrackSelection = { ...this.#selected };
    for (const kind of owned) {
      const value = request.selection[kind];
      if (value === undefined) continue;
      if (value !== null) this.#checkSelectable(kind, value);
      next[kind] = value;
    }
    return next;
  }

  /** Worker 正在輸出的不是已生效的選擇（被取代的換軌改了輸出）：換回已生效的選擇，等它重新輸出。 */
  async #restoreOutput(signal: AbortSignal): Promise<void> {
    if (sameSelection(this.#outputSelection(), this.#selected)) return;
    await this.#returnToSelected(signal);
  }

  /** 以已生效的選擇重新輸出（丟掉換軌期間留著的 cue），等它備妥。 */
  async #returnToSelected(signal: AbortSignal): Promise<void> {
    this.#pendingCues = [];
    // 原本沒有選用影片：renderer 不再畫失敗或被取代的那條軌。
    if (this.#selected.video === null) this.#video.setTrack(null);
    // videoresize 的 listener 可能已經取代了回復指令。
    signal.throwIfAborted();
    this.#applySelection(this.#selected);
    await this.#until(() => this.#outputReady(), signal);
  }

  /** `request` 仍負責的 kind：沒有被較新的 `selectTracks()` 接手的。 */
  #ownedKinds(request: SelectRequest): TrackKind[] {
    return kindsOf(request).filter((kind) => this.#selectOwners[kind] === request);
  }

  /** `id` 是否能選為 `kind` 的軌：不存在（或 kind 不符）丟 `RangeError`；不支援丟非致命的 `CODEC_UNSUPPORTED`。 */
  #checkSelectable(kind: TrackKind, id: string): void {
    const track = this.#tracks.find((t) => t.id === id);
    if (track?.kind !== kind) {
      throw new RangeError(`沒有 id 為 '${id}' 的 ${kind} 軌`);
    }
    if (!track.supported) {
      throw new EngineError('CODEC_UNSUPPORTED', {
        fatal: false,
        position: this.currentTime,
        message: `軌道 '${id}' 不支援（${track.unsupportedReason ?? 'codec'}）`,
      });
    }
  }

  /** Worker 正在輸出的各軌。 */
  #outputSelection(): TrackSelection {
    return {
      audio: this.#audioTrackId,
      video: this.#video.track?.id ?? null,
      subtitle: this.#subtitleTrackId,
    };
  }

  /**
   * 換成 `next`：從目前位置以新的 epoch 重新供料（state 不變），等新軌出聲（播放中時 worklet 開始輸出；暫停中時資料
   * 備妥）、影片的第一張 frame 畫出後才公布 `selectedTracks` 並發出 trackschange，再送出期間留著的 cue。
   * 新的影片軌 configure 或首個 keyframe 失敗時：該軌改為不支援、發出 trackschange，換回原本生效的軌，reject 非致命的
   * `CODEC_UNSUPPORTED`。生效之前 `stale()` 變成 true 時不公布、回傳 false（呼叫端以新的選擇重來）；生效時回傳 true。
   */
  async #switchTracks(
    next: TrackSelection,
    signal: AbortSignal,
    /** 生效時一起公布的軌道變化（例如移除外掛音軌）。 */
    change: (media: MediaInfo) => MediaInfo = (media) => media,
    stale: () => boolean = () => false,
  ): Promise<boolean> {
    const switching: Switching = { next: { ...next }, failed: null };
    this.#switching = switching;
    try {
      this.#applySelection(next);
      await this.#until(() => switching.failed !== null || stale() || this.#outputReady(), signal);
      const failed = switching.failed;
      this.#switching = null;
      if (!failed && stale()) return false;
      const epoch = this.#epoch;
      if (failed) {
        await this.#revertSwitch(failed, signal);
        // 外掛音軌沿用 Worker 的錯誤碼（讀取、demux 等也會失敗）；容器內的軌一律是 CODEC_UNSUPPORTED。
        throw fromWireError(
          failed.mark === 'remove' ? failed.error : { ...failed.error, code: 'CODEC_UNSUPPORTED' },
          { fatal: false, position: this.currentTime, detail: { trackId: failed.trackId } },
        );
      }
      // 關掉影片：畫面上的 frame 留到生效時才清掉（videoSize 回到 null）。
      if (switching.next.video === null) this.#video.setTrack(null);
      if (this.#epoch !== epoch) return true;
      const media = this.#media;
      this.#publishMedia(media && change(media), switching.next);
      if (this.#epoch !== epoch) return true;
      this.#flushPendingCues();
      return true;
    } finally {
      if (this.#switching === switching) this.#switching = null;
    }
  }

  /** 新的軌失敗：標為不支援（外掛音軌則移除）並發出 trackschange，換回目前生效的選擇，等它重新輸出。 */
  async #revertSwitch(failed: SwitchFailure, signal: AbortSignal): Promise<void> {
    const { mark, trackId } = failed;
    if (mark === 'remove') this.#forgetExternal(trackId);
    const media = this.#media;
    if (media) {
      const epoch = this.#epoch;
      this.#publishMedia(
        {
          ...media,
          tracks:
            mark === 'remove'
              ? media.tracks.filter((t) => t.id !== trackId)
              : media.tracks.map((t) =>
                  t.id === trackId ? { ...t, supported: false, unsupportedReason: mark } : t,
                ),
        },
        this.#selected,
      );
      signal.throwIfAborted();
      if (this.#epoch !== epoch) return;
    }
    await this.#returnToSelected(signal);
  }

  /**
   * 加入外掛音軌：Worker 在同一個 Worker 內為來源開新的 libav instance 並 probe。成功時加入 `tracks`（不選用）並發出
   * trackschange；失敗與超過上限都是非致命的錯誤，主媒體不受影響。
   */
  async #runAddExternalAudio(
    source: Source,
    offset: number,
    label: string | undefined,
    signal: AbortSignal,
  ): Promise<AudioTrack> {
    this.#assertMedia();
    const count = this.#tracks.filter((t) => t.origin === 'external').length;
    if (count >= MAX_EXTERNAL_AUDIO) {
      throw new EngineError('MEMORY_LIMIT', {
        fatal: false,
        position: this.currentTime,
        message: `每份媒體最多 ${String(MAX_EXTERNAL_AUDIO)} 條外掛音軌`,
      });
    }
    const id = `ext:${String(++this.#trackSeq)}`;
    const worker = this.#worker;
    if (!worker) throw new DOMException('沒有 media Worker', 'InvalidStateError');
    const probed = await this.#externals.open(worker, id, source, signal, () => this.currentTime);
    this.#externals.add(id, source);
    const track: AudioTrack = {
      ...probed,
      id,
      origin: 'external',
      offset,
      ...(label !== undefined && { title: label }),
    };
    const media = this.#media;
    if (media) this.#publishMedia({ ...media, tracks: [...media.tracks, track] }, this.#selected);
    return track;
  }

  /**
   * 移除外掛音軌。選用中（或正在輸出）時先切回容器內的預設音軌，生效時一起公布移除（一次 trackschange）；之後才讓
   * Worker 丟掉它的 instance（Worker 已經不再輸出它）。
   */
  async #runRemoveExternalAudio(trackId: string, signal: AbortSignal): Promise<void> {
    this.#assertMedia();
    const track = this.#tracks.find((t) => t.id === trackId);
    if (track?.kind !== 'audio' || track.origin !== 'external') {
      throw new RangeError(`沒有 id 為 '${trackId}' 的外掛音軌`);
    }
    const without = (media: MediaInfo): MediaInfo => ({
      ...media,
      tracks: media.tracks.filter((t) => t.id !== trackId),
    });
    if (this.#audioTrackId === trackId || this.#selected.audio === trackId) {
      await this.#switchTracks({ ...this.#selected, audio: this.#defaultAudio() }, signal, without);
      // trackschange 的 listener 可能已經換檔（Worker 已經 terminate）。
      signal.throwIfAborted();
    } else if (this.#media) {
      this.#publishMedia(without(this.#media), this.#selected);
    }
    this.#forgetExternal(trackId);
  }

  /** 外掛音軌不再屬於這份媒體：之後的 reload 不再加入，Worker 丟掉它的 instance。 */
  #forgetExternal(trackId: string): void {
    this.#externals.delete(trackId);
    this.#worker?.post({ type: 'removeaudio', id: trackId });
  }

  /**
   * 播放中外掛音軌失敗（Worker 已丟掉它的 instance，這個 epoch 的音訊以靜音結束）：發出非致命的 `error`，再經指令佇列
   * 與 `removeExternalAudio()` 一樣移除它（選用中時切回容器內的預設音軌）。
   */
  #onExternalFailed(trackId: string, error: WireError): void {
    const engineError = fromWireError(error, {
      fatal: false,
      position: this.currentTime,
      message: `外掛音軌無法播放：${error.message}`,
      detail: { trackId },
    });
    this.#logError('warn', engineError);
    const epoch = this.#epoch;
    this.dispatchEvent(new EngineErrorEvent({ error: engineError }));
    if (this.#epoch !== epoch || this.#destroyedDuring()) return;
    // 已經被移除（例如 listener 內呼叫了 removeExternalAudio()）或換檔時，移除的指令以錯誤結束，不必回報。
    this.#queue
      .enqueue('external', (signal) => this.#runRemoveExternalAudio(trackId, signal))
      .catch(() => undefined);
  }

  /** Worker 回報這個 epoch 的音軌無法輸出（`source` 為 null 是主來源的音軌，否則是外掛音軌的 id）。 */
  #onAudioFailed(source: string | null, error: WireError): void {
    const trackId = source ?? this.#audioTrackId;
    this.#log.log('warn', 'audio', error.message, {
      code: error.code,
      ...(trackId !== null && { track: trackId }),
    });
    const switching = this.#switching;
    if (switching && trackId !== null && trackId !== this.#selected.audio) {
      // 換軌中新的音軌失敗：由 #switchTracks() 標為不支援（外掛音軌則移除）並換回原本的軌。
      switching.failed = { trackId, error, mark: source === null ? 'codec' : 'remove' };
      this.#notify();
      return;
    }
    if (source !== null) {
      this.#onExternalFailed(source, error);
      return;
    }
    // 不是換軌（例如 load 的第一個輸出）：沒有可以退回的音軌。
    this.#fail(fromWireError(error, { fatal: true, position: this.currentTime }));
  }

  /** 容器內的預設音軌：與 load 的初始選擇相同（偏好語言 → default 旗標 → 第一條可播的）。 */
  #defaultAudio(tracks: readonly Track[] = this.#tracks): string | null {
    const container = tracks.filter((t) => t.origin === 'container');
    const preferred = this.#preferredLanguages(this.#lastLoad?.options.preferredLanguages);
    return selectInitialTracks(container, undefined, preferred).audio;
  }

  /** 偏好語言：`load()` 給的依 kind 覆蓋 `createEngine()` 的預設值。 */
  #preferredLanguages(overrides: LoadOptions['preferredLanguages']): {
    audio: readonly string[];
    subtitle: readonly string[];
  } {
    const defaults = this.#options.preferredLanguages;
    return {
      audio: overrides?.audio ?? defaults.audio,
      subtitle: overrides?.subtitle ?? defaults.subtitle,
    };
  }

  /**
   * 改音軌 offset：選用中（Worker 正在輸出）的軌以新的 epoch 從目前位置重新供料，state 短暫進入 seeking，輸出備妥之後才
   * 公布新的 offset（trackschange）；其他軌只記下並公布。
   */
  async #runSetAudioOffset(trackId: string, offset: number, signal: AbortSignal): Promise<void> {
    this.#assertMedia();
    const track = this.#tracks.find((t) => t.id === trackId);
    if (track?.kind !== 'audio') throw new RangeError(`沒有 id 為 '${trackId}' 的音軌`);
    if (track.offset === offset) return;
    const withOffset = (tracks: readonly Track[]): Track[] =>
      tracks.map((t) => (t.id === trackId && t.kind === 'audio' ? { ...t, offset } : t));
    if (this.#audioTrackId === trackId) {
      this.#applySelection(this.#outputSelection(), withOffset(this.#tracks));
      this.#setState('seeking', 'command');
      await this.#until(() => this.#state !== 'seeking', signal);
      // seeked 的 listener 可能已經換檔。
      signal.throwIfAborted();
    }
    const media = this.#media;
    if (media) this.#publishMedia({ ...media, tracks: withOffset(media.tracks) }, this.#selected);
  }

  /**
   * 這個 epoch 的輸出已備妥：worklet 回報過（被要求播放時要等到 playing），影片也備妥，換了影片軌時新軌的 frame 也已畫出
   * （或不再等）。
   */
  #outputReady(): boolean {
    const last = this.#lastOutput;
    return (
      !this.#video.pending &&
      !this.#video.awaitingPicture &&
      last !== null &&
      (last === 'playing' || this.#workletPlay !== true)
    );
  }

  /**
   * 讓 Worker 從目前位置以新的 epoch 輸出 `selection` 的各軌；影片軌換了就重新等第一張 frame。`tracks` 是軌道（含音軌
   * offset）的來源，預設為已公布的。
   */
  #applySelection(selection: TrackSelection, tracks: readonly Track[] = this.#tracks): void {
    const find = (id: string | null) => (id === null ? undefined : tracks.find((t) => t.id === id));
    const audio = find(selection.audio);
    const video = find(selection.video);
    const subtitle = find(selection.subtitle);
    const time = this.currentTime;
    if ((video?.id ?? null) !== (this.#video.track?.id ?? null)) {
      if (video?.kind === 'video') this.#startVideo(video);
      else this.#video.stop();
    }
    this.#audioTrackId = audio?.id ?? null;
    this.#subtitleTrackId = subtitle?.id ?? null;
    // 新軌補滿之前時鐘停住，不是音訊輸出停住。
    this.#stopWatchdog();
    const epoch = ++this.#epoch;
    this.#lastReadError = null;
    this.#worker?.post({
      type: 'select',
      epoch,
      time,
      ...audioSelectionFields(audio?.kind === 'audio' ? audio : undefined),
      video: video?.streamIndex ?? null,
      subtitle: subtitle?.streamIndex ?? null,
    });
    this.#flushAudio(time);
    // 關閉影片會解除前一次換軌的等待；flush 沒有等影片時不會同步播放意圖。
    if (!video) this.#syncWorklet();
  }

  async #runDestroy(): Promise<void> {
    this.#isDestroyed = true;
    this.#unsubscribeVisibility?.();
    this.#unsubscribeVisibility = null;
    this.#queue.close(() => this.#destroyedError());
    // 佇列中與畫面上的 VideoFrame 都在這裡 close。
    this.#clearMedia();
    this.dispatchEvent(new Event('destroy'));
    // 斷開 worklet 並經佇列 close()；佇列的 timeout 保證一定會 settle，失敗也不讓 destroy() 失敗。
    const closing = this.#context.close();
    this.#stopWatchdog();
    this.#updateIdleSuspend();
    await closing;
  }

  /**
   * 結束當前媒體、回到 `'idle'`（`unload()` 與 `destroy()`）：terminate Worker、遞增 epoch 並 flush worklet（停掉 ring
   * 內剩下的聲音），清掉媒體的鏡像與 `reload()` 的來源。AudioContext 與 worklet 不動。
   */
  #clearMedia(): void {
    this.#terminateWorker();
    this.#loadContext = null;
    this.#lastLoad = null;
    this.#externals.clear();
    this.#resetMediaState();
    this.#video.stop();
    const epoch = ++this.#epoch;
    this.#video.reset(epoch);
    this.#flushAudio(0);
    this.#publishMedia(null, noSelection);
    if (this.#epoch !== epoch) return;
    this.#setState('idle', 'command', true);
  }

  /** 換成新的媒體（load）或結束媒體時，清掉屬於上一份媒體的播放紀錄、錯誤、watchdog 的進度、緩衝資訊與字幕。 */
  #resetMediaState(): void {
    this.#subtitleTrackId = null;
    this.#audioTrackId = null;
    this.#switching = null;
    this.#pendingCues = [];
    this.#played = false;
    this.#error = null;
    this.#watchdogStep = 0;
    this.#buffer = null;
    this.#lastReadError = null;
  }

  // ───────────────────────────── 訊息 ─────────────────────────────

  #spawnWorker(): MediaWorker {
    this.#log.log('debug', 'worker', '建立 media Worker');
    const worker: MediaWorker = this.#deps.createWorker({
      message: (message) => {
        // 被取代的 Worker 在 terminate 之前送出的 log 也有診斷價值。
        if (message.type === 'log') {
          this.#log.forward({ ...message.entry, time: fromWorkerTime(message.entry.time) });
          return;
        }
        if (worker !== this.#worker) {
          // 被 terminate 的 Worker 在之前送出的 frame 也要 close。
          if (message.type === 'frame') message.frame.close();
          return;
        }
        switch (message.type) {
          case 'frame':
            this.#video.push(message.epoch, message.frame, worker);
            // 背景中：Worker 在收到 videosuspend 之前送出的 frame 不畫，立即 close。
            if (this.#video.suspended) this.#video.closeQueued(this.#epoch);
            if (message.epoch !== this.#epoch || this.#video.suspended) break;
            this.#video.render();
            // videoresize 的 listener 可能已經 seek 或換檔。
            if (message.epoch === this.#epoch) this.#onVideoReady();
            break;
          case 'videoend':
            if (message.epoch !== this.#epoch) break;
            // 這個 epoch 不會再有 frame：佇列中也沒有時不再等新軌的畫面。
            this.#video.giveUpPicture(false);
            this.#onVideoReady();
            break;
          case 'videoerror':
            if (message.epoch !== this.#epoch) break;
            this.#onVideoError(message.error, message.beforeFirstFrame);
            break;
          case 'cues':
            if (message.epoch !== this.#epoch) break;
            // 軌道公布之前（loading）先留著，App 在 trackschange 拿到 header 之後才收到 cue。
            // 換軌生效之前也一樣。
            if (this.#loadContext || this.#switching) this.#pendingCues.push(message);
            else this.#dispatchCues(message.cues);
            break;
          case 'probe':
            if (this.#loadContext && message.epoch === this.#epoch)
              this.#loadContext.probed = message.media;
            break;
          case 'audioprobe':
            this.#externals.onReply(message.id, { track: message.track });
            break;
          case 'audioerror':
            this.#externals.onReply(message.id, { error: message.error });
            break;
          case 'audiofailed':
            if (message.epoch !== this.#epoch) break;
            this.#onAudioFailed(message.source, message.error);
            break;
          case 'audioend':
            if (message.epoch === this.#epoch) this.#audioEndedEpoch = message.epoch;
            break;
          case 'error': {
            if (message.epoch !== this.#epoch) return;
            const { fatal } = message.error;
            const error = fromWireError(message.error, { fatal, position: this.currentTime });
            if (fatal) {
              this.#fail(error);
            } else {
              this.#logError('warn', error);
              this.dispatchEvent(new EngineErrorEvent({ error }));
            }
            break;
          }
          case 'crash':
            this.#fail(
              this.#fatal('INTERNAL', `media Worker 崩潰（${message.reason}）：${message.message}`),
            );
            break;
          case 'stats':
            this.#statsRequests.get(message.id)?.(message.stats);
            this.#statsRequests.delete(message.id);
            break;
          case 'buffer':
            if (message.epoch !== this.#epoch) break;
            this.#buffer = message;
            this.#checkHold();
            this.#bufferedChanged();
            break;
          case 'readerror':
            this.#lastReadError = message.error;
            break;
        }
        this.#notify();
      },
      crash: (cause) => {
        if (worker !== this.#worker) return;
        this.#fail(
          cause instanceof AssetLoadError
            ? this.#fatal('ASSET_LOAD_FAILED', 'media Worker 的 script 載入失敗', cause)
            : this.#fatal('INTERNAL', 'media Worker 崩潰', cause),
        );
      },
    });
    this.#worker = worker;
    this.#liveWorkers++;
    return worker;
  }

  #onWorkletMessage(message: WorkletToMainMessage): void {
    if (this.#isDestroyed || message.epoch !== this.#epoch) return;
    switch (message.type) {
      case 'clock':
        if (message.frame > this.#watchdogFrame) {
          // 新的音訊輸出的第一個 clock 只是基準，不算前進。
          if (this.#watchdogFrame !== -Infinity) this.#watchdogStep = 0;
          this.#watchdogFrame = message.frame;
          if (this.#state === 'playing') this.#armWatchdog();
        }
        this.#clock = message;
        this.#currentTime = message.position;
        this.#ringFrames = message.buffered;
        this.#underruns = message.underruns;
        break;
      case 'playing':
      case 'paused':
        if (message.type === 'playing') this.#clearStarved();
        this.#applyOutput(message.type);
        break;
      case 'starved':
        this.#starved = true;
        if (this.#state === 'playing') this.#armStarve();
        break;
      case 'ended':
        if (this.#state === 'playing' || this.#state === 'buffering') {
          if (!Number.isNaN(this.#duration)) this.#currentTime = this.#duration;
          // paused 維持 false：App 不接下一首時自己 pause()。
          const epoch = this.#epoch;
          this.#setState('ended', 'media');
          if (this.#epoch === epoch) this.dispatchEvent(new Event('ended'));
        }
        break;
    }
    this.#notify();
  }

  /** worklet 開始輸出（`playing`）或停止輸出、資料已備妥（`paused`）。 */
  #applyOutput(output: 'playing' | 'paused'): void {
    this.#lastOutput = output;
    // 影片還沒備妥：load 與 seek 等第一張 frame（或不再等）之後由 #onVideoReady() 再套用；worklet 被要求停住，
    // 它回報的 paused 也不是使用者的暫停。
    if (
      this.#video.pending &&
      (output === 'paused' || this.#state === 'loading' || this.#state === 'seeking')
    ) {
      this.#armVideoTimer();
      return;
    }
    // 等 bufferAhead 時 worklet 被要求停住，它回報的 paused 不是使用者的暫停。
    if (output === 'paused' && this.#holding && !this.#paused) return;
    // 想播放而 context 還在啟動：等啟動的結果（成功時 worklet 會開始輸出，失敗時 #onStartFailed() 再套用）。
    if (output === 'paused' && !this.#paused && this.#context.starting) return;
    const reason = this.#intentReason;
    switch (this.#state) {
      case 'loading': {
        const load = this.#loadContext;
        if (!load?.info) break;
        // 先結束 load，讓 listener 內的 seek() 走一般的 seek，不再改寫起點。
        const epoch = this.#epoch;
        this.#loadContext = null;
        load.seek?.resolve(load.startTime);
        load.seek = null;
        this.#publishMedia(load.info, load.selection);
        if (this.#epoch !== epoch) break;
        this.#flushPendingCues();
        if (this.#epoch !== epoch) break;
        this.#setState(output === 'playing' ? 'playing' : 'ready', 'media');
        break;
      }
      case 'seeking': {
        const epoch = this.#epoch;
        const landing = this.#currentTime;
        this.#setState(
          output === 'playing' ? 'playing' : this.#played ? 'paused' : 'ready',
          'media',
        );
        if (this.#epoch !== epoch) break;
        this.dispatchEvent(new SeekedEvent({ currentTime: landing }));
        if (this.#epoch !== epoch) break;
        this.dispatchEvent(new TimeUpdateEvent({ currentTime: landing }));
        break;
      }
      case 'ready':
      case 'paused':
        if (output === 'playing') this.#setState('playing', reason);
        break;
      case 'buffering':
        this.#setState(output, output === 'playing' ? 'media' : reason);
        break;
      case 'playing':
        // 取消影片等待後，worklet 可能在收到 play 之前就回報 paused。
        if (output === 'paused' && this.#workletPlay !== true) this.#setState('paused', reason);
        break;
      default:
        break;
    }
  }

  // ───────────────────────────── 內部 ─────────────────────────────

  /**
   * 改變播放意圖並立即告訴 worklet，但還不發出 statechange：play()／pause() 先把指令入列，
   * 再以 #announceIntent() 發出，listener 內的較新指令才會取代它，而不是反過來。
   */
  #changeIntent(paused: boolean, reason: StateChangeReason = 'command'): void {
    if (this.#paused === paused) return;
    this.#paused = paused;
    this.#intentReason = reason;
    // 等 bufferAhead 時 worklet 已經被要求停住：再送一次 pause，讓它回報 paused、Engine 離開 buffering。
    this.#syncWorklet(this.#holding && paused);
    this.#updateIdleSuspend();
  }

  /** 發出還沒發出過的播放意圖；期間的 statechange 已經帶上它時不重複發出。 */
  #announceIntent(reason: StateChangeReason = 'command'): void {
    this.#setState(this.#state, reason);
  }

  /**
   * 告訴 worklet 播或停：想播放且 context 執行中才播，所以 context 還沒開始（沒有 user gesture）時不會短暫進入 playing。
   * context 沒有在跑時 worklet 不會 render，淡出永遠不會結束，所以要求立即停止。
   * `force` 時即使沒有改變也送出（新的 load 或新的音訊輸出）。
   */
  #syncWorklet(force = false): void {
    const output = this.#audio;
    if (!output) return;
    const running = this.#context.running;
    const play = !this.#paused && running && !this.#holding && !this.#video.pending;
    if (!force && play === this.#workletPlay) return;
    this.#workletPlay = play;
    const epoch = this.#epoch;
    output.post(
      play
        ? { type: 'play', epoch }
        : { type: 'pause', epoch, ...(!running && { immediate: true }) },
    );
  }

  /** 建立或 resume AudioContext（需要時先同步發出 `beforeaudiostart`）。無法開始時播放意圖回到暫停。 */
  #startAudio(): Promise<StartResult> {
    let starting: Promise<StartResult>;
    try {
      starting = this.#context.start();
    } catch {
      // 連 AudioContext 都建立不了：與沒有 gesture 一樣無法開始；load() 會再建立一次並回報 AUDIO_OUTPUT。
      starting = Promise.resolve('locked');
    }
    return starting.then((result) => {
      if (result !== 'running') {
        this.#log.log('warn', 'audio', `AudioContext 無法開始（${result}）`);
        this.#onStartFailed('command');
      }
      return result;
    });
  }

  /** context 無法開始：想播放的意圖回到暫停，並結束等待啟動結果的狀態（loading、seeking 等）。 */
  #onStartFailed(reason: StateChangeReason): void {
    if (this.#isDestroyed) return;
    if (!this.#paused) {
      this.#changeIntent(true, reason);
      this.#announceIntent(reason);
    }
    if (this.#lastOutput === 'paused') this.#applyOutput('paused');
  }

  /** Engine 以外造成的 context 變化：中斷與外部的 suspend 讓 `paused` 變為 true，外部的 resume 讓它變為 false。 */
  #onContextChange(change: ContextChange): void {
    if (this.#isDestroyed) return;
    this.#log.log(
      change === 'interrupted' ? 'warn' : 'info',
      'audio',
      `AudioContext ${change}（外部）`,
    );
    const reason = change === 'interrupted' ? 'interrupted' : 'external';
    const paused = change !== 'resumed';
    if (this.#paused === paused) return;
    this.#changeIntent(paused, reason);
    this.#announceIntent(reason);
  }

  /**
   * 沒有在播（暫停中，或 idle、error 時沒有媒體）且 context 執行中時，`IDLE_SUSPEND_MS` 後經佇列 suspend；
   * 其他情況取消。
   */
  #updateIdleSuspend(): void {
    const idle = !this.#isDestroyed && this.#notPlaying() && this.#context.running;
    if (!idle) {
      if (this.#idleTimer !== null) clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
      return;
    }
    this.#idleTimer ??= setTimeout(() => {
      this.#idleTimer = null;
      if (!this.#notPlaying()) return;
      this.#log.log(
        'debug',
        'audio',
        `沒有播放超過 ${String(IDLE_SUSPEND_MS)} ms，suspend AudioContext`,
      );
      this.#context.suspend();
    }, IDLE_SUSPEND_MS);
  }

  #notPlaying(): boolean {
    return this.#paused || this.#state === 'idle' || this.#state === 'error';
  }

  #armWatchdog(): void {
    this.#stopWatchdog();
    this.#watchdogTimer = setTimeout(() => {
      this.#watchdogTimer = null;
      this.#onWatchdog();
    }, WATCHDOG_MS);
  }

  #stopWatchdog(): void {
    if (this.#watchdogTimer !== null) clearTimeout(this.#watchdogTimer);
    this.#watchdogTimer = null;
  }

  /**
   * playing 期間 frame 超過 `WATCHDOG_MS` 沒有前進：依序 suspend 加 resume、重建 context，仍然失敗就是 fatal 的
   * `AUDIO_OUTPUT`（ADR-0004）。frame 前進時回到第一步。
   */
  #onWatchdog(): void {
    if (this.#isDestroyed || this.#state !== 'playing') return;
    const step = ++this.#watchdogStep;
    this.#log.log(
      'warn',
      'audio',
      `watchdog：音訊時鐘 ${String(WATCHDOG_MS)} ms 沒有前進（第 ${String(step)} 步）`,
      {
        step,
        position: this.currentTime,
      },
    );
    if (step === 1) {
      const output = this.#audio;
      void this.#context.bounce().then((result) => {
        if (this.#isDestroyed || this.#audio !== output || this.#watchdogStep !== 1) return;
        // resume 失敗就直接重建；成功則再等一個 WATCHDOG_MS。
        if (result !== 'running') this.#onWatchdog();
        else if (this.#state === 'playing') this.#armWatchdog();
      });
    } else if (step === 2) {
      this.#rebuildAudio();
    } else {
      this.#fail(this.#fatal('AUDIO_OUTPUT', 'AudioContext 停住，重建之後仍然無法恢復'));
    }
  }

  /**
   * watchdog 的第二步：重建 AudioContext（重新 `addModule`），給 Worker 新的 `MessageChannel`，遞增 epoch，
   * 從目前位置重新供料。新的 context 沒有啟動時，`paused` 變為 true（reason `error`）並送出非致命的 `AUDIO_LOCKED`。
   */
  #rebuildAudio(): void {
    const position = this.currentTime;
    let output: AudioOutput;
    try {
      output = this.#context.rebuild();
    } catch (cause) {
      this.#fail(this.#fatal('AUDIO_OUTPUT', 'AudioContext 無法重建', cause));
      return;
    }
    this.#watchdogFrame = -Infinity;
    this.#workletPlay = null;
    const epoch = ++this.#epoch;
    this.#flushAudio(position);
    output.post({ type: 'duration', epoch, duration: this.#duration });
    this.#syncWorklet(true);
    const starting = this.#context.start(false);
    this.#setState('buffering', 'media');
    if (this.#epoch !== epoch) return;

    const worker = this.#worker;
    this.#connect(output).then(
      (port) => {
        if (!worker || worker !== this.#worker || output !== this.#audio) {
          port.close();
          return;
        }
        // 期間可能又 seek 過：以此刻的 epoch 與位置重新供料。
        worker.post({ type: 'port', port, epoch: this.#epoch, time: this.#currentTime }, [port]);
      },
      (error: unknown) => {
        if (output === this.#audio) this.#fail(this.#toEngineError(error));
      },
    );
    void starting.then((result) => {
      if (result === 'running' || output !== this.#audio || this.#isDestroyed) return;
      const wasPlaying = !this.#paused;
      this.#log.log('warn', 'audio', `重建的 AudioContext 無法開始（${result}）`);
      this.#onStartFailed('error');
      if (!wasPlaying) return;
      const error = new EngineError('AUDIO_LOCKED', {
        fatal: false,
        position: this.currentTime,
        message: '重建的 AudioContext 沒有 user gesture，無法開始',
      });
      this.dispatchEvent(new EngineErrorEvent({ error }));
    });
  }

  #setState(state: EngineState, reason: StateChangeReason, paused = this.#paused): void {
    const previous = this.#state;
    if (state === previous && paused === this.#announcedPaused) return;
    const intentChanged = paused !== this.#paused;
    this.#log.log('debug', 'command', `state ${previous} → ${state}`, { reason, paused });
    this.#state = state;
    this.#paused = paused;
    this.#announcedPaused = paused;
    if (intentChanged) {
      this.#syncWorklet();
      this.#updateIdleSuspend();
    }
    // 離開 buffering：這次的卡住偵測結束。
    const stall = state !== previous && previous === 'buffering' ? this.#endStall() : null;
    if (state !== previous) this.#onStateEntered(state);
    const epoch = this.#epoch;
    this.dispatchEvent(new StateChangeEvent({ state, previous, paused, reason }));
    if (stall && stall.attempts > 0 && state === 'playing' && this.#epoch === epoch) {
      const { since, attempts } = stall;
      const stalledMs = performance.now() - since;
      this.#log.log('info', 'io', '卡住後恢復播放', { stalledMs, attempts });
      this.dispatchEvent(new StallRecoveredEvent({ stalledMs, attempts }));
    }
    this.#notify();
  }

  /**
   * 進入新的 state：播放中依 `timeUpdateInterval` 發出 timeupdate，離開 playing 就停。buffering 開始卡住偵測；
   * 離開 buffering 就不再等 bufferAhead，worklet 被要求的停住也要依播放意圖重新同步（例如等待中 seek）。
   */
  #onStateEntered(state: EngineState): void {
    this.#updateIdleSuspend();
    if (state === 'playing') this.#armWatchdog();
    else this.#stopWatchdog();
    if (state !== 'playing') this.#clearStarveTimer();
    if (state === 'buffering') this.#beginStall();
    else if (this.#holding) {
      this.#holding = false;
      this.#syncWorklet();
    }
    if (state !== 'playing') {
      if (this.#timeUpdateTimer !== null) clearInterval(this.#timeUpdateTimer);
      this.#timeUpdateTimer = null;
      return;
    }
    this.#played = true;
    // 內插從開始播放的位置算起；輸出延遲期間聽到的還是開始之前的靜音。
    this.#heardFloor = this.#currentTime;
    this.#lastTimeUpdate = this.#currentTime;
    this.#timeUpdateTimer ??= setInterval(() => {
      const currentTime = this.currentTime;
      if (currentTime === this.#lastTimeUpdate) return;
      this.#lastTimeUpdate = currentTime;
      this.dispatchEvent(new TimeUpdateEvent({ currentTime }));
    }, this.#options.timeUpdateInterval);
  }

  /** Worker 內的統計；沒有 Worker 時為 null。 */
  #workerStats(): Promise<WorkerStats | null> {
    const worker = this.#worker;
    if (!worker) return Promise.resolve(null);
    const id = ++this.#statsSeq;
    return new Promise<WorkerStats | null>((resolve) => {
      this.#statsRequests.set(id, resolve);
      worker.post({ type: 'stats', id });
    });
  }

  /** 一次更新媒體的鏡像，值有改變時才發出 durationchange、trackschange。 */
  #publishMedia(info: MediaInfo | null, selection: Readonly<TrackSelection>): void {
    const duration = info?.duration ?? NaN;
    const tracks = info?.tracks ?? [];
    const durationChanged = !Object.is(duration, this.#duration);
    const tracksChanged = tracks !== this.#tracks && (tracks.length > 0 || this.#tracks.length > 0);
    const selectionChanged = (['audio', 'video', 'subtitle'] as const).some(
      (kind) => selection[kind] !== this.#selected[kind],
    );
    this.#media = info;
    this.#duration = duration;
    this.#tracks = tracks;
    this.#selected = selection;
    const epoch = this.#epoch;
    if (durationChanged) this.dispatchEvent(new DurationChangeEvent({ duration }));
    if (this.#epoch !== epoch) return;
    if (tracksChanged || selectionChanged) {
      this.dispatchEvent(new TracksChangeEvent({ tracks, selected: selection }));
    }
    if (this.#epoch !== epoch) return;
    this.#bufferedChanged();
  }

  // ───────────────────────────── buffering 與卡住 ─────────────────────────────

  /** worklet starved：`STARVED_MS` 內沒有補回就進入 buffering，並等 bufferAhead 足夠才恢復。 */
  #armStarve(): void {
    this.#starveTimer ??= setTimeout(() => {
      this.#starveTimer = null;
      if (this.#isDestroyed || this.#state !== 'playing' || !this.#starved) return;
      this.#holding = true;
      this.#log.log('warn', 'io', `ring 用完超過 ${String(STARVED_MS)} ms，進入 buffering`, {
        position: this.#currentTime,
      });
      const epoch = this.#epoch;
      this.#setState('buffering', 'media');
      // listener 可能已經改變了狀態。
      if (this.#epoch !== epoch || this.#stateNow() !== 'buffering') return;
      this.#syncWorklet();
      this.#checkHold();
    }, STARVED_MS);
  }

  #clearStarveTimer(): void {
    if (this.#starveTimer !== null) clearTimeout(this.#starveTimer);
    this.#starveTimer = null;
  }

  #clearStarved(): void {
    this.#starved = false;
    this.#clearStarveTimer();
  }

  /** 等 bufferAhead 時：資料足夠（≥ 3 秒、已讀到檔尾，或預讀已不再抓取）就讓 worklet 恢復輸出。 */
  #checkHold(): void {
    if (!this.#holding) return;
    const buffer = this.#buffer;
    if (buffer?.epoch !== this.#epoch) return;
    if (buffer.eof || !buffer.fetching || buffer.end - this.currentTime >= RESUME_AHEAD_SECONDS) {
      this.#log.log('info', 'io', '資料足夠，恢復輸出', {
        end: buffer.end,
        eof: buffer.eof,
        fetching: buffer.fetching,
      });
      this.#holding = false;
      this.#syncWorklet();
    }
  }

  /** 進入 buffering：開始卡住偵測（同一次 buffering 內的自動恢復沿用同一個計數）。 */
  #beginStall(): void {
    this.#stall ??= { since: performance.now(), attempts: 0, timer: null };
    this.#armStall(this.#stall);
  }

  #armStall(stall: StallEpisode): void {
    if (stall.timer !== null) clearTimeout(stall.timer);
    stall.timer = setTimeout(() => {
      stall.timer = null;
      this.#onStall(stall);
    }, this.#options.stallTimeout);
  }

  /** 結束這次 buffering 的卡住偵測，回傳它（供 stallrecovered）。 */
  #endStall(): { since: number; attempts: number } | null {
    const stall = this.#stall;
    if (!stall) return null;
    if (stall.timer !== null) clearTimeout(stall.timer);
    this.#stall = null;
    return stall;
  }

  /**
   * buffering 超過 `stallTimeout`：還有次數就發出 `stall`，中止讀取並從目前位置重新 seek（Worker 收到 seek 時中止
   * 所有進行中的讀取與請求）；用完就以最後一次的讀取錯誤進入 error（reason `stall`）。
   */
  #onStall(stall: StallEpisode): void {
    if (this.#isDestroyed || this.#stall !== stall || this.#state !== 'buffering') return;
    stall.attempts++;
    const position = this.currentTime;
    if (stall.attempts > this.#options.stallAttempts) {
      this.#fail(this.#stallError(position), 'stall');
      return;
    }
    this.#log.log(
      'warn',
      'io',
      `超過 ${String(this.#options.stallTimeout)} ms 沒有資料：卡住，從目前位置重新讀取`,
      {
        attempt: stall.attempts,
        position,
      },
    );
    const epoch = this.#epoch;
    this.dispatchEvent(new StallEvent({ since: stall.since, position }));
    if (this.#epoch !== epoch || this.#stall !== stall) return;
    this.#retarget(position);
    this.#armStall(stall);
  }

  /** 卡住而放棄時的錯誤：最後一次的讀取錯誤；沒有（請求停住、沒有失敗）時是 `SOURCE_NETWORK`。 */
  #stallError(position: number): EngineError {
    const last = this.#lastReadError;
    if (last) return fromWireError(last, { fatal: true, position });
    const source = this.#lastLoad?.source;
    return new EngineError('SOURCE_NETWORK', {
      fatal: true,
      position,
      message: `超過 ${String(this.#options.stallTimeout)} ms 等不到資料，自動恢復 ${String(this.#options.stallAttempts)} 次仍然卡住`,
      ...(source?.kind === 'http' && { detail: { url: String(source.url) } }),
    });
  }

  /** `buffered` 的終點變動 ≥ 0.5 秒（或有無範圍改變）時發出 bufferedchange，每 `timeUpdateInterval` 最多一次。 */
  #bufferedChanged(): void {
    const end = this.buffered[0]?.end ?? null;
    const last = this.#bufferedEmitted;
    const changed =
      end === null || last === null
        ? end !== last
        : Math.abs(end - last) >= BUFFERED_CHANGE_SECONDS;
    if (!changed) return;
    if (this.#bufferedTimer !== null) {
      this.#bufferedPending = true;
      return;
    }
    this.#bufferedEmitted = end;
    this.#bufferedTimer = setTimeout(() => {
      this.#bufferedTimer = null;
      if (!this.#bufferedPending || this.#isDestroyed) return;
      this.#bufferedPending = false;
      this.#bufferedChanged();
    }, this.#options.timeUpdateInterval);
    this.dispatchEvent(new BufferedChangeEvent({ buffered: this.buffered }));
  }

  /** 遞增 epoch，讓 Worker 從 `time` 重新供料、worklet 丟掉舊的資料。 */
  #retarget(time: number): void {
    const epoch = ++this.#epoch;
    // 卡住時回報的讀取錯誤只看重新讀取之後的請求。
    this.#lastReadError = null;
    this.#worker?.post({ type: 'seek', epoch, time });
    this.#flushAudio(time);
  }

  /**
   * 新的 epoch 從 `position` 開始：worklet 丟掉舊的資料，影片佇列中舊 epoch 的 frame close。解碼中的影片要等新 epoch 的
   * 第一張 frame，worklet 在那之前停住。
   */
  #flushAudio(position: number): void {
    this.#currentTime = position;
    this.#heardFloor = position;
    this.#clock = null;
    this.#clearStarved();
    this.#lastOutput = null;
    if (this.#loadContext) this.#loadContext.flushedAt = position;
    this.#audio?.post({ type: 'flush', epoch: this.#epoch, position });
    if (this.#video.beginEpoch(this.#epoch)) this.#syncWorklet();
  }

  // ───────────────────────────── 字幕 ─────────────────────────────

  /** 選中字幕軌的一批 cue 以 `cues` 事件送出（補上 trackId）。 */
  #dispatchCues(cues: readonly WireCue[]): void {
    const trackId = this.#subtitleTrackId;
    if (trackId === null || cues.length === 0) return;
    this.dispatchEvent(new CuesEvent({ trackId, cues: cues.map((cue) => ({ ...cue, trackId })) }));
  }

  /** load 完成：送出留著的 cue 中仍是目前 epoch 的那些；listener 改變了 epoch 就停。 */
  #flushPendingCues(): void {
    const pending = this.#pendingCues;
    this.#pendingCues = [];
    const epoch = this.#epoch;
    for (const batch of pending) {
      if (this.#epoch !== epoch) return;
      if (batch.epoch === epoch) this.#dispatchCues(batch.cues);
    }
  }

  // ───────────────────────────── 影片 ─────────────────────────────

  /** 開始解碼 `track`（送出 `start` 之前）：等第一張 frame（worklet 先停住），並開始繪製迴圈。背景中不等、不畫。 */
  #startVideo(track: VideoTrack): void {
    this.#video.start(track);
    this.#syncWorklet();
  }

  /** 頁面切到背景或回到前景（`suspendVideoWhenHidden`）。 */
  #onVisibilityChange(): void {
    if (this.#isDestroyed) return;
    const hidden = this.#deps.visibility.hidden;
    // 背景中：佇列中的 frame close（畫面上的那張留著）、停止繪製；回到前景時重新開始繪製。
    if (!this.#video.setSuspended(hidden, this.#epoch)) return;
    const position = this.currentTime;
    const track = this.#video.track;
    this.#log.log(
      'info',
      'video',
      hidden ? '頁面切到背景：暫停影片解碼，只播聲音' : '頁面回到前景：從 keyframe 重新同步影片',
      { position, ...(track && { track: track.id }) },
    );
    // Worker 記住這個狀態，之後的 start、seek 沿用；沒有選用影片軌時也要告訴它。
    this.#worker?.post({ type: 'videosuspend', suspended: hidden, time: position });
    if (!track) return;
    if (hidden) {
      // 不再等影片。
      this.#onVideoReady();
      return;
    }
    // 沒有音軌時，背景中沒有音訊推進 demux，影片的封包停在切到背景的位置；音軌比影片短而已經送完時，背景中 demux 一路
    // 讀到結尾、影片的封包只留檔尾附近的。兩者都從目前位置重新 seek，沒有聲音，所以不會中斷什麼。
    const silent = this.#audioTrackId === null || this.#audioEndedEpoch === this.#epoch;
    if (silent && this.#isSettled()) this.#retarget(position);
  }

  /** 有媒體且不在 load、seek 或 error 等轉換中（playing、paused、ready、buffering）。 */
  #isSettled(): boolean {
    const state = this.#state;
    return state === 'playing' || state === 'paused' || state === 'ready' || state === 'buffering';
  }

  /** 這個 epoch 的影片備妥（或不再等）：worklet 依播放意圖恢復，等待中的 load／seek 依 worklet 的回報完成。 */
  #onVideoReady(): void {
    if (!this.#video.markReady()) return;
    this.#syncWorklet();
    const last = this.#lastOutput;
    // 想播放而 worklet 剛被要求播放：等它回報 playing。
    if (last === 'playing' || (last === 'paused' && !this.#workletPlay)) this.#applyOutput(last);
    this.#notify();
  }

  /**
   * Worker 放棄了影片軌（`VideoDecoder` 失敗）：該軌改為不支援（`'platform'`），不選用影片、只播音訊。
   * configure 或首個 keyframe 失敗（`beforeFirstFrame`）時與 `isConfigSupported` 誤報相同；播放中的解碼失敗（Worker
   * 已經重新設定過 decoder）另外發出非致命的 `DECODE_FAILED`，state 不變。
   */
  #onVideoError(error: WireError, beforeFirstFrame: boolean): void {
    const track = this.#video.track;
    this.#log.log('warn', 'video', error.message, {
      code: error.code,
      beforeFirstFrame,
      ...(track && { track: track.id }),
    });
    const switching = this.#switching;
    if (track && switching && track.id !== this.#selected.video) {
      // 換軌中新的影片軌失敗：由 #switchTracks() 標為不支援並換回原本的軌；畫面上的 frame 留著。
      this.#video.abandon();
      switching.failed = { trackId: track.id, error, mark: 'platform' };
      this.#notify();
      return;
    }
    if (track) {
      // 換軌中生效的影片軌失敗：照常退回只播音訊，換軌生效時也不選用影片。
      if (switching) switching.next = { ...switching.next, video: null };
      // 不再解碼影片；等待留給下面的 #onVideoReady() 結束。
      this.#video.abandon();
      const load = this.#loadContext;
      let media = this.#media;
      // listener 內換檔、unload 或 destroy 之後，這份媒體的降級就不再繼續；seek 不影響。
      const same = () =>
        !this.#destroyedDuring() && this.#loadContext === load && this.#media === media;
      this.#video.setTrack(null);
      if (!same()) return;
      const mark = (tracks: readonly Track[]): Track[] =>
        tracks.map((t) =>
          t.id === track.id ? { ...t, supported: false, unsupportedReason: 'platform' } : t,
        );
      if (load?.info) {
        // 還在 loading：媒體在 load 完成時一起發布。
        load.info = { ...load.info, tracks: mark(load.info.tracks) };
        load.selection = { ...load.selection, video: null };
        // 它是唯一可播的軌：與 probe 時就沒有可播的軌一樣，load() 以 CODEC_UNSUPPORTED 失敗。
        if (!load.info.tracks.some((t) => t.supported && t.kind !== 'subtitle')) {
          this.#fail(this.#fatal('CODEC_UNSUPPORTED', '沒有可以播放的音軌或影片軌'));
          return;
        }
      } else if (media) {
        media = { ...media, tracks: mark(media.tracks) };
        this.#publishMedia(media, { ...this.#selected, video: null });
        if (!same()) return;
      }
      if (!beforeFirstFrame) {
        const engineError = fromWireError(error, {
          fatal: false,
          position: this.currentTime,
          detail: { trackId: track.id },
        });
        this.#logError('warn', engineError);
        this.dispatchEvent(new EngineErrorEvent({ error: engineError }));
        if (!same()) return;
      }
    }
    this.#onVideoReady();
  }

  /** 音訊已備妥、影片還沒：`VIDEO_READY_TIMEOUT_MS` 後不再等。 */
  #armVideoTimer(): void {
    this.#video.armTimer(() => {
      if (this.#isDestroyed) return;
      this.#log.log(
        'warn',
        'video',
        `影片的第一張 frame 超過 ${String(VIDEO_READY_TIMEOUT_MS)} ms 沒有備妥，先開始播放`,
        { position: this.#currentTime },
      );
      this.#video.giveUpPicture(true);
      this.#onVideoReady();
    });
  }

  #beginSeek(time: number): void {
    this.#retarget(time);
    this.#setState('seeking', 'command');
  }

  /** 致命錯誤：結束當前媒體，state 進入 `'error'`，未完成的指令都以 `error` reject。不自動 reload。 */
  #fail(error: EngineError, reason: StateChangeReason = 'error'): void {
    const position = this.currentTime;
    this.#logError('error', error, { reason });
    this.#terminateWorker();
    this.#loadContext = null;
    this.#error = error;
    this.#video.stop();
    // 停掉 ring 內剩下的聲音。
    const epoch = ++this.#epoch;
    this.#video.reset(epoch);
    this.#flushAudio(position);
    this.#queue.fail(error);
    this.#setState('error', reason);
    if (this.#epoch === epoch) this.dispatchEvent(new EngineErrorEvent({ error }));
  }

  #logError(level: 'warn' | 'error', error: EngineError, extra?: Record<string, unknown>): void {
    if (!this.#log.enabled(level)) return;
    this.#log.log(level, errorScope(error.code), error.message, {
      code: error.code,
      fatal: error.fatal,
      position: error.position,
      ...(Object.keys(error.detail).length > 0 && { detail: { ...error.detail } }),
      ...extra,
    });
  }

  #terminateWorker(): void {
    if (this.#worker) {
      this.#log.log('debug', 'worker', 'terminate media Worker');
      this.#worker.terminate();
      this.#liveWorkers--;
    }
    this.#worker = null;
    this.#externals.dropReplies();
    for (const resolve of this.#statsRequests.values()) resolve(null);
    this.#statsRequests.clear();
  }

  #audioOutput(): AudioOutput {
    try {
      return this.#context.ensure();
    } catch (cause) {
      throw this.#fatal('AUDIO_OUTPUT', '音訊輸出無法啟動', cause);
    }
  }

  async #connect(audio: AudioOutput): Promise<MessagePort> {
    try {
      return await audio.connect();
    } catch (cause) {
      if (cause instanceof AssetLoadError) {
        throw this.#fatal('ASSET_LOAD_FAILED', 'AudioWorklet 載入失敗', cause);
      }
      throw this.#fatal('AUDIO_OUTPUT', 'AudioWorklet 無法接上 media Worker', cause);
    }
  }

  /** wasm 只 compile 一次並持有；失敗時下一次 load 重試。 */
  #loadWasm(): Promise<WasmAssets> {
    this.#wasm ??= new Promise<WasmAssets>((resolve) => {
      resolve(this.#deps.loadWasm());
    }).catch((cause: unknown) => {
      this.#wasm = null;
      throw this.#fatal('ASSET_LOAD_FAILED', 'wasm 載入失敗', cause);
    });
    return this.#wasm;
  }

  #assertMedia(): void {
    if (this.#state === 'idle' || this.#state === 'error') {
      throw new DOMException(`state 為 '${this.#state}'，沒有可播放的媒體`, 'InvalidStateError');
    }
  }

  /** 等到 `get()` 回傳非 null 的值；signal abort 時以其 reason reject。 */
  #waitFor<T>(get: () => T | null, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const done = () => {
        this.#waiters.delete(check);
        signal.removeEventListener('abort', onAbort);
      };
      const check = () => {
        const value = get();
        if (value === null) return;
        done();
        resolve(value);
      };
      const onAbort = () => {
        done();
        reject(abortReason(signal));
      };
      if (signal.aborted) {
        reject(abortReason(signal));
        return;
      }
      this.#waiters.add(check);
      signal.addEventListener('abort', onAbort);
      check();
    });
  }

  async #until(predicate: () => boolean, signal: AbortSignal): Promise<void> {
    await this.#waitFor(() => (predicate() ? true : null), signal);
  }

  #notify(): void {
    for (const check of [...this.#waiters]) check();
  }

  /** 以目前位置建立致命的 `EngineError`。 */
  #fatal(code: EngineErrorCode, message: string, cause?: unknown): EngineError {
    return new EngineError(code, {
      fatal: true,
      position: this.currentTime,
      message,
      ...(cause !== undefined && { cause }),
    });
  }

  #toEngineError(error: unknown): EngineError {
    return error instanceof EngineError
      ? error
      : this.#fatal('INTERNAL', error instanceof Error ? error.message : String(error), error);
  }

  /** 同步 dispatch 之後的狀態；以方法讀取，避開 TypeScript 對欄位的窄化。 */
  #stateNow(): EngineState {
    return this.#state;
  }

  /** 同步 dispatch 的 listener 內可能呼叫了 destroy()；以方法讀取，避開 TypeScript 對欄位的窄化。 */
  #destroyedDuring(): boolean {
    return this.#isDestroyed;
  }

  #destroyedError(): EngineError {
    return new EngineError('DESTROYED', { fatal: false, position: this.currentTime });
  }
}

/**
 * `start`／`select` 的音訊欄位：外掛音軌帶 `audioSource`（它的 track id），offset 不是 0 時帶 `audioOffset`。
 */
function audioSelectionFields(
  track: AudioTrack | undefined,
): Pick<WorkerTrackSelection, 'audio' | 'audioSource' | 'audioOffset'> {
  if (!track) return { audio: null };
  return {
    audio: track.streamIndex,
    ...(track.origin === 'external' && { audioSource: track.id }),
    ...(track.offset !== 0 && { audioOffset: track.offset }),
  };
}

/** `selectTracks()` 的要求帶了哪些 kind。 */
function kindsOf(request: SelectRequest): TrackKind[] {
  return trackKinds.filter((kind) => request.selection[kind] !== undefined);
}

function sameSelection(a: Readonly<TrackSelection>, b: Readonly<TrackSelection>): boolean {
  return trackKinds.every((kind) => a[kind] === b[kind]);
}

/** 夾在 `[0, duration]`；duration 未知（NaN）時只夾下限。 */
function clamp(time: number, duration: number): number {
  return Math.max(0, Number.isNaN(duration) ? time : Math.min(time, duration));
}

/** signal abort 時以其 reason reject，不等 `promise`。 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(abortReason(signal));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    promise
      .finally(() => {
        signal.removeEventListener('abort', onAbort);
      })
      .then(resolve, reject);
  });
}

/** 指令佇列一律以 Error（AbortError 或 EngineError）abort signal。 */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : abortError();
}
