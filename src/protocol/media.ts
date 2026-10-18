// 各訊息共用的資料型別：host 物件、來源、probe 結果與錯誤。

/**
 * 由執行環境的 lib 提供的物件型別。protocol 不引用任何執行環境的全域型別，訊息型別以這個參數帶入，
 * 主執行緒與 media Worker 各自以自己的 lib 實例化，例如 `{ wasmModule: WebAssembly.Module; … }`。
 */
export interface HostTypes {
  /** `WebAssembly.Module`。 */
  wasmModule: unknown;
  /** `MessagePort`。 */
  messagePort: unknown;
  /** `Blob`。 */
  blob: unknown;
}

/** 送進 media Worker 的來源描述，對應公開的 `Source`；URL 一律轉成字串。 */
export type WireSource<H extends HostTypes> =
  | {
      kind: 'http';
      url: string;
      credentials?: 'omit' | 'same-origin' | 'include';
      headers?: Record<string, string>;
      size?: number;
    }
  | { kind: 'bytes'; data: ArrayBuffer | Uint8Array; name?: string }
  | { kind: 'blob'; blob: H['blob'] };

/**
 * http 讀取失敗的自動重試，對應補上預設值的 `EngineOptions.retry`：只重試 5xx 與網路錯誤，第 n 次重試前等
 * `baseDelayMs * 2^(n-1)` ms；`attempts` 是重試的次數（不含第一次請求）。
 */
export interface RetryPolicy {
  attempts: number;
  baseDelayMs: number;
}

/** probe 結果。時間已換算到媒體時間軸（秒）。 */
export interface ProbedMedia {
  format: string;
  /** 未知時為 NaN。 */
  duration: number;
  size: number;
  tracks: readonly ProbedTrack[];
}

/** probe 到的一條軌道；track id、`origin` 與 offset 由主執行緒指派。欄位的意義同公開的 `Track`。 */
export type ProbedTrack = ProbedAudioTrack | ProbedVideoTrack | ProbedSubtitleTrack;

/** 各種軌道共有的欄位。 */
export interface ProbedTrackBase {
  streamIndex: number;
  codec: string;
  codecString?: string;
  supported: boolean;
  unsupportedReason?: 'codec' | 'platform' | 'bitmap-subtitle';
  language?: string;
  rawLanguage?: string;
  title?: string;
  default: boolean;
  forced: boolean;
}

/** 音軌。 */
export interface ProbedAudioTrack extends ProbedTrackBase {
  kind: 'audio';
  sampleRate: number;
  channels: number;
  channelLayout?: string;
  sampleFormat?: string;
}

/** 影片軌。 */
export interface ProbedVideoTrack extends ProbedTrackBase {
  kind: 'video';
  codedWidth: number;
  codedHeight: number;
  display: { width: number; height: number; rotation: 0 | 90 | 180 | 270 };
  frameRate?: number;
}

/** 內嵌字幕軌。 */
export interface ProbedSubtitleTrack extends ProbedTrackBase {
  kind: 'subtitle';
  format: 'ass' | 'ssa' | 'subrip' | 'webvtt' | 'mov_text' | 'bitmap';
  header?: string;
}

/** media Worker 會回報的錯誤種類，是公開 `EngineErrorCode` 的子集。 */
export type WorkerErrorCode =
  | 'SOURCE_UNAUTHORIZED'
  | 'SOURCE_FORBIDDEN'
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_SERVER'
  | 'SOURCE_NETWORK'
  | 'SOURCE_RANGE_UNSUPPORTED'
  | 'FORMAT_UNSUPPORTED'
  | 'FORMAT_CORRUPT'
  | 'CODEC_UNSUPPORTED'
  | 'DECODE_FAILED'
  | 'ASSET_LOAD_FAILED'
  | 'MEMORY_LIMIT'
  | 'INTERNAL';

/** 跨執行緒傳送的錯誤；主執行緒補上 `position` 後轉成 `EngineError`。 */
export interface WireError {
  code: WorkerErrorCode;
  fatal: boolean;
  message: string;
  detail?: { status?: number; url?: string; codec?: string };
}
