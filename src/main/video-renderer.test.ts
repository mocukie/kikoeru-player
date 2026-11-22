import { describe, expect, it } from 'vitest';
import type { VideoTrack } from './types.js';
import { VideoRenderer, type RenderableFrame } from './video-renderer.js';

/** 假的 VideoFrame：時間以秒給，記錄是否 close。 */
class FakeFrame implements RenderableFrame {
  closed = false;
  readonly timestamp: number;
  readonly visibleRect = { width: 320, height: 180 };
  constructor(
    seconds: number,
    readonly displayWidth = 320,
    readonly displayHeight = 180,
  ) {
    this.timestamp = Math.round(seconds * 1e6);
  }
  close(): void {
    this.closed = true;
  }
}

/** 記錄 drawImage 與 transform 的假 2D context。 */
function fakeCanvas() {
  const calls: unknown[][] = [];
  const context = {
    setTransform: (...args: unknown[]) => calls.push(['setTransform', ...args]),
    translate: (...args: unknown[]) => calls.push(['translate', ...args]),
    rotate: (...args: unknown[]) => calls.push(['rotate', ...args]),
    drawImage: (...args: unknown[]) => calls.push(['drawImage', ...args]),
  };
  const canvas = {
    width: 300,
    height: 150,
    getContext: (type: string) => (type === '2d' ? context : null),
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, calls };
}

function track(overrides: Partial<VideoTrack> = {}): VideoTrack {
  return {
    kind: 'video',
    id: 'v:1',
    origin: 'container',
    streamIndex: 0,
    codec: 'h264',
    supported: true,
    default: true,
    forced: false,
    codedWidth: 320,
    codedHeight: 180,
    display: { width: 320, height: 180, rotation: 0 },
    ...overrides,
  };
}

const SOURCE = 'worker-1';

function setup(videoTrack: VideoTrack | null = track()) {
  const closed: { source: unknown; count: number }[] = [];
  const sizes: unknown[] = [];
  const renderer = new VideoRenderer({
    closed: (source, count) => closed.push({ source, count }),
    resized: (size) => sizes.push(size),
  });
  renderer.reset(1, videoTrack);
  const push = (seconds: number, epoch = 1, frame = new FakeFrame(seconds)) => {
    renderer.push(epoch, frame, SOURCE);
    return frame;
  };
  const closedCount = () => closed.reduce((sum, c) => sum + c.count, 0);
  return { renderer, closed, sizes, push, closedCount };
}

describe('VideoRenderer', () => {
  it('依時鐘挑選 pts ≤ 時鐘的最新一張，畫上去，之前畫的那張 close', () => {
    const { renderer, push, closedCount } = setup();
    const { canvas, calls } = fakeCanvas();
    renderer.attach(canvas);
    const frames = [0, 1 / 30, 2 / 30, 3 / 30].map((t) => push(t));

    renderer.render(0);
    expect(calls.filter((c) => c[0] === 'drawImage')).toEqual([
      ['drawImage', frames[0], 0, 0, 320, 180],
    ]);
    renderer.render(1.5 / 30);
    expect(calls.at(-1)).toEqual(['drawImage', frames[1], 0, 0, 320, 180]);
    expect(frames[0]?.closed).toBe(true);
    expect(frames[1]?.closed).toBe(false);
    expect(closedCount()).toBe(1);
    expect(renderer.dropped).toBe(0);
  });

  it('時鐘跳過的 frame 不畫，close 並計入 dropped', () => {
    const { renderer, push, closedCount } = setup();
    const frames = [0, 1 / 30, 2 / 30, 3 / 30].map((t) => push(t));
    renderer.render(0);
    renderer.render(3 / 30);
    expect(frames.map((f) => f.closed)).toEqual([true, true, true, false]);
    expect(renderer.dropped).toBe(2);
    expect(closedCount()).toBe(3);
    expect(renderer.open).toBe(1);
  });

  it('時鐘還沒到第一張時不畫', () => {
    const { renderer, push } = setup();
    const { canvas, calls } = fakeCanvas();
    renderer.attach(canvas);
    push(1);
    renderer.render(0.5);
    expect(calls).toEqual([]);
    expect(renderer.size).toBeNull();
  });

  it('canvas 的大小設為顯示尺寸；第一張畫出時 videoSize 才有值並通知', () => {
    const { renderer, push, sizes } = setup();
    const { canvas } = fakeCanvas();
    renderer.attach(canvas);
    expect(renderer.size).toBeNull();
    push(0);
    renderer.render(0);
    expect(renderer.size).toEqual({ width: 320, height: 180, rotation: 0 });
    expect(sizes).toEqual([{ width: 320, height: 180, rotation: 0 }]);
    expect([canvas.width, canvas.height]).toEqual([320, 180]);
    // 尺寸沒變時不再通知。
    push(1 / 30);
    renderer.render(1 / 30);
    expect(sizes).toHaveLength(1);
  });

  it('旋轉：canvas 交換寬高，繞中心旋轉後畫', () => {
    const { renderer, push } = setup(
      track({ display: { width: 180, height: 320, rotation: 270 } }),
    );
    const { canvas, calls } = fakeCanvas();
    renderer.attach(canvas);
    const frame = push(0);
    renderer.render(0);
    expect(renderer.size).toEqual({ width: 180, height: 320, rotation: 270 });
    expect([canvas.width, canvas.height]).toEqual([180, 320]);
    expect(calls).toEqual([
      ['setTransform', 1, 0, 0, 1, 0, 0],
      ['translate', 90, 160],
      ['rotate', (270 * Math.PI) / 180],
      ['drawImage', frame, -160, -90, 320, 180],
      ['setTransform', 1, 0, 0, 1, 0, 0],
    ]);
  });

  it('bitstream 的 SAR：沿用瀏覽器給的 displayWidth／displayHeight', () => {
    const { renderer, push } = setup();
    push(0, 1, new FakeFrame(0, 640, 180));
    renderer.render(0);
    expect(renderer.size).toEqual({ width: 640, height: 180, rotation: 0 });
  });

  it('容器的 SAR（軌道的 display 與 coded 不同）：以容器的比例拉伸 visible 尺寸', () => {
    const { renderer, push } = setup(track({ display: { width: 640, height: 180, rotation: 0 } }));
    // 瀏覽器也套用了 bitstream 的 SAR：容器優先，不重複套用。
    push(0, 1, new FakeFrame(0, 640, 180));
    renderer.render(0);
    expect(renderer.size).toEqual({ width: 640, height: 180, rotation: 0 });
  });

  it('沒有 canvas 時不畫，但照樣依時鐘消耗 frame（維持同步）', () => {
    const { renderer, push } = setup();
    const frames = [0, 1 / 30].map((t) => push(t));
    renderer.render(1 / 30);
    expect(frames[0]?.closed).toBe(true);
    expect(renderer.size).toEqual({ width: 320, height: 180, rotation: 0 });
  });

  it('attach 新的 canvas 時立即畫上目前的 frame；attach(null) 之後不再畫', () => {
    const { renderer, push } = setup();
    const frame = push(0);
    renderer.render(0);
    const { canvas, calls } = fakeCanvas();
    renderer.attach(canvas);
    expect(calls).toEqual([['drawImage', frame, 0, 0, 320, 180]]);
    renderer.attach(null);
    push(1 / 30);
    renderer.render(1 / 30);
    expect(calls).toHaveLength(1);
  });

  it('過期 epoch 的 frame 收到時就 close，不計入 dropped', () => {
    const { renderer, push, closed } = setup();
    renderer.flush(2);
    const stale = push(0, 1);
    expect(stale.closed).toBe(true);
    expect(closed).toEqual([{ source: SOURCE, count: 1 }]);
    expect(renderer.dropped).toBe(0);
  });

  it('flush（新的 epoch）：佇列中的 frame close，畫面上那張留到新 epoch 的 frame 畫出', () => {
    const { renderer, push, closedCount } = setup();
    const shown = push(0);
    const queued = push(1 / 30);
    renderer.render(0);
    renderer.flush(2);
    expect(queued.closed).toBe(true);
    expect(shown.closed).toBe(false);
    expect(renderer.dropped).toBe(0);
    push(5, 2);
    renderer.render(5);
    expect(shown.closed).toBe(true);
    expect(closedCount()).toBe(2);
  });

  it('reset：所有 frame close，videoSize 回到 null 並通知', () => {
    const { renderer, push, sizes } = setup();
    const frames = [0, 1 / 30].map((t) => push(t));
    renderer.render(0);
    renderer.reset(3, null);
    expect(frames.every((f) => f.closed)).toBe(true);
    expect(renderer.open).toBe(0);
    expect(renderer.size).toBeNull();
    expect(sizes.at(-1)).toBeNull();
  });

  it('close 的回報帶 frame 來自的 Worker', () => {
    const { renderer, closed } = setup();
    renderer.push(1, new FakeFrame(0), 'a');
    renderer.push(1, new FakeFrame(1 / 30), 'b');
    renderer.render(1 / 30);
    renderer.reset(2, null);
    expect(closed).toEqual([
      { source: 'a', count: 1 },
      { source: 'b', count: 1 },
    ]);
  });
});
