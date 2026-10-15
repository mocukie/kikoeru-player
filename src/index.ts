// 公開 API 的匯出（套件的 "." entry）。行為以各成員的 TSDoc 為準。

export { createEngine } from './main/engine.js';
export { EngineError, isAbortError } from './main/errors.js';
export {
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
} from './main/events.js';
export { isEngineSupported } from './main/support.js';
export { thirdPartyNotices } from './main/third-party-notices.js';
export type {
  AssCue,
  AudioTrack,
  BlobSource,
  BytesSource,
  CueBase,
  Engine,
  EngineErrorCode,
  EngineEventMap,
  EngineOptions,
  EngineState,
  EngineStats,
  HttpSource,
  LoadOptions,
  LogEntry,
  LogHook,
  LogLevel,
  MediaInfo,
  Source,
  StateChangeReason,
  SubtitleCue,
  SubtitleTrack,
  TextCue,
  ThirdPartyNotice,
  TimeRange,
  Track,
  TrackBase,
  TrackKind,
  TrackSelection,
  VideoSize,
  VideoTrack,
} from './main/types.js';
