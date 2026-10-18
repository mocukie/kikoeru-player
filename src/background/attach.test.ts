// 背景播放模組（#44）的同步規則：anchor 跟著 paused、外部操作的鏡像、audioSession、detach 與 destroy。
// 真實的 Engine（createEngineWith + 假 deps）配上假的 anchor 元素與 audioSession；真實 <audio> 見 index.browser.test.ts。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDeps, type FakeEngineDeps } from '../../test/fakes/engine-deps.js';
import { audioMedia } from '../../test/fakes/media-worker.js';
import { createEngineWith } from '../main/engine.js';
import type { Engine, LogEntry, Source } from '../index.js';
import { attachWith, type AnchorElement, type AudioSessionLike } from './attach.js';

const source: Source = { kind: 'http', url: 'https://example.test/a.flac' };

/**
 * 假的 `<audio>`：`play()`／`pause()` 立即改變 `paused`，`play`／`pause` 事件與 `play()` 的結果排在之後（同 media element 的
 * 「queue a task」）。`allowed` 為 false 時 `play()` 以 NotAllowedError reject、`paused` 不變。
 */
class FakeAnchor extends EventTarget implements AnchorElement {
  src = '';
  loop = false;
  volume = 1;
  paused = true;
  allowed = true;
  /** 依呼叫順序記錄 `play`／`pause`。 */
  readonly calls: ('play' | 'pause')[] = [];
  #pending: { resolve: () => void; reject: (error: unknown) => void }[] = [];

  play(): Promise<void> {
    this.calls.push('play');
    if (!this.allowed) {
      return Promise.reject(new DOMException('play() 不允許', 'NotAllowedError'));
    }
    const wasPaused = this.paused;
    this.paused = false;
    if (wasPaused) this.#queue('play');
    return new Promise<void>((resolve, reject) => {
      this.#pending.push({ resolve, reject });
      setTimeout(() => {
        // 還沒開始播放就被 pause()：已經以 AbortError reject。
        if (!this.paused)
          this.#settle((p) => {
            p.resolve();
          });
      }, 0);
    });
  }

  pause(): void {
    this.calls.push('pause');
    if (this.paused) return;
    this.paused = true;
    this.#settle((p) => {
      p.reject(new DOMException('被 pause() 中斷', 'AbortError'));
    });
    this.#queue('pause');
  }

  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }

  load(): void {
    this.paused = true;
  }

  #settle(how: (p: { resolve: () => void; reject: (error: unknown) => void }) => void): void {
    for (const p of this.#pending.splice(0)) how(p);
  }

  #queue(type: 'play' | 'pause'): void {
    setTimeout(() => this.dispatchEvent(new Event(type)), 0);
  }
}

let anchors: FakeAnchor[];
let session: AudioSessionLike | undefined;
let logs: LogEntry[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  anchors = [];
  session = { type: 'auto' };
  logs = [];
});

afterEach(() => {
  vi.useRealTimers();
});

/** 讓排隊中的事件與 microtask 跑完（不推進時間）。 */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function attach(engine: Engine, options: { audioSession?: boolean; anchor?: boolean } = {}) {
  return attachWith(
    engine,
    { ...options, log: (entry) => logs.push(entry) },
    {
      createAnchor: () => {
        const anchor = new FakeAnchor();
        anchors.push(anchor);
        return anchor;
      },
      audioSession: session,
    },
  );
}

function anchor(): FakeAnchor {
  const last = anchors.at(-1);
  if (!last) throw new Error('沒有建立 anchor');
  return last;
}

/** 載入到 ready（paused），還沒有解鎖 AudioContext。 */
async function loaded(deps: FakeEngineDeps = createFakeDeps()) {
  const engine = createEngineWith(deps);
  const loading = engine.load(source);
  const worker = deps.workers.last;
  await worker.probe(audioMedia({ duration: 10 }));
  await worker.next('start');
  deps.audio.reply({ type: 'paused' });
  await loading;
  return { engine, deps, worker };
}

/** play() 並讓 worklet 回報 playing。 */
async function play(engine: Engine, deps: FakeEngineDeps): Promise<void> {
  const started = engine.play();
  await settle();
  deps.audio.reply({ type: 'playing' });
  await started;
  await settle();
}

describe('anchor', () => {
  it('是 5 秒、8 kHz、mono 的靜音 WAV blob URL，loop、volume 0.0001', async () => {
    const { engine } = await loaded();
    attach(engine);

    expect(anchor()).toMatchObject({ loop: true, volume: 0.0001, paused: true });
    expect(anchor().src).toMatch(/^blob:/);
    const blob = await (await fetch(anchor().src)).blob();
    const view = new DataView(await blob.arrayBuffer());
    const text = (at: number) =>
      String.fromCharCode(...new Uint8Array(view.buffer, at, 4).values());
    expect(blob.type).toBe('audio/wav');
    expect([text(0), text(8), text(12), text(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(8000);
    const bytesPerSample = view.getUint16(34, true) / 8;
    expect(view.getUint32(40, true) / bytesPerSample / 8000).toBe(5);
    expect(new Uint8Array(view.buffer, 44).every((b) => b === 0)).toBe(true);
  });

  it('跟著 paused 播放與停止，不看 state', async () => {
    const { engine, deps } = await loaded();
    attach(engine);

    await play(engine, deps);
    expect(anchor().paused).toBe(false);

    // buffering、seeking 時 paused 仍為 false：繼續播放。
    deps.audio.reply({ type: 'starved' });
    await vi.advanceTimersByTimeAsync(300);
    expect(engine.state).toBe('buffering');
    void engine.seek(5);
    expect(engine.state).toBe('seeking');
    expect(anchor().paused).toBe(false);

    const pausing = engine.pause();
    expect(anchor().paused).toBe(true);
    deps.audio.reply({ type: 'paused' });
    await pausing;
    await settle();
    expect(anchor().paused).toBe(true);
    // 都是模組自己觸發的：沒有鏡像回 Engine。
    expect(engine.paused).toBe(true);
  });

  it('ended 時 paused 維持 false，繼續播放；接下一首的 load(…, { paused: false }) 期間也不停', async () => {
    const { engine, deps } = await loaded();
    attach(engine);
    await play(engine, deps);

    deps.audio.reply({ type: 'ended' });
    expect(engine.state).toBe('ended');
    expect(anchor().paused).toBe(false);

    const next = engine.load(source, { paused: false });
    expect(engine.state).toBe('loading');
    const worker = deps.workers.last;
    await worker.probe(audioMedia({ duration: 10 }));
    await worker.next('start');
    deps.audio.reply({ type: 'playing' });
    await next;
    await settle();
    expect(engine.state).toBe('playing');
    expect(anchor().calls).toEqual(['play']);
  });

  it('error、idle 時停止，即使 paused 為 false', async () => {
    const { engine, deps, worker } = await loaded();
    attach(engine);
    await play(engine, deps);

    worker.crash(new Error('boom'));
    expect(engine.state).toBe('error');
    expect(anchor().paused).toBe(true);

    // idle 時的 play()：paused 改為 false，但沒有媒體。
    await engine.unload();
    await engine.play().catch(() => undefined);
    await settle();
    expect(engine.paused).toBe(false);
    expect(anchor().paused).toBe(true);
  });

  it('attach 時 Engine 已在播放：立即開始', async () => {
    const { engine, deps } = await loaded();
    await play(engine, deps);

    attach(engine);
    expect(anchor().paused).toBe(false);
  });

  it('anchor: false 時不建立 anchor', async () => {
    const { engine, deps } = await loaded();
    attach(engine, { anchor: false });
    await play(engine, deps);
    expect(anchors).toEqual([]);
  });
});

describe('第一次在 beforeaudiostart 內取得 gesture 授權', () => {
  it('unlockAudio()：在 listener 內同步 play()，paused 仍為 true 所以隨即 pause()', async () => {
    const deps = createFakeDeps();
    const engine = createEngineWith(deps);
    attach(engine);
    let inListener: string[] = [];
    engine.addEventListener('beforeaudiostart', () => {
      inListener = [...anchor().calls];
    });

    engine.unlockAudio();
    // 模組的 listener 先註冊，在 unlockAudio() 的呼叫內就已經 play()。
    expect(inListener).toEqual(['play']);
    await settle();
    expect(anchor().calls).toEqual(['play', 'pause']);
    expect(anchor().paused).toBe(true);
    expect(engine.paused).toBe(true);
    expect(logs.filter((l) => l.level !== 'debug')).toEqual([]);
  });

  it('play()：beforeaudiostart 內 play() 之後 paused 變為 false，不再 pause()', async () => {
    const { engine, deps } = await loaded();
    attach(engine);

    await play(engine, deps);
    expect(anchor().calls).toEqual(['play']);
    expect(anchor().paused).toBe(false);
  });

  it('已經取得授權後，beforeaudiostart 不再為了授權而 play()', async () => {
    const { engine, deps } = await loaded();
    attach(engine);
    engine.unlockAudio();
    await settle();
    expect(anchor().calls).toEqual(['play', 'pause']);

    // 長時間暫停被 suspend 後的 play()：beforeaudiostart（resume）照常發出。
    deps.audio.emitState('suspended');
    engine.unlockAudio();
    await settle();
    expect(anchor().calls).toEqual(['play', 'pause']);
  });
});

describe('play() 被拒', () => {
  it('不算 Engine 的錯誤、記 log；paused 變成 false 時再試', async () => {
    const { engine, deps } = await loaded();
    attach(engine);
    anchor().allowed = false;

    await play(engine, deps);
    expect(engine.state).toBe('playing');
    expect(engine.error).toBeNull();
    expect(anchor().paused).toBe(true);
    expect(logs).toContainEqual(expect.objectContaining({ level: 'warn', scope: 'background' }));

    const pausing = engine.pause();
    deps.audio.reply({ type: 'paused' });
    await pausing;
    anchor().allowed = true;
    await play(engine, deps);
    expect(anchor().paused).toBe(false);
  });

  it('下一次 beforeaudiostart 時再試，即使 paused 仍為 true', async () => {
    const deps = createFakeDeps();
    const engine = createEngineWith(deps);
    attach(engine);
    anchor().allowed = false;
    engine.unlockAudio();
    await settle();
    expect(anchor().calls).toEqual(['play']);

    anchor().allowed = true;
    deps.audio.emitState('suspended');
    engine.unlockAudio();
    await settle();
    expect(anchor().calls).toEqual(['play', 'play', 'pause']);
  });
});

describe('外部操作 anchor', () => {
  it('外部的 pause() 鏡像為 engine.pause()，reason 為 command', async () => {
    const { engine, deps } = await loaded();
    attach(engine);
    await play(engine, deps);
    const changes: { paused: boolean; reason: string }[] = [];
    engine.addEventListener('statechange', (e) => changes.push(e));

    anchor().pause();
    await settle();

    expect(engine.paused).toBe(true);
    expect(changes[0]).toMatchObject({ paused: true, reason: 'command' });
    deps.audio.reply({ type: 'paused' });
    await settle();
    expect(engine.state).toBe('paused');
  });

  it('外部的 play() 鏡像為 engine.play()', async () => {
    const { engine, deps } = await loaded();
    attach(engine);
    await play(engine, deps);
    const pausing = engine.pause();
    deps.audio.reply({ type: 'paused' });
    await pausing;
    await settle();

    anchor()
      .play()
      .catch(() => undefined);
    await settle();
    expect(engine.paused).toBe(false);
    deps.audio.reply({ type: 'playing' });
    await settle();
    expect(engine.state).toBe('playing');
    expect(anchor().paused).toBe(false);
  });

  it('engine.play() 失敗（AUDIO_LOCKED）時 paused 回到 true，anchor 也停止', async () => {
    const { engine, deps } = await loaded();
    attach(engine);
    deps.audio.behavior.resume = 'reject';

    anchor()
      .play()
      .catch(() => undefined);
    await settle();

    expect(engine.paused).toBe(true);
    expect(anchor().paused).toBe(true);
  });

  it('沒有媒體（idle）時的外部 play()：不鏡像，anchor 停回去', async () => {
    const engine = createEngineWith(createFakeDeps());
    attach(engine);

    anchor()
      .play()
      .catch(() => undefined);
    await settle();

    expect(engine.paused).toBe(true);
    expect(anchor().paused).toBe(true);
  });
});

describe('audioSession', () => {
  it('每次 beforeaudiostart 設定 type = "playback"；detach 時還原', async () => {
    const deps = createFakeDeps();
    const engine = createEngineWith(deps);
    const handle = attach(engine);
    expect(session?.type).toBe('auto');

    engine.unlockAudio();
    expect(session?.type).toBe('playback');
    await settle();

    // 其他程式改掉之後，下一次 beforeaudiostart 再設定。
    if (session) session.type = 'ambient';
    deps.audio.emitState('suspended');
    engine.unlockAudio();
    expect(session?.type).toBe('playback');

    handle.detach();
    expect(session?.type).toBe('auto');
  });

  it('沒有 navigator.audioSession 時什麼都不做', async () => {
    session = undefined;
    const { engine, deps } = await loaded();
    const handle = attach(engine);
    await play(engine, deps);
    handle.detach();
  });

  it('audioSession: false 時不設定', () => {
    const engine = createEngineWith(createFakeDeps());
    attach(engine, { audioSession: false });
    engine.unlockAudio();
    expect(session?.type).toBe('auto');
  });
});

describe('生命週期', () => {
  it('detach()：停止 anchor、revoke blob URL、不再跟著 Engine；可以重複呼叫', async () => {
    const { engine, deps } = await loaded();
    const handle = attach(engine);
    await play(engine, deps);
    const url = anchor().src;
    const revoke = vi.spyOn(URL, 'revokeObjectURL');

    handle.detach();
    handle.detach();

    expect(anchor().paused).toBe(true);
    expect(anchor().src).toBe('');
    expect(revoke).toHaveBeenCalledExactlyOnceWith(url);
    await settle();
    // detach 自己的 pause 不鏡像回 Engine。
    expect(engine.paused).toBe(false);
    const pausing = engine.pause();
    deps.audio.reply({ type: 'paused' });
    await pausing;
    await play(engine, deps);
    expect(anchor().calls).toEqual(['play', 'pause']);
    revoke.mockRestore();
  });

  it('同一個 Engine 重複 attach 丟錯；detach 之後可以再 attach', () => {
    const engine = createEngineWith(createFakeDeps());
    const handle = attach(engine);
    expect(() => attach(engine)).toThrow(Error);
    expect(anchors).toHaveLength(1);

    handle.detach();
    attach(engine).detach();
    expect(anchors).toHaveLength(2);
  });

  it('engine.destroy() 時自動 detach', async () => {
    const { engine, deps } = await loaded();
    attach(engine);
    await play(engine, deps);
    engine.unlockAudio();
    expect(session?.type).toBe('playback');

    await engine.destroy();

    expect(anchor().paused).toBe(true);
    expect(anchor().src).toBe('');
    expect(session?.type).toBe('auto');
    // 之後可以 attach 到新的 Engine；舊的 Engine 也不再視為已 attach。
    expect(() => {
      attach(engine).detach();
    }).not.toThrow();
  });

  it('沒有載入過媒體就 destroy()（state 沒有改變）也會 detach', async () => {
    const engine = createEngineWith(createFakeDeps());
    attach(engine);
    await engine.destroy();
    expect(anchor().src).toBe('');
  });
});
