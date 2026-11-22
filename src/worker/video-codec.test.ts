import { describe, expect, it } from 'vitest';
import {
  displayRotation,
  displaySize,
  videoDecoderConfig,
  withParameterSets,
  type VideoCodecParams,
} from './video-codec.js';

/** CI 組 `video/h264-aac.mp4` 的 avcC（前 16 bytes 之後省略）。 */
const avcC = Uint8Array.from([1, 100, 0, 13, 255, 225, 0, 26, 103, 100, 0, 13, 172, 217, 65, 65]);
/** CI 組 `video/hevc-aac.mp4` 的 hvcC 開頭（23 bytes 的固定欄位）。 */
const hvcC = Uint8Array.from([
  1, 1, 96, 0, 0, 0, 144, 0, 0, 0, 0, 0, 60, 240, 0, 252, 253, 248, 248, 0, 0, 15, 3,
]);
/** CI 組 `video/av1-opus.webm` 的 av1C。 */
const av1C = Uint8Array.from([129, 0, 12, 0, 10, 11, 0, 0, 0, 4, 60, 254, 204, 2, 248, 0, 0]);

function params(overrides: Partial<VideoCodecParams>): VideoCodecParams {
  return {
    codec: 'h264',
    profile: -99,
    level: -99,
    extradata: null,
    width: 320,
    height: 180,
    ...overrides,
  };
}

describe('videoDecoderConfig', () => {
  it('H.264 的 avcC：codec string 取自 avcC，extradata 作為 description', () => {
    const config = videoDecoderConfig(params({ codec: 'h264', extradata: avcC }));
    expect(config).toEqual({
      codec: 'avc1.64000d',
      codedWidth: 320,
      codedHeight: 180,
      description: avcC,
    });
  });

  it('H.264 的 Annex B extradata：codec string 取自 SPS，不帶 description', () => {
    const annexB = Uint8Array.from([0, 0, 0, 1, 0x67, 0x4d, 0x40, 0x1f, 0xaa, 0, 0, 1, 0x68, 0xee]);
    expect(videoDecoderConfig(params({ codec: 'h264', extradata: annexB }))).toEqual({
      codec: 'avc1.4d401f',
      codedWidth: 320,
      codedHeight: 180,
    });
  });

  it('H.264 沒有 extradata（AVI）：依 codecpar 的 profile 與 level', () => {
    expect(videoDecoderConfig(params({ profile: 100, level: 13 }))?.codec).toBe('avc1.64000d');
  });

  it('HEVC 的 hvcC：profile、相容旗標（位元反轉）、tier、level 與 constraint', () => {
    const config = videoDecoderConfig(params({ codec: 'hevc', extradata: hvcC }));
    expect(config).toMatchObject({ codec: 'hvc1.1.6.L60.90', description: hvcC });
  });

  it('VP9：level 依畫面大小推算，8-bit', () => {
    expect(videoDecoderConfig(params({ codec: 'vp9', profile: 0 }))).toEqual({
      codec: 'vp09.00.11.08',
      codedWidth: 320,
      codedHeight: 180,
    });
    expect(
      videoDecoderConfig(params({ codec: 'vp9', profile: 2, width: 1920, height: 1080 }))?.codec,
    ).toBe('vp09.02.40.10');
  });

  it('AV1 的 av1C：profile、level、tier 與 bit depth，不帶 description', () => {
    expect(videoDecoderConfig(params({ codec: 'av1', extradata: av1C }))).toEqual({
      codec: 'av01.0.00M.08',
      codedWidth: 320,
      codedHeight: 180,
    });
  });

  it('VP8', () => {
    expect(videoDecoderConfig(params({ codec: 'vp8' }))?.codec).toBe('vp8');
  });

  it('對應不到 WebCodecs 的 codec 為 null', () => {
    expect(videoDecoderConfig(params({ codec: 'mpeg4' }))).toBeNull();
    expect(videoDecoderConfig(params({ codec: 'mjpeg' }))).toBeNull();
  });
});

describe('displayRotation', () => {
  it('display matrix 換算成順時針的角度', () => {
    // `ffmpeg -display_rotation 90`（逆時針 90°）寫出的 matrix（CI 組 rotated-90.mp4）。
    expect(displayRotation(Int32Array.from([0, -65536, 0, 65536, 0, 0, 0, 0, 1 << 30]))).toBe(270);
    expect(displayRotation(Int32Array.from([0, 65536, 0, -65536, 0, 0, 0, 0, 1 << 30]))).toBe(90);
    expect(displayRotation(Int32Array.from([-65536, 0, 0, 0, -65536, 0, 0, 0, 1 << 30]))).toBe(180);
    expect(displayRotation(Int32Array.from([65536, 0, 0, 0, 65536, 0, 0, 0, 1 << 30]))).toBe(0);
  });

  it('沒有 matrix 時為 0', () => {
    expect(displayRotation(null)).toBe(0);
  });
});

describe('displaySize', () => {
  it('套用 SAR 只拉寬，再依旋轉交換寬高', () => {
    expect(displaySize(320, 180, [1, 1], 0)).toEqual({ width: 320, height: 180, rotation: 0 });
    expect(displaySize(320, 180, [2, 1], 0)).toEqual({ width: 640, height: 180, rotation: 0 });
    expect(displaySize(320, 180, [1, 2], 0)).toEqual({ width: 320, height: 360, rotation: 0 });
    expect(displaySize(320, 180, [1, 1], 270)).toEqual({ width: 180, height: 320, rotation: 270 });
    expect(displaySize(320, 180, [2, 1], 90)).toEqual({ width: 180, height: 640, rotation: 90 });
  });

  it('SAR 未知（0 或 null）時視為 1:1', () => {
    expect(displaySize(320, 180, [0, 1], 0)).toEqual({ width: 320, height: 180, rotation: 0 });
    expect(displaySize(320, 180, null, 180)).toEqual({ width: 320, height: 180, rotation: 180 });
  });
});

describe('withParameterSets', () => {
  const sps = [0, 0, 0, 1, 0x67, 0x64, 0, 13];
  const pps = [0, 0, 0, 1, 0x68, 0xee];
  const idr = [0, 0, 0, 1, 0x65, 0x88, 0x84];

  it('Annex B 的 keyframe 沒有 SPS／PPS 時補上 extradata', () => {
    const extradata = Uint8Array.from([...sps, ...pps]);
    expect([...withParameterSets('h264', Uint8Array.from(idr), extradata)]).toEqual([
      ...sps,
      ...pps,
      ...idr,
    ]);
  });

  it('keyframe 已經帶 SPS 時原樣', () => {
    const data = Uint8Array.from([...sps, ...pps, ...idr]);
    expect(withParameterSets('h264', data, Uint8Array.from([...sps, ...pps]))).toBe(data);
  });

  it('HEVC 以 VPS／SPS／PPS（NAL type 32–34）判斷', () => {
    const vps = [0, 0, 1, 0x40, 0x01, 0x0c];
    const idrHevc = [0, 0, 1, 0x26, 0x01, 0xaf];
    const data = Uint8Array.from(idrHevc);
    expect([...withParameterSets('hevc', data, Uint8Array.from(vps))]).toEqual([
      ...vps,
      ...idrHevc,
    ]);
    const withVps = Uint8Array.from([...vps, ...idrHevc]);
    expect(withParameterSets('hevc', withVps, Uint8Array.from(vps))).toBe(withVps);
  });

  it('extradata 不是 Annex B（avcC）或沒有 extradata 時原樣', () => {
    const data = Uint8Array.from(idr);
    expect(withParameterSets('h264', data, avcC)).toBe(data);
    expect(withParameterSets('h264', data, null)).toBe(data);
  });
});
