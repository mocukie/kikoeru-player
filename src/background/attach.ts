// 背景播放模組的實作：靜音 anchor 跟著 Engine 的播放意圖、外部操作的鏡像、audioSession 的設定與還原。
// anchor 元素與 audioSession 由 `BackgroundEnv` 注入，Node 測試以假物件驅動；公開的 entry 在 index.ts。

import { isAbortError, type Engine, type LogEntry } from '../index.js';
import type { BackgroundPlaybackOptions } from './index.js';

/** anchor 用到的 `HTMLAudioElement` 成員。 */
export interface AnchorElement extends EventTarget {
  src: string;
  loop: boolean;
  volume: number;
  readonly paused: boolean;
  play(): Promise<void>;
  pause(): void;
  removeAttribute(name: string): void;
  load(): void;
}

/** `navigator.audioSession`（Audio Session API）用到的部分；TypeScript 的 dom lib 還沒有它。 */
export interface AudioSessionLike {
  type: string;
}

/** 模組與頁面的接點：真實環境見 index.ts。 */
export interface BackgroundEnv {
  createAnchor(): AnchorElement;
  /** attach 時的 `navigator.audioSession`；不支援時為 undefined。 */
  audioSession: AudioSessionLike | undefined;
}

const ANCHOR_SECONDS = 5;
const ANCHOR_SAMPLE_RATE = 8000;
const ANCHOR_VOLUME = 0.0001;

/** 已 attach 的 Engine：重複 attach 丟錯。 */
const attached = new WeakSet<Engine>();

export function attachWith(
  engine: Engine,
  options: BackgroundPlaybackOptions,
  env: BackgroundEnv,
): { detach(): void } {
  if (attached.has(engine)) {
    throw new Error(
      'kikoeru-player/background：這個 Engine 已經 attach 過背景播放模組，先 detach()',
    );
  }
  attached.add(engine);

  const listening = new AbortController();
  const { signal } = listening;
  const log = (level: LogEntry['level'], message: string, data?: Record<string, unknown>) => {
    options.log?.({
      level,
      scope: 'background',
      message,
      time: performance.now(),
      ...(data && { data }),
    });
  };

  const session = options.audioSession === false ? undefined : env.audioSession;
  const sessionType = session?.type;

  const anchor = options.anchor === false ? null : createAnchor(env);
  // anchor 是否曾在 gesture 內被允許播放；false 時每次 beforeaudiostart 都 play() 一次以取得授權。
  let granted = false;
  let detached = false;

  /** anchor 該不該播：跟著播放意圖，error 與 idle 時沒有媒體可播。 */
  const wanted = () => !engine.paused && engine.state !== 'error' && engine.state !== 'idle';

  // 模組自己發出、還沒有結果的 play()：期間不再 play()；模組自己 pause() 時清掉（那個 play() 會以 AbortError 結束）。
  let starting: object | null = null;

  const start = (anchor: AnchorElement) => {
    const attempt = {};
    starting = attempt;
    const settled = () => {
      if (starting === attempt) starting = null;
    };
    anchor.play().then(
      () => {
        settled();
        granted = true;
      },
      (error: unknown) => {
        settled();
        if (detached) return;
        // 被之後的 pause() 中斷：播放本身是允許的。
        if (isAbortError(error)) {
          granted = true;
          return;
        }
        if (error instanceof DOMException && error.name === 'NotAllowedError') granted = false;
        log('warn', '靜音 anchor 無法播放，下一次 beforeaudiostart 或 play() 時再試', {
          error: String(error),
        });
      },
    );
  };

  const stop = (anchor: AnchorElement) => {
    starting = null;
    if (!anchor.paused) anchor.pause();
  };

  // 上一次 statechange 時的 wanted()：anchor 只在它由 false 變成 true 時開始播放，被拒的 play() 不會在之後每次
  // state 轉換都重試。
  let wasWanted = false;

  const sync = () => {
    if (detached || !anchor) return;
    const now = wanted();
    if (now && !wasWanted) {
      if (anchor.paused && starting === null) start(anchor);
    } else if (!now) {
      stop(anchor);
    }
    wasWanted = now;
  };

  const detach = () => {
    if (detached) return;
    detached = true;
    listening.abort();
    attached.delete(engine);
    if (anchor) {
      anchor.pause();
      const url = anchor.src;
      anchor.removeAttribute('src');
      anchor.load();
      URL.revokeObjectURL(url);
    }
    if (session && sessionType !== undefined) session.type = sessionType;
  };

  engine.addEventListener(
    'beforeaudiostart',
    () => {
      if (session) session.type = 'playback';
      if (!anchor) return;
      // 在 gesture 的同步段內 play() 取得授權；play() 呼叫內的 beforeaudiostart 之後 paused 才變為 false，
      // 所以是否要停下來等這個呼叫結束再決定。
      if (anchor.paused && starting === null && (!granted || wanted())) start(anchor);
      queueMicrotask(() => {
        if (!detached && !wanted()) stop(anchor);
      });
    },
    { signal },
  );
  engine.addEventListener('statechange', sync, { signal });
  engine.addEventListener('destroy', detach, { signal });

  if (anchor) {
    // 不是模組自己造成的 play／pause（來電、audio focus 被搶、通知與鎖屏按鍵）：事件發出時 anchor 的狀態與
    // 播放意圖不符。模組自己的 play()／pause() 之後意圖已經一致，或 anchor 又被改回去（過期的事件）。
    anchor.addEventListener(
      'pause',
      () => {
        if (!anchor.paused || !wanted()) return;
        log('info', '靜音 anchor 被外部暫停，暫停 Engine');
        engine.pause().catch((error: unknown) => {
          if (!isAbortError(error)) log('warn', '鏡像 anchor 的暫停失敗', { error: String(error) });
        });
      },
      { signal },
    );
    anchor.addEventListener(
      'play',
      () => {
        if (anchor.paused || wanted()) return;
        if (engine.state === 'idle' || engine.state === 'error') {
          // 沒有媒體可播：anchor 停回去。
          stop(anchor);
          return;
        }
        log('info', '靜音 anchor 被外部播放，播放 Engine');
        engine.play().catch((error: unknown) => {
          if (!isAbortError(error)) log('warn', '鏡像 anchor 的播放失敗', { error: String(error) });
        });
      },
      { signal },
    );
    anchor.addEventListener(
      'error',
      () => {
        log('error', '靜音 anchor 載入失敗（App 的 CSP 的 media-src 要允許 blob:）');
      },
      { signal },
    );
  }

  sync();
  return { detach };
}

function createAnchor(env: BackgroundEnv): AnchorElement {
  const anchor = env.createAnchor();
  anchor.loop = true;
  anchor.volume = ANCHOR_VOLUME;
  anchor.src = URL.createObjectURL(silentWav(ANCHOR_SECONDS, ANCHOR_SAMPLE_RATE));
  return anchor;
}

/** 16-bit PCM、mono 的靜音 WAV。 */
function silentWav(seconds: number, sampleRate: number): Blob {
  const dataBytes = seconds * sampleRate * 2;
  const view = new DataView(new ArrayBuffer(44 + dataBytes));
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  text(36, 'data');
  view.setUint32(40, dataBytes, true);
  return new Blob([view.buffer], { type: 'audio/wav' });
}
