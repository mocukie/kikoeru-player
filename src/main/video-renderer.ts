// 影片的繪製：media Worker transfer 來的 VideoFrame 依音訊時鐘挑選 pts ≤ 時鐘的最新一張，以 2D context 畫到 App 的
// canvas（ADR-0002）。被時鐘跳過的 frame 丟棄並計入 dropped；每張 frame 都 close（硬性約束第 2 條），close 之後回報
// 給送來它的 Worker（backpressure）。

import type { VideoSize, VideoTrack } from './types.js';

/** `VideoFrame` 中這裡用到的部分。 */
export interface RenderableFrame {
  /** 媒體時間軸上的 µs。 */
  readonly timestamp: number;
  /** 瀏覽器套用 bitstream 的 SAR 之後的尺寸。 */
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly visibleRect: { readonly width: number; readonly height: number } | null;
  close(): void;
}

export interface VideoRendererOptions {
  /** close 了 `source`（送來 frame 的 Worker）的 `count` 張 frame。 */
  closed(source: unknown, count: number): void;
  /** `size`（`Engine.videoSize`）改變。 */
  resized(size: VideoSize | null): void;
}

interface Entry {
  frame: RenderableFrame;
  source: unknown;
  /** 畫出時決定的尺寸與方向；還沒畫出時為 null。 */
  layout: FrameLayout | null;
}

/** 一張 frame 怎麼畫：旋轉之後的顯示尺寸，與旋轉之前畫進 canvas 的寬高。 */
interface FrameLayout {
  size: VideoSize;
  width: number;
  height: number;
}

/** 時鐘與 pts 比較的容許誤差（秒）：pts 以 µs 表示，時鐘是浮點數。 */
const EPSILON = 1e-4;

export class VideoRenderer {
  readonly #options: VideoRendererOptions;
  /** 目前 epoch 的 frame，依 pts 排序（Worker 依 pts 的順序送出）。 */
  #queue: Entry[] = [];
  /** 畫面上的那張；換成下一張時 close。 */
  #shown: Entry | null = null;
  #epoch = 0;
  #track: VideoTrack | null = null;
  #canvas: HTMLCanvasElement | null = null;
  #size: VideoSize | null = null;
  /** 被時鐘跳過、沒有畫出就丟棄的 frame 數；`reset()` 時歸零。 */
  dropped = 0;

  constructor(options: VideoRendererOptions) {
    this.#options = options;
  }

  /** 選用影片軌畫出的 frame 的顯示尺寸；還沒畫出第一張、或沒有影片軌時為 null。 */
  get size(): VideoSize | null {
    return this.#size;
  }

  /** 佇列中還沒畫出的 frame 數。 */
  get queued(): number {
    return this.#queue.length;
  }

  /** 還沒 close 的 frame 數（`getStats().resources.openVideoFrames` 的主執行緒部分）。 */
  get open(): number {
    return this.#queue.length + (this.#shown ? 1 : 0);
  }

  /** 新的媒體：close 所有 frame，`size` 回到 null；之後畫 `track` 的 frame。 */
  reset(epoch: number, track: VideoTrack | null): void {
    this.#epoch = epoch;
    this.#track = track;
    this.dropped = 0;
    this.#closeQueue();
    if (this.#shown) this.#close([this.#shown]);
    this.#shown = null;
    this.#setSize(null);
  }

  /** 改為畫 `track`（null：不再畫影片）；`size` 等下一張畫出時更新，null 時立即回到 null。 */
  setTrack(track: VideoTrack | null): void {
    this.#track = track;
    if (!track) this.reset(this.#epoch, null);
  }

  /** 新的 epoch（seek 等）：佇列中的 frame close，畫面上的那張留到新 epoch 的第一張畫出。 */
  flush(epoch: number): void {
    this.#epoch = epoch;
    this.#closeQueue();
  }

  /** 收到 Worker 送來的 frame；過期的 epoch 或沒有選用影片軌時直接 close。 */
  push(epoch: number, frame: RenderableFrame, source: unknown): void {
    const entry: Entry = { frame, source, layout: null };
    if (epoch !== this.#epoch || !this.#track) {
      this.#close([entry]);
      return;
    }
    this.#queue.push(entry);
  }

  /**
   * 依時鐘（媒體時間，秒）挑選 pts ≤ 時鐘的最新一張並畫上去；之前還沒畫的 frame 丟棄、計入 dropped。沒有 canvas 時
   * 不畫，但同樣消耗 frame，維持同步。回傳是否換上了新的一張（時鐘還沒到佇列中的 frame 時為 false）。
   */
  render(clock: number): boolean {
    let pick = -1;
    for (let i = 0; i < this.#queue.length; i++) {
      const entry = this.#queue[i];
      if (!entry || entry.frame.timestamp / 1e6 > clock + EPSILON) break;
      pick = i;
    }
    if (pick < 0) return false;
    const skipped = this.#queue.splice(0, pick + 1);
    const next = skipped.pop();
    if (!next) return false;
    this.dropped += skipped.length;
    const old = this.#shown ? [this.#shown, ...skipped] : skipped;
    this.#shown = next;
    this.#close(old);
    this.#present(next);
    return true;
  }

  /** 換繪製目標；有畫面上的 frame 時立即畫到新的 canvas。null 表示不再繪製。 */
  attach(canvas: HTMLCanvasElement | null): void {
    this.#canvas = canvas;
    const shown = this.#shown;
    if (shown?.layout && canvas) this.#draw(canvas, shown.frame, shown.layout);
  }

  /**
   * 畫出之後才通知尺寸：listener 讀到的 canvas 已是新的尺寸，listener 內 `destroy()`／換檔 close 了這張 frame 也不會
   * 再用到它。
   */
  #present(entry: Entry): void {
    const layout = this.#layoutOf(entry.frame);
    entry.layout = layout;
    if (this.#canvas) this.#draw(this.#canvas, entry.frame, layout);
    this.#setSize(layout.size);
  }

  /**
   * 顯示尺寸：容器記錄了 SAR（軌道的 display 與 coded 的比例不同）時，以容器的比例拉伸 visible 尺寸；否則沿用瀏覽器
   * 套用 bitstream SAR 之後的 `displayWidth`／`displayHeight`。旋轉取自容器的 display matrix。回傳旋轉之後的 `size`
   * 與旋轉之前（畫進 canvas 時）的寬高。
   */
  #layoutOf(frame: RenderableFrame): FrameLayout {
    const track = this.#track;
    const rotation = track?.display.rotation ?? 0;
    const swap = rotation === 90 || rotation === 270;
    let width = frame.displayWidth;
    let height = frame.displayHeight;
    if (track) {
      const displayWidth = swap ? track.display.height : track.display.width;
      const displayHeight = swap ? track.display.width : track.display.height;
      if (displayWidth !== track.codedWidth || displayHeight !== track.codedHeight) {
        const visible = frame.visibleRect ?? {
          width: frame.displayWidth,
          height: frame.displayHeight,
        };
        width = Math.round((visible.width * displayWidth) / track.codedWidth);
        height = Math.round((visible.height * displayHeight) / track.codedHeight);
      }
    }
    const size = swap ? { width: height, height: width, rotation } : { width, height, rotation };
    return { size, width, height };
  }

  #draw(canvas: HTMLCanvasElement, frame: RenderableFrame, layout: FrameLayout): void {
    const { size, width, height } = layout;
    if (canvas.width !== size.width) canvas.width = size.width;
    if (canvas.height !== size.height) canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) return;
    const image = frame as unknown as CanvasImageSource;
    if (size.rotation === 0) {
      context.drawImage(image, 0, 0, size.width, size.height);
      return;
    }
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.translate(size.width / 2, size.height / 2);
    context.rotate((size.rotation * Math.PI) / 180);
    context.drawImage(image, -width / 2, -height / 2, width, height);
    context.setTransform(1, 0, 0, 1, 0, 0);
  }

  #setSize(size: VideoSize | null): void {
    const old = this.#size;
    if (
      old === size ||
      (old !== null &&
        size !== null &&
        old.width === size.width &&
        old.height === size.height &&
        old.rotation === size.rotation)
    ) {
      return;
    }
    this.#size = size;
    this.#options.resized(size);
  }

  #closeQueue(): void {
    const queue = this.#queue;
    this.#queue = [];
    this.#close(queue);
  }

  /** close 這些 frame，依來源合計回報。 */
  #close(entries: readonly Entry[]): void {
    const counts = new Map<unknown, number>();
    for (const { frame, source } of entries) {
      frame.close();
      counts.set(source, (counts.get(source) ?? 0) + 1);
    }
    for (const [source, count] of counts) this.#options.closed(source, count);
  }
}
