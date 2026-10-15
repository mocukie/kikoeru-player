// Engine 的事件類別。每個類別固定一個事件名稱（EngineEventMap 的 key），欄位直接放在事件上。
// 建構子由 Engine 使用；App 一般只讀取欄位。

import type { EngineError } from './errors.js';
import type {
  EngineState,
  StateChangeReason,
  SubtitleCue,
  TimeRange,
  Track,
  TrackSelection,
  VideoSize,
} from './types.js';

/** `statechange`：`state` 或 `paused` 改變。`play()`／`pause()` 只改變 `paused` 時，`state === previous`。 */
export class StateChangeEvent extends Event {
  /** 改變後的狀態。 */
  readonly state: EngineState;
  /** 改變前的狀態。 */
  readonly previous: EngineState;
  /** 改變後的播放意圖。 */
  readonly paused: boolean;
  /** 改變的原因。 */
  readonly reason: StateChangeReason;

  constructor(init: Pick<StateChangeEvent, 'state' | 'previous' | 'paused' | 'reason'>) {
    super('statechange');
    this.state = init.state;
    this.previous = init.previous;
    this.paused = init.paused;
    this.reason = init.reason;
  }
}

/** `timeupdate`：播放位置前進。 */
export class TimeUpdateEvent extends Event {
  /** 目前聽到的位置（秒）。 */
  readonly currentTime: number;

  constructor(init: Pick<TimeUpdateEvent, 'currentTime'>) {
    super('timeupdate');
    this.currentTime = init.currentTime;
  }
}

/** `durationchange`：總長度改變。 */
export class DurationChangeEvent extends Event {
  /** 新的總長度（秒）；未知時為 NaN。 */
  readonly duration: number;

  constructor(init: Pick<DurationChangeEvent, 'duration'>) {
    super('durationchange');
    this.duration = init.duration;
  }
}

/** `seeked`：seek 完成。 */
export class SeekedEvent extends Event {
  /** seek 的實際落點（秒）。 */
  readonly currentTime: number;

  constructor(init: Pick<SeekedEvent, 'currentTime'>) {
    super('seeked');
    this.currentTime = init.currentTime;
  }
}

/** `error`：播放途中的錯誤；`error.fatal` 時 state 同時變為 `'error'`。 */
export class EngineErrorEvent extends Event {
  /** 發生的錯誤。 */
  readonly error: EngineError;

  constructor(init: Pick<EngineErrorEvent, 'error'>) {
    super('error');
    this.error = init.error;
  }
}

/** `trackschange`：軌道清單或選擇改變。 */
export class TracksChangeEvent extends Event {
  /** 改變後的所有軌道。 */
  readonly tracks: readonly Track[];
  /** 改變後生效的選擇。 */
  readonly selected: Readonly<TrackSelection>;

  constructor(init: Pick<TracksChangeEvent, 'tracks' | 'selected'>) {
    super('trackschange');
    this.tracks = init.tracks;
    this.selected = init.selected;
  }
}

/** `bufferedchange`：`buffered` 的終點變動 ≥ 0.5 秒時發出，並受 `timeUpdateInterval` 節流。 */
export class BufferedChangeEvent extends Event {
  /** 改變後的已緩衝範圍。 */
  readonly buffered: readonly TimeRange[];

  constructor(init: Pick<BufferedChangeEvent, 'buffered'>) {
    super('bufferedchange');
    this.buffered = init.buffered;
  }
}

/** `videoresize`：影片的顯示尺寸改變。 */
export class VideoResizeEvent extends Event {
  /** 新的顯示尺寸；沒有影片軌時為 null。 */
  readonly size: VideoSize | null;

  constructor(init: Pick<VideoResizeEvent, 'size'>) {
    super('videoresize');
    this.size = init.size;
  }
}

/** `cues`：一批新的內嵌字幕 cue。 */
export class CuesEvent extends Event {
  /** cue 所屬的字幕軌。 */
  readonly trackId: string;
  /** 這一批 cue；可能包含 seek 後重送的 cue，以 id 去重。 */
  readonly cues: readonly SubtitleCue[];

  constructor(init: Pick<CuesEvent, 'trackId' | 'cues'>) {
    super('cues');
    this.trackId = init.trackId;
    this.cues = init.cues;
  }
}

/** `stall`：buffering 超過 `stallTimeout`，Engine 開始自動恢復。 */
export class StallEvent extends Event {
  /** 開始卡住的 `performance.now()` 時間。 */
  readonly since: number;
  /** 卡住的播放位置（秒）。 */
  readonly position: number;

  constructor(init: Pick<StallEvent, 'since' | 'position'>) {
    super('stall');
    this.since = init.since;
    this.position = init.position;
  }
}

/** `stallrecovered`：卡住後恢復播放。 */
export class StallRecoveredEvent extends Event {
  /** 卡住的總時間（ms）。 */
  readonly stalledMs: number;
  /** 恢復前嘗試的次數。 */
  readonly attempts: number;

  constructor(init: Pick<StallRecoveredEvent, 'stalledMs' | 'attempts'>) {
    super('stallrecovered');
    this.stalledMs = init.stalledMs;
    this.attempts = init.attempts;
  }
}

/** `beforeaudiostart`：即將建立或 resume AudioContext，在 user gesture 的同步段內發出。 */
export class BeforeAudioStartEvent extends Event {
  /** `'unlock'`：第一次建立或解鎖；`'resume'`：暫停或中斷後恢復。 */
  readonly cause: 'unlock' | 'resume';

  constructor(init: Pick<BeforeAudioStartEvent, 'cause'>) {
    super('beforeaudiostart');
    this.cause = init.cause;
  }
}
