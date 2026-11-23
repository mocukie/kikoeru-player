// 把 libavformat 讀到的串流資訊整理成協定的 probe 結果：支援與否、語言、旗標與各 kind 的欄位。

import type {
  ProbedAudioTrack,
  ProbedMedia,
  ProbedSubtitleTrack,
  ProbedTrack,
  ProbedTrackBase,
  ProbedVideoTrack,
} from '../protocol/index.js';
import {
  displayRotation,
  displaySize,
  videoDecoderConfig,
  type VideoConfig,
} from './video-codec.js';

/** libav 層讀到的容器資訊，時間沿用 libavformat 的單位。 */
export interface RawMedia {
  /** libavformat 的格式名稱。 */
  format: string;
  /** `AVFormatContext.duration`（µs）；未知時為 null。 */
  duration: number | null;
  /** 來源的大小（bytes）。 */
  size: number;
  streams: readonly RawStream[];
}

/** 一條 libavformat 串流。 */
export interface RawStream {
  index: number;
  type: 'audio' | 'video' | 'subtitle' | 'other';
  /** `avcodec_get_name()` 的名稱。 */
  codec: string;
  /** wasm 內有這個 codec 的 decoder。 */
  decodable: boolean;
  sampleRate: number;
  channels: number;
  /** channel layout 的 mask；未指定時為 0。 */
  channelMask: number;
  /** `av_get_sample_fmt_name()` 的名稱。 */
  sampleFormat: string | null;
  width: number;
  height: number;
  frameRate: number | null;
  metadata: Readonly<Record<string, string>>;
  /** `AVStream.disposition`。 */
  disposition: number;
  /** 音訊與影片：`AVCodecParameters.extradata`（avcC、hvcC、av1C、ASS 的 header 等）。 */
  extradata: Uint8Array | null;
  /** `AVCodecParameters.bit_rate`（bits/s）；沒有記錄時為 0。 */
  bitRate: number;
  /** `AVCodecParameters.profile`／`level`；未知時為負數。 */
  profile: number;
  level: number;
  /** 影片的 display matrix（`AV_PKT_DATA_DISPLAYMATRIX`）；沒有時為 null。 */
  displayMatrix: Int32Array | null;
  /** 容器記錄的 sample aspect ratio（`AVStream.sample_aspect_ratio`）；未知時為 null。 */
  sampleAspectRatio: readonly [number, number] | null;
}

const AV_DISPOSITION_DEFAULT = 0x1;
const AV_DISPOSITION_FORCED = 0x40;

const textSubtitleFormats: Readonly<Record<string, ProbedSubtitleTrack['format']>> = {
  ass: 'ass',
  ssa: 'ssa',
  subrip: 'subrip',
  srt: 'subrip',
  webvtt: 'webvtt',
  mov_text: 'mov_text',
};
const bitmapSubtitleCodecs = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle']);

/** 常見 channel layout 的 FFmpeg 名稱（`av_channel_layout_describe()`），依 mask 對照。 */
const channelLayoutNames: ReadonlyMap<number, string> = new Map([
  [0x4, 'mono'],
  [0x3, 'stereo'],
  [0xb, '2.1'],
  [0x7, '3.0'],
  [0x103, '3.0(back)'],
  [0x107, '4.0'],
  [0x33, 'quad'],
  [0x603, 'quad(side)'],
  [0xf, '3.1'],
  [0x37, '5.0'],
  [0x607, '5.0(side)'],
  [0x3f, '5.1'],
  [0x60f, '5.1(side)'],
  [0x13f, '6.1(back)'],
  [0x70f, '6.1'],
  [0x63f, '7.1'],
]);

/** probe 結果；時間換算成秒。 */
export function toProbedMedia(raw: RawMedia): ProbedMedia {
  return {
    format: raw.format,
    duration: raw.duration === null ? NaN : raw.duration / 1e6,
    size: raw.size,
    tracks: raw.streams.flatMap((s) => {
      const track = toTrack(s);
      return track ? [track] : [];
    }),
  };
}

/** 至少有一條支援的音軌或影片軌；否則 load 為 `CODEC_UNSUPPORTED`。 */
export function hasPlayableTrack(media: ProbedMedia): boolean {
  return media.tracks.some((t) => t.kind !== 'subtitle' && t.supported);
}

function toTrack(s: RawStream): ProbedTrack | null {
  switch (s.type) {
    case 'audio':
      return audioTrack(s);
    case 'video':
      return videoTrack(s);
    case 'subtitle':
      return subtitleTrack(s);
    case 'other':
      return null;
  }
}

function audioTrack(s: RawStream): ProbedAudioTrack {
  const layout = channelLayoutNames.get(s.channelMask);
  const sampleFormat = pcmSampleFormat(s.codec) ?? s.sampleFormat;
  return {
    kind: 'audio',
    ...base(s, s.decodable),
    sampleRate: s.sampleRate,
    channels: s.channels,
    ...(layout !== undefined && { channelLayout: layout }),
    ...(sampleFormat && { sampleFormat }),
  };
}

function videoTrack(s: RawStream): ProbedVideoTrack {
  const config = videoConfig(s);
  return {
    kind: 'video',
    ...base(s, config !== null),
    ...(config && { codecString: config.codec }),
    codedWidth: s.width,
    codedHeight: s.height,
    display: displaySize(s.width, s.height, s.sampleAspectRatio, displayRotation(s.displayMatrix)),
    ...(s.frameRate !== null && { frameRate: s.frameRate }),
  };
}

/** 影片串流交給 `VideoDecoder` 的 config；Engine 對應不到 WebCodecs 的 codec 時為 null。 */
export function videoConfig(s: RawStream): VideoConfig | null {
  return videoDecoderConfig({
    codec: s.codec,
    profile: s.profile,
    level: s.level,
    extradata: s.extradata,
    width: s.width,
    height: s.height,
  });
}

/**
 * 判斷瀏覽器是否支援 Engine 支援的影片軌（load 時）：`isSupported` 為 false 或失敗（例如沒有 WebCodecs）時改為
 * `supported: false`、`unsupportedReason: 'platform'`。不偵測 UA：Safari 的 AV1、Firefox Android 的影片軌都由這條規則涵蓋。
 */
export async function withPlatformSupport(
  media: ProbedMedia,
  raw: RawMedia,
  isSupported: (config: VideoConfig) => Promise<boolean>,
): Promise<ProbedMedia> {
  const tracks = await Promise.all(
    media.tracks.map(async (track): Promise<ProbedTrack> => {
      if (track.kind !== 'video' || !track.supported) return track;
      const stream = raw.streams.find((s) => s.index === track.streamIndex);
      const config = stream ? videoConfig(stream) : null;
      const supported = config ? await isSupported(config).catch(() => false) : false;
      return supported ? track : { ...track, supported: false, unsupportedReason: 'platform' };
    }),
  );
  return { ...media, tracks };
}

function subtitleTrack(s: RawStream): ProbedSubtitleTrack | null {
  if (bitmapSubtitleCodecs.has(s.codec)) {
    return {
      kind: 'subtitle',
      ...base(s, false, 'bitmap-subtitle'),
      format: 'bitmap',
    };
  }
  const format = textSubtitleFormats[s.codec];
  if (!format) return null;
  const header =
    (format === 'ass' || format === 'ssa') && s.extradata
      ? new TextDecoder().decode(s.extradata)
      : undefined;
  return {
    kind: 'subtitle',
    ...base(s, true),
    format,
    ...(header !== undefined && { header }),
  };
}

function base(
  s: RawStream,
  supported: boolean,
  reason: ProbedTrackBase['unsupportedReason'] = 'codec',
): ProbedTrackBase {
  const rawLanguage = s.metadata.language;
  const language = rawLanguage === undefined ? undefined : normalizeLanguage(rawLanguage);
  const title = s.metadata.title;
  return {
    streamIndex: s.index,
    codec: s.codec,
    supported,
    ...(!supported && { unsupportedReason: reason }),
    ...(language !== undefined && { language }),
    ...(rawLanguage !== undefined && { rawLanguage }),
    ...(title !== undefined && { title }),
    default: (s.disposition & AV_DISPOSITION_DEFAULT) !== 0,
    forced: (s.disposition & AV_DISPOSITION_FORCED) !== 0,
  };
}

/**
 * 容器的語言碼（多為 ISO 639-2，例如 `'jpn'`、`'chi'`）正規化為 BCP 47。CLDR 的 alias 資料涵蓋三字母碼
 * （含 B／T 兩種寫法）對兩字母碼的對照，`Intl.getCanonicalLocales()` 依它正規化。
 */
function normalizeLanguage(raw: string): string | undefined {
  try {
    const [tag] = Intl.getCanonicalLocales(raw);
    return tag === undefined || tag === 'und' ? undefined : tag;
  } catch {
    return undefined;
  }
}

/** PCM 的原始取樣格式取自 codec 名稱：`pcm_s24le` 解出來是 s32，但原始格式是 s24。 */
function pcmSampleFormat(codec: string): string | undefined {
  const match = /^pcm_([suf])(\d+)/.exec(codec);
  return match ? `${match[1] ?? ''}${match[2] ?? ''}` : undefined;
}
