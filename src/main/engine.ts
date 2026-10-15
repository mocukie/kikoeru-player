// createEngine() 與 Engine 的實作。

import type { EngineError } from './errors.js';
import { notImplemented } from './not-implemented.js';
import { resolveEngineOptions } from './options.js';
import { detectPlatform } from './platform.js';
import type {
  AudioTrack,
  Engine,
  EngineOptions,
  EngineState,
  EngineStats,
  MediaInfo,
  TimeRange,
  Track,
  TrackSelection,
  VideoSize,
} from './types.js';

/**
 * 建立 Engine。整個 App 建立一個，換檔用 `load()`。
 *
 * 選項的數值超出範圍時丟 `RangeError`，見 `EngineOptions` 各欄位。平台（iOS／iPadOS、Android、桌面）在這裡判斷一次，
 * 決定 `audioBuffer` 與 `limits` 的預設值。
 */
export function createEngine(options?: EngineOptions): Engine {
  // 補齊的選項由之後的切片交給 Engine 的實作；目前只驗證。
  resolveEngineOptions(options, detectPlatform(globalThis.navigator));
  return new EngineImpl();
}

/** 公開 API 的骨架；行為由之後的切片逐一實作。 */
class EngineImpl extends EventTarget implements Engine {
  get state(): EngineState {
    return notImplemented('state');
  }
  get paused(): boolean {
    return notImplemented('paused');
  }
  get currentTime(): number {
    return notImplemented('currentTime');
  }
  get duration(): number {
    return notImplemented('duration');
  }
  get buffered(): readonly TimeRange[] {
    return notImplemented('buffered');
  }
  get media(): MediaInfo | null {
    return notImplemented('media');
  }
  get tracks(): readonly Track[] {
    return notImplemented('tracks');
  }
  get selectedTracks(): Readonly<TrackSelection> {
    return notImplemented('selectedTracks');
  }
  get error(): EngineError | null {
    return notImplemented('error');
  }
  get videoSize(): VideoSize | null {
    return notImplemented('videoSize');
  }
  get audioUnlocked(): boolean {
    return notImplemented('audioUnlocked');
  }

  get volume(): number {
    return notImplemented('volume');
  }
  set volume(_value: number) {
    notImplemented('volume');
  }
  get muted(): boolean {
    return notImplemented('muted');
  }
  set muted(_value: boolean) {
    notImplemented('muted');
  }
  get playbackRate(): number {
    return notImplemented('playbackRate');
  }
  set playbackRate(_value: number) {
    notImplemented('playbackRate');
  }

  unlockAudio(): void {
    notImplemented('unlockAudio()');
  }
  load(): Promise<MediaInfo> {
    return notImplemented('load()');
  }
  reload(): Promise<MediaInfo> {
    return notImplemented('reload()');
  }
  play(): Promise<void> {
    return notImplemented('play()');
  }
  pause(): Promise<void> {
    return notImplemented('pause()');
  }
  seek(): Promise<number> {
    return notImplemented('seek()');
  }
  selectTracks(): Promise<void> {
    return notImplemented('selectTracks()');
  }
  addExternalAudio(): Promise<AudioTrack> {
    return notImplemented('addExternalAudio()');
  }
  removeExternalAudio(): Promise<void> {
    return notImplemented('removeExternalAudio()');
  }
  setAudioOffset(): Promise<void> {
    return notImplemented('setAudioOffset()');
  }
  unload(): Promise<void> {
    return notImplemented('unload()');
  }
  destroy(): Promise<void> {
    return notImplemented('destroy()');
  }
  attachCanvas(): void {
    notImplemented('attachCanvas()');
  }
  getStats(): Promise<EngineStats> {
    return notImplemented('getStats()');
  }
}
