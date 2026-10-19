// 位元組率（bytes／媒體秒）：把預讀的秒數換算成 bytes，也把預讀的 bytes 換算回 `buffered` 的秒數（ADR-0007）。

/** 位元組率不明時的預設值（2 Mbps）；播放中再依實際讀到的位置修正。 */
const FALLBACK_BYTE_RATE = 256 * 1024;
/** 連續 demux 累計到這麼多媒體秒，才用實測值取代估計值。 */
const MIN_SPAN_SECONDS = 2;

/**
 * 初始估計（ADR-0007）：libav.js 沒有 `AVFormatContext.bit_rate` 的 accessor，而 FFmpeg 在容器沒有記錄時
 * 也是以各軌的 bit_rate 合計估它，所以這裡用所有音訊與影片軌的 bit_rate 合計（有一條沒有就不用）；少算的容器
 * overhead 由播放中的 `ByteRate` 修正。沒有時用「檔案大小 ÷ duration」，兩者都沒有時用保守的預設值。
 */
export function initialByteRate(media: {
  size: number;
  duration: number;
  /** 所有音訊與影片軌的 bit_rate（bits/s），沒有記錄的是 0。 */
  bitRates: readonly number[];
}): number {
  const { size, duration, bitRates } = media;
  if (bitRates.length > 0 && bitRates.every((b) => b > 0)) {
    return bitRates.reduce((sum, b) => sum + b, 0) / 8;
  }
  if (duration > 0 && size > 0) return size / duration;
  return FALLBACK_BYTE_RATE;
}

/** 依 demux 實際讀到的 byte 位置與封包的 pts 修正位元組率。 */
export class ByteRate {
  #value: number;
  /** 這一段連續 demux 的起點與最後一次觀察。 */
  #first: { position: number; time: number } | null = null;
  #last: { position: number; time: number } | null = null;

  constructor(initial: number) {
    this.#value = initial;
  }

  get value(): number {
    return this.#value;
  }

  /** seek 之後重新累計。 */
  reset(): void {
    this.#first = this.#last = null;
  }

  /** demux 讀到 byte 位置 `position` 時，已經 demux 出的封包到媒體時間 `time`（秒）。 */
  observe(position: number, time: number): void {
    const last = this.#last;
    if (!this.#first || !last || position < last.position || time < last.time) {
      this.#first = this.#last = { position, time };
      return;
    }
    this.#last = { position, time };
    const span = time - this.#first.time;
    const bytes = position - this.#first.position;
    if (span >= MIN_SPAN_SECONDS && bytes > 0) this.#value = bytes / span;
  }
}
