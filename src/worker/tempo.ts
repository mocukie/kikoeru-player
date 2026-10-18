// 不變調變速（ADR-0004）：解碼、對齊媒體時間之後的 PCM 經過 stretcher（libav 的 `atempo`），1.0x 時繞過。
// 這裡只有不依賴 libav 的介面與邏輯；`atempo` 的實作在 libav.ts。
// 輸入已經是媒體時間軸上連續的 PCM（丟掉 preroll、補上空缺之後）；音軌 offset（外掛音軌的 issue）也要在進入這裡之前
// 套用，stretch 之後的時間才是媒體時間。
//
// time map：輸出依速度分成一段一段（segment），每段記下第一個輸出 frame 的媒體時間與速度，段內第 k 個輸出 frame 的
// 媒體時間是 `time + k × rate / sampleRate`。送出的 PCM chunk 帶這兩個值（不跨段），worklet 以它推進時鐘。
//
// 改速度採 drain：已經輸出的資料照舊速度播完，從還沒送進 stretcher 的下一個輸入 frame（接點）起換成新的速度。
// 接點的處理一律相同：舊的模式多處理接點之後 `CROSSFADE_SECONDS` 的輸入，新的模式從接點開始，兩者重疊的這一段
// 交叉淡化。stretcher 不以 `avfilter_graph_send_command` 改 tempo，而是送 EOF 排空後換一個新的：`atempo` 內部
// 切換速度的位置（WSOLA 的 fragment）從外面看不到，排空才能讓接點的媒體時間精確（見 ADR-0004）。
// `atempo` 排空時最後一段與新開始時第一段都是原樣的輸入，所以交叉淡化的兩邊幾乎相同，沒有不連續的跳點。

/** 一段 stereo planar 的 PCM。 */
export type Stereo = readonly [Float32Array, Float32Array];

/**
 * 一個固定速度的 stretcher（`atempo`）。輸入與輸出都是 `ctx.sampleRate` 的 stereo float planar；
 * 輸出比輸入晚一段（WSOLA 的 window），`drain()` 才排出最後一段。
 */
export interface Stretcher {
  /** 送入一段 PCM，回傳這次產生的輸出（可能沒有）。 */
  push(input: Stereo): Promise<Stereo[]>;
  /** 輸入結束：排出剩下的輸出。之後不能再 push。 */
  drain(): Promise<Stereo[]>;
  /** 釋放 filter graph。 */
  free(): Promise<void>;
}

/** 建立速度為 `rate` 的 stretcher。 */
export type CreateStretcher = (rate: number) => Promise<Stretcher>;

/** 配置 `frames` 個 frame 的輸出 buffer。 */
export type Allocate = (frames: number) => [Float32Array, Float32Array];

/** stretcher 的輸入：已對齊媒體時間、連續的 PCM（audio-pipeline.ts 的 PcmQueue 加上解碼）。 */
export interface PcmInput {
  /** 已解碼、還沒取出的 frame 數。 */
  readonly frames: number;
  /** 不會再有新的資料（decoder 已排空）。 */
  readonly ended: boolean;
  /** 再解碼一些；`ended` 時不做事。 */
  more(): Promise<void>;
  /** 取出最多 `frames` 個 frame 寫進 `allocate` 給的 buffer；`time` 是第一個 frame 的媒體時間。 */
  take(
    frames: number,
    allocate: Allocate,
  ): { time: number; channels: [Float32Array, Float32Array] };
  /** 與 `take` 相同，但不取出（複製一份）。 */
  peek(frames: number): { time: number; channels: [Float32Array, Float32Array] };
}

/** 一段要送給 worklet 的輸出：第一個 frame 的媒體時間與這段的速度。 */
export interface TempoChunk {
  time: number;
  rate: number;
  channels: [Float32Array, Float32Array];
}

/** 進出 stretcher（含 1.0x 的 bypass）時交叉淡化的長度（秒）；內部固定，不能設定（ADR-0004）。 */
export const CROSSFADE_SECONDS = 0.005;
/** 每次送進 stretcher 的輸入 frame 數。 */
const STRETCH_BLOCK = 2048;
/** bypass 的速度。 */
const BYPASS = 1;

/** 已經產生、還沒送出的輸出。同一段（`segment`）的 piece 在時間上連續。 */
interface Piece {
  segment: number;
  time: number;
  rate: number;
  channels: Stereo;
  offset: number;
}

/** 經過 stretcher 的一段輸出。`time` 在送入第一段輸入時才決定（開頭的那一段）。 */
interface Segment {
  id: number;
  time: number | null;
  rate: number;
  /** 已經產生的輸出 frame 數。 */
  produced: number;
}

/** 接點之前舊模式的輸出，與新模式那一段（`segment`）的開頭交叉淡化。 */
interface Crossfade {
  segment: number;
  channels: Stereo;
  offset: number;
}

const plain: Allocate = (frames) => [new Float32Array(frames), new Float32Array(frames)];

export interface TempoStageOptions {
  input: PcmInput;
  sampleRate: number;
  /** 開始時的速度。 */
  rate: number;
  createStretcher: CreateStretcher;
}

/**
 * 一個 epoch 的變速：依要求從輸入取資料，依目前的速度經過 stretcher 或直接輸出，並維護 time map。
 * 改速度（`setRate`）在下一次 `take` 時於接點生效。
 */
export class TempoStage {
  readonly #input: PcmInput;
  readonly #sampleRate: number;
  readonly #createStretcher: CreateStretcher;
  readonly #crossfadeFrames: number;
  /** 想要的速度；與 `#mode` 不同時，下一次 `take` 在接點切換。 */
  #target: number;
  /** 目前輸入經過的速度；1 為 bypass。 */
  #mode: number;
  #stretcher: Stretcher | null = null;
  #segment: Segment | null = null;
  /** bypass 的輸出屬於哪一段。 */
  #bypassSegment = 0;
  #segments = 0;
  /** 目前的 stretcher 已經排空（輸入結束）。 */
  #drained = false;
  readonly #out: Piece[] = [];
  #outFrames = 0;
  #crossfade: Crossfade | null = null;
  #closed = false;

  constructor(options: TempoStageOptions) {
    this.#input = options.input;
    this.#sampleRate = options.sampleRate;
    this.#createStretcher = options.createStretcher;
    this.#crossfadeFrames = Math.round(CROSSFADE_SECONDS * options.sampleRate);
    this.#target = this.#mode = options.rate;
  }

  /** 改變速度；已經產生的輸出照舊速度送出。 */
  setRate(rate: number): void {
    this.#target = rate;
  }

  /** 輸入用完，所有輸出都已經取出。 */
  get done(): boolean {
    return this.#outFrames === 0 && this.#inputExhausted() && (this.#bypassing || this.#drained);
  }

  /**
   * 取出最多 `frames` 個 frame（不跨段，所以可能比較少），寫進 `allocate` 給的 buffer；沒有資料了（`done`）時為 null。
   */
  async take(frames: number, allocate: Allocate): Promise<TempoChunk | null> {
    if (this.#target !== this.#mode && !this.#crossfade && !this.#inputExhausted()) {
      await this.#switch(this.#target);
    }
    if (!this.#bypassing) {
      while (this.#outFrames < frames && !this.#drained) await this.#stretchMore();
    }
    if (this.#outFrames > 0) return this.#takeOut(frames, allocate);
    if (!this.#bypassing) return null;
    const input = this.#input;
    while (input.frames < frames && !input.ended) await input.more();
    if (input.frames === 0) return null;
    const { time, channels } = input.take(Math.min(frames, input.frames), allocate);
    this.#mix(this.#bypassSegment, channels);
    return { time, rate: BYPASS, channels };
  }

  /** 釋放 stretcher；之後不能再使用。 */
  async close(): Promise<void> {
    this.#closed = true;
    const stretcher = this.#stretcher;
    this.#stretcher = null;
    await stretcher?.free();
  }

  get #bypassing(): boolean {
    return this.#mode === BYPASS;
  }

  #inputExhausted(): boolean {
    return this.#input.ended && this.#input.frames === 0;
  }

  /** 送一段輸入進 stretcher；輸入用完時排空它。 */
  async #stretchMore(): Promise<void> {
    const stretcher = await this.#ensureStretcher();
    const input = this.#input;
    while (input.frames < STRETCH_BLOCK && !input.ended) await input.more();
    if (input.frames === 0) {
      this.#append(await stretcher.drain());
      this.#drained = true;
      return;
    }
    const block = input.take(Math.min(STRETCH_BLOCK, input.frames), plain);
    if (this.#segment && this.#segment.time === null) this.#segment.time = block.time;
    this.#append(await stretcher.push(block.channels));
  }

  /** 開頭就是變速時，第一次需要時才建立 stretcher。 */
  async #ensureStretcher(): Promise<Stretcher> {
    if (this.#stretcher) return this.#stretcher;
    this.#stretcher = await this.#newStretcher(this.#mode);
    this.#segment = { id: ++this.#segments, time: null, rate: this.#mode, produced: 0 };
    return this.#stretcher;
  }

  async #newStretcher(rate: number): Promise<Stretcher> {
    const stretcher = await this.#createStretcher(rate);
    // 建立期間被中止（close）：不再使用，直接釋放。
    if (this.#closed) {
      await stretcher.free();
      throw new DOMException('變速已結束', 'AbortError');
    }
    return stretcher;
  }

  /**
   * 在接點換成速度 `rate`：舊的模式也處理接點之後的一段輸入（stretcher 再排空、釋放），它的最後一段輸出與新模式的
   * 開頭交叉淡化。
   */
  async #switch(rate: number): Promise<void> {
    const input = this.#input;
    while (input.frames < this.#crossfadeFrames && !input.ended) await input.more();
    const overlap = input.peek(Math.min(this.#crossfadeFrames, input.frames));
    let tail: Stereo = overlap.channels;
    if (!this.#bypassing) {
      const stretcher = await this.#ensureStretcher();
      if (this.#segment && this.#segment.time === null) this.#segment.time = overlap.time;
      const drained = [...(await stretcher.push(overlap.channels)), ...(await stretcher.drain())];
      this.#stretcher = null;
      await stretcher.free();
      const length = drained.reduce((sum, d) => sum + d[0].length, 0);
      const keep = Math.max(0, length - overlap.channels[0].length);
      this.#append(slice(drained, 0, keep));
      tail = concat(slice(drained, keep, length));
    }
    const id = ++this.#segments;
    this.#mode = rate;
    this.#drained = false;
    if (rate === BYPASS) {
      // 重疊的那段輸入還在 input 內，bypass 從接點開始輸出它。
      this.#bypassSegment = id;
      this.#segment = null;
    } else {
      input.take(overlap.channels[0].length, plain);
      this.#stretcher = await this.#newStretcher(rate);
      this.#segment = { id, time: overlap.time, rate, produced: 0 };
      this.#append(await this.#stretcher.push(overlap.channels));
    }
    this.#crossfade = tail[0].length > 0 ? { segment: id, channels: tail, offset: 0 } : null;
  }

  #append(outputs: readonly Stereo[]): void {
    const segment = this.#segment;
    if (!segment) return;
    for (const channels of outputs) {
      const frames = channels[0].length;
      if (frames === 0) continue;
      const time = (segment.time ?? 0) + (segment.produced * segment.rate) / this.#sampleRate;
      this.#out.push({ segment: segment.id, time, rate: segment.rate, channels, offset: 0 });
      segment.produced += frames;
      this.#outFrames += frames;
    }
  }

  /** 從已產生的輸出取出最多 `frames` 個 frame，只取同一段。 */
  #takeOut(frames: number, allocate: Allocate): TempoChunk {
    const first = this.#out[0];
    if (!first) throw new Error('沒有輸出');
    let available = 0;
    for (const piece of this.#out) {
      if (piece.segment !== first.segment) break;
      available += piece.channels[0].length - piece.offset;
    }
    const count = Math.min(frames, available);
    const channels = allocate(count);
    const time = first.time + (first.offset * first.rate) / this.#sampleRate;
    let written = 0;
    while (written < count) {
      const piece = this.#out[0];
      if (!piece) break;
      const n = Math.min(count - written, piece.channels[0].length - piece.offset);
      channels[0].set(piece.channels[0].subarray(piece.offset, piece.offset + n), written);
      channels[1].set(piece.channels[1].subarray(piece.offset, piece.offset + n), written);
      written += n;
      piece.offset += n;
      if (piece.offset === piece.channels[0].length) this.#out.shift();
    }
    this.#outFrames -= count;
    this.#mix(first.segment, channels);
    return { time, rate: first.rate, channels };
  }

  /** 新模式那一段的開頭：與舊模式的最後一段線性交叉淡化。 */
  #mix(segment: number, channels: [Float32Array, Float32Array]): void {
    const fade = this.#crossfade;
    if (fade?.segment !== segment) return;
    const total = fade.channels[0].length;
    const count = Math.min(channels[0].length, total - fade.offset);
    for (let i = 0; i < count; i++) {
      const w = (fade.offset + i + 1) / (total + 1);
      for (let c = 0; c < 2; c++) {
        const out = channels[c as 0 | 1];
        out[i] = (out[i] ?? 0) * w + (fade.channels[c as 0 | 1][fade.offset + i] ?? 0) * (1 - w);
      }
    }
    fade.offset += count;
    if (fade.offset >= total) this.#crossfade = null;
  }
}

/** `parts` 串起來之後 `[from, to)` 的部分。 */
function slice(parts: readonly Stereo[], from: number, to: number): Stereo[] {
  const out: Stereo[] = [];
  let at = 0;
  for (const part of parts) {
    const length = part[0].length;
    const start = Math.max(from, at);
    const end = Math.min(to, at + length);
    if (end > start) {
      out.push([part[0].subarray(start - at, end - at), part[1].subarray(start - at, end - at)]);
    }
    at += length;
  }
  return out;
}

function concat(parts: readonly Stereo[]): Stereo {
  const frames = parts.reduce((sum, p) => sum + p[0].length, 0);
  const out = plain(frames);
  let at = 0;
  for (const part of parts) {
    out[0].set(part[0], at);
    out[1].set(part[1], at);
    at += part[0].length;
  }
  return out;
}
