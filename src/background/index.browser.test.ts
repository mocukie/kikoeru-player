// 背景播放模組（#44）與真實的 Engine、真實的 `<audio>`：anchor 跟著 paused、外部操作 anchor 的鏡像、
// navigator.audioSession 的設定與還原（假物件）、destroy 時自動 detach、重複 attach 丟錯。

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { mediaUrl } from '../../test/media-worker-harness.js';
import { createEngine, type Engine, type LogEntry } from '../index.js';
import { attachBackgroundPlayback } from './index.js';

const source = { kind: 'http', url: mediaUrl('audio/flac.flac') } as const;

let engine: Engine | null = null;
let anchors: HTMLAudioElement[];
let logs: LogEntry[];

beforeEach(() => {
  anchors = [];
  logs = [];
  // 模組以 `new Audio()` 建立 anchor（不掛進 DOM）：包一層記下它。
  const RealAudio = window.Audio;
  vi.stubGlobal('Audio', function Audio() {
    const element = new RealAudio();
    anchors.push(element);
    return element;
  });
});

afterEach(async () => {
  await engine?.destroy();
  engine = null;
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'audioSession');
  document.body.replaceChildren();
});

async function until(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('等待逾時');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function anchor(): HTMLAudioElement {
  const last = anchors.at(-1);
  if (!last) throw new Error('沒有建立 anchor');
  return last;
}

/** 在 user gesture 內執行 `action`（Playwright 的 click）。 */
async function gesture(action: () => void): Promise<void> {
  const button = document.createElement('button');
  button.textContent = 'gesture';
  button.addEventListener('click', action, { once: true });
  document.body.append(button);
  await userEvent.click(button);
  button.remove();
}

function fakeAudioSession(type = 'auto'): { type: string } {
  const session = { type };
  Object.defineProperty(navigator, 'audioSession', { value: session, configurable: true });
  return session;
}

test('anchor 跟著 paused 播放與停止；是不掛進 DOM 的循環靜音 blob', async () => {
  const target = (engine = createEngine());
  attachBackgroundPlayback(target, { log: (entry) => logs.push(entry) });
  expect(anchor()).toMatchObject({ loop: true, volume: 0.0001, paused: true, isConnected: false });
  expect(anchor().src).toMatch(/^blob:/);
  await target.load(source);

  await gesture(() => void target.play().catch(() => undefined));
  await until(() => target.state === 'playing');
  await until(() => !anchor().paused && anchor().currentTime > 0);

  await target.pause();
  expect(anchor().paused).toBe(true);
  // 模組自己的 pause 不鏡像回 Engine。
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(target.paused).toBe(true);
  expect(target.state).toBe('paused');
  expect(logs.filter((l) => l.level === 'warn' || l.level === 'error')).toEqual([]);
});

test('unlockAudio()：在 gesture 內 play() 取得授權，paused 仍為 true 所以停下', async () => {
  const target = (engine = createEngine());
  attachBackgroundPlayback(target);
  const play = vi.spyOn(anchor(), 'play');
  const pause = vi.spyOn(anchor(), 'pause');

  await gesture(() => {
    target.unlockAudio();
  });

  expect(play).toHaveBeenCalledOnce();
  expect(pause).toHaveBeenCalledOnce();
  expect(anchor().paused).toBe(true);
  expect(target.paused).toBe(true);
});

test('外部呼叫 anchor 的 pause()／play()：反映到 Engine', async () => {
  const target = (engine = createEngine());
  attachBackgroundPlayback(target);
  await target.load(source);
  await gesture(() => void target.play().catch(() => undefined));
  await until(() => target.state === 'playing' && !anchor().paused);

  anchor().pause();
  await until(() => target.paused);
  await until(() => target.state === 'paused');

  await anchor().play();
  await until(() => !target.paused);
  await until(() => target.state === 'playing');
  expect(anchor().paused).toBe(false);
});

test('detach()：還原 navigator.audioSession、停止 anchor、revoke blob URL', async () => {
  const session = fakeAudioSession('auto');
  const target = (engine = createEngine());
  const playback = attachBackgroundPlayback(target);
  // 建立 AudioContext 之前的 beforeaudiostart（之後的 play() 不一定再發出：context 可能已經在執行）。
  await gesture(() => {
    target.unlockAudio();
  });
  expect(session.type).toBe('playback');
  await target.load(source);
  await gesture(() => void target.play().catch(() => undefined));
  await until(() => target.state === 'playing' && !anchor().paused);
  const url = anchor().src;

  playback.detach();
  playback.detach();
  expect(session.type).toBe('auto');
  expect(anchor().paused).toBe(true);
  await expect(fetch(url)).rejects.toThrow();
  // 不再跟著 Engine，Engine 也照常播放。
  expect(target.paused).toBe(false);
  await target.pause();
  await target.play();
  expect(anchor().paused).toBe(true);
});

test('engine.destroy() 時自動 detach；重複 attach 丟錯', async () => {
  const session = fakeAudioSession('ambient');
  const target = (engine = createEngine());
  attachBackgroundPlayback(target);
  expect(() => attachBackgroundPlayback(target)).toThrow(Error);
  expect(anchors).toHaveLength(1);
  await target.load(source);
  await gesture(() => void target.play().catch(() => undefined));
  await until(() => !anchor().paused);

  await target.destroy();

  expect(session.type).toBe('ambient');
  expect(anchor().paused).toBe(true);
  expect(anchor().getAttribute('src')).toBeNull();
});
