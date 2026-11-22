// 內嵌字幕的封包轉成 cue（#14 的 resolution：隨 demux 進度串流送出，不取出整條軌）。文字字幕取封包內的原始文字，
// 不解析標記；ASS／SSA 保留 Matroska 封包原文，並依 header 的 Format 重組成可以直接餵給 libass 的 Dialogue 行。

import type { ProbedSubtitleTrack, WireCue } from '../protocol/index.js';

/** 一個字幕封包，時間已換算到媒體時間軸（秒）。 */
export interface SubtitlePacket {
  /** 沒有時間戳時為 null。 */
  time: number | null;
  /** 容器沒有記錄時為 0。 */
  duration: number;
  data: Uint8Array;
}

/** Matroska 的 ASS／SSA 封包：`ReadOrder, Layer, Style, Name, MarginL, MarginR, MarginV, Effect, Text`。 */
const MATROSKA_FIELDS = [
  'readorder',
  'layer',
  'style',
  'name',
  'marginl',
  'marginr',
  'marginv',
  'effect',
  'text',
] as const;

/** header 沒有 `[Events]` 的 Format 時使用的 V4+ 標準 Format。 */
const DEFAULT_FORMAT = [
  'layer',
  'start',
  'end',
  'style',
  'name',
  'marginl',
  'marginr',
  'marginv',
  'effect',
  'text',
];

const decoder = new TextDecoder();

/**
 * 一條字幕軌的封包轉 cue；圖形字幕不會被選用。回傳 null 的封包不是 cue：沒有時間戳，或是 mov_text 用來清空畫面的
 * 空 sample。
 */
export function cueReader(
  track: Pick<ProbedSubtitleTrack, 'format' | 'header'>,
): (packet: SubtitlePacket) => WireCue | null {
  const { format } = track;
  if (format === 'ass' || format === 'ssa') {
    const fields = eventFormat(track.header ?? '');
    return (packet) => {
      if (packet.time === null) return null;
      const raw = decoder.decode(packet.data);
      const values = splitFields(raw);
      const readOrder = Number.parseInt(values.readorder ?? '', 10) || 0;
      const start = packet.time;
      const end = packet.time + packet.duration;
      const dialogue = `Dialogue: ${fields
        .map((field) => {
          switch (field) {
            case 'start':
              return assTime(start);
            case 'end':
              return assTime(end);
            case 'marked':
              return `Marked=${values.layer ?? '0'}`;
            default:
              return values[field as (typeof MATROSKA_FIELDS)[number]] ?? '';
          }
        })
        .join(',')}`;
      return {
        format,
        id: `${micros(start)}:${String(readOrder)}`,
        start,
        end,
        raw,
        readOrder,
        dialogue,
      };
    };
  }
  if (format === 'bitmap') return () => null;
  return (packet) => {
    if (packet.time === null) return null;
    const text = format === 'mov_text' ? movText(packet.data) : decoder.decode(packet.data);
    if (text === '') return null;
    const start = packet.time;
    return {
      format,
      id: `${micros(start)}:${hash(text)}`,
      start,
      end: start + packet.duration,
      text,
    };
  };
}

/** `[Events]` 段的 Format 欄位（小寫、去空白）。 */
function eventFormat(header: string): string[] {
  let inEvents = false;
  for (const line of header.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inEvents = trimmed.toLowerCase() === '[events]';
      continue;
    }
    if (!inEvents) continue;
    const match = /^format\s*:(.*)$/i.exec(trimmed);
    if (match) return (match[1] ?? '').split(',').map((f) => f.trim().toLowerCase());
  }
  return DEFAULT_FORMAT;
}

/** 依 Matroska 的欄位切開封包原文；Text 是最後一個欄位，可以含逗號。 */
function splitFields(raw: string): Partial<Record<(typeof MATROSKA_FIELDS)[number], string>> {
  const values: Partial<Record<(typeof MATROSKA_FIELDS)[number], string>> = {};
  let rest = raw;
  for (const [i, field] of MATROSKA_FIELDS.entries()) {
    if (i === MATROSKA_FIELDS.length - 1) {
      values[field] = rest;
      break;
    }
    const comma = rest.indexOf(',');
    if (comma < 0) {
      values[field] = rest;
      break;
    }
    values[field] = rest.slice(0, comma);
    rest = rest.slice(comma + 1);
  }
  return values;
}

/** ASS 的時間：`H:MM:SS.cc`。 */
function assTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360_000);
  const m = Math.floor(cs / 6000) % 60;
  const s = Math.floor(cs / 100) % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(h)}:${pad(m)}:${pad(s)}.${pad(cs % 100)}`;
}

/** mov_text（3GPP Timed Text）的 sample：16-bit big-endian 的長度加上文字，之後可能有 style 等 box。 */
function movText(data: Uint8Array): string {
  if (data.length < 2) return '';
  const length = ((data[0] ?? 0) << 8) | (data[1] ?? 0);
  return decoder.decode(data.subarray(2, 2 + length));
}

function micros(seconds: number): string {
  return String(Math.round(seconds * 1e6));
}

/** 文字的 FNV-1a（32-bit），區分同時開始的不同 cue。 */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
