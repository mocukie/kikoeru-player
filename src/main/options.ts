// createEngine() 的選項驗證與預設值。

import type { Platform } from './platform.js';
import type { EngineOptions, LogHook, LogLevel } from './types.js';

/** 補上預設值、驗證過的 `EngineOptions`。 */
export interface ResolvedEngineOptions {
  platform: Platform;
  /** 原樣保留 App 給的資產位置；沒給的由真實的資產載入處以 `import.meta.url` 解析。 */
  assets: NonNullable<EngineOptions['assets']>;
  canvas: HTMLCanvasElement | null;
  timeUpdateInterval: number;
  /** `packetQueueBytes` 是內部常數（封包佇列的硬上限），不在 `EngineOptions` 中。 */
  limits: { cacheBytes: number; readaheadSeconds: number; packetQueueBytes: number };
  retry: { attempts: number; baseDelayMs: number };
  stallTimeout: number;
  stallAttempts: number;
  preferredLanguages: { audio: readonly string[]; subtitle: readonly string[] };
  suspendVideoWhenHidden: boolean;
  audioBuffer: { targetMs: number; refillMs: number; capacityMs: number };
  audioFadeMs: number;
  log: LogHook | null;
  logLevel: LogLevel;
}

const MiB = 1024 * 1024;

/** 依平台分級的預設值（「記憶體上限的數值」#23、「音訊輸出排程與變速」#13）；實機量測後調整。 */
const platformDefaults: Record<
  Platform,
  Pick<ResolvedEngineOptions, 'audioBuffer'> & { cacheBytes: number; packetQueueBytes: number }
> = {
  desktop: {
    audioBuffer: { targetMs: 150, refillMs: 75, capacityMs: 400 },
    cacheBytes: 128 * MiB,
    packetQueueBytes: 64 * MiB,
  },
  android: {
    audioBuffer: { targetMs: 250, refillMs: 125, capacityMs: 600 },
    cacheBytes: 64 * MiB,
    packetQueueBytes: 32 * MiB,
  },
  ios: {
    audioBuffer: { targetMs: 300, refillMs: 150, capacityMs: 750 },
    cacheBytes: 64 * MiB,
    packetQueueBytes: 32 * MiB,
  },
};

/**
 * 以平台預設值補齊 `options` 並驗證範圍；超出範圍時丟 `RangeError`，訊息指出選項名稱。
 * 平台由呼叫端判斷一次後傳入。
 */
export function resolveEngineOptions(
  options: EngineOptions | undefined,
  platform: Platform,
): ResolvedEngineOptions {
  const defaults = platformDefaults[platform];
  const o = options ?? {};
  const audioBuffer = { ...defaults.audioBuffer, ...definedOnly(o.audioBuffer) };
  const { targetMs, refillMs, capacityMs } = audioBuffer;
  if (
    ![targetMs, refillMs, capacityMs].every(Number.isFinite) ||
    !(0 < refillMs && refillMs < targetMs && targetMs < capacityMs)
  ) {
    throw new RangeError(
      `audioBuffer 必須 0 < refillMs < targetMs < capacityMs，補上預設值後為 refillMs (${String(refillMs)})、targetMs (${String(targetMs)})、capacityMs (${String(capacityMs)})`,
    );
  }

  return {
    platform,
    assets: { ...o.assets },
    canvas: o.canvas ?? null,
    timeUpdateInterval: positive('timeUpdateInterval', o.timeUpdateInterval ?? 250),
    limits: {
      cacheBytes: positive('limits.cacheBytes', o.limits?.cacheBytes ?? defaults.cacheBytes),
      readaheadSeconds: positive('limits.readaheadSeconds', o.limits?.readaheadSeconds ?? 60),
      packetQueueBytes: defaults.packetQueueBytes,
    },
    retry: {
      attempts: nonNegativeInteger('retry.attempts', o.retry?.attempts ?? 3),
      baseDelayMs: nonNegative('retry.baseDelayMs', o.retry?.baseDelayMs ?? 500),
    },
    stallTimeout: positive('stallTimeout', o.stallTimeout ?? 8000),
    stallAttempts: nonNegativeInteger('stallAttempts', o.stallAttempts ?? 2),
    preferredLanguages: {
      audio: [...(o.preferredLanguages?.audio ?? [])],
      subtitle: [...(o.preferredLanguages?.subtitle ?? [])],
    },
    suspendVideoWhenHidden: o.suspendVideoWhenHidden ?? true,
    audioBuffer,
    audioFadeMs: inRange('audioFadeMs', o.audioFadeMs ?? 10, 0, 100),
    log: o.log ?? null,
    logLevel: o.logLevel ?? 'warn',
  };
}

/** 拿掉值為 undefined 的欄位，讓 spread 不會蓋掉預設值。 */
function definedOnly<T extends object>(value: T | undefined): Partial<T> {
  return Object.fromEntries(
    Object.entries(value ?? {}).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

function positive(name: string, value: number): number {
  if (!(Number.isFinite(value) && value > 0)) throw outOfRange(name, value, '大於 0 的有限數');
  return value;
}

function nonNegative(name: string, value: number): number {
  if (!(Number.isFinite(value) && value >= 0)) throw outOfRange(name, value, '0 以上的有限數');
  return value;
}

function nonNegativeInteger(name: string, value: number): number {
  if (!(Number.isInteger(value) && value >= 0)) throw outOfRange(name, value, '0 以上的整數');
  return value;
}

function inRange(name: string, value: number, min: number, max: number): number {
  if (!(value >= min && value <= max)) {
    throw outOfRange(name, value, `${String(min)}–${String(max)}`);
  }
  return value;
}

function outOfRange(name: string, value: number, expected: string): RangeError {
  return new RangeError(`${name} 必須是 ${expected}，收到 ${String(value)}`);
}
