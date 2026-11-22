// 影片軌交給 WebCodecs 的設定：codec string、description（avcC／hvcC）、Annex B 的參數集，以及顯示尺寸（旋轉與 SAR）。
// 只依容器資訊計算，不碰 WebCodecs；瀏覽器是否支援（`isConfigSupported`）由 media Worker 判斷。

/** 影片軌的容器資訊（libavformat 的 codecpar）。 */
export interface VideoCodecParams {
  /** `avcodec_get_name()` 的名稱。 */
  codec: string;
  /** `AVCodecParameters.profile`；未知時為負數（`AV_PROFILE_UNKNOWN`）。 */
  profile: number;
  /** `AVCodecParameters.level`；未知時為負數或 0。 */
  level: number;
  extradata: Uint8Array | null;
  width: number;
  height: number;
}

/** `VideoDecoderConfig` 中 Engine 會設定的欄位。 */
export interface VideoConfig {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  /** avcC／hvcC；Annex B 的串流不帶（參數集在 keyframe 內，見 `withParameterSets()`）。 */
  description?: Uint8Array;
}

/** 顯示尺寸。 */
export interface DisplaySize {
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
}

/**
 * 依容器資訊產生 `VideoDecoderConfig`；Engine 對應不到 WebCodecs 的 codec 時為 null（`unsupportedReason: 'codec'`）。
 * codec string 依 WebCodecs codec registry：AVC 與 HEVC 取自 avcC／hvcC（Annex B 時取自 SPS 或 codecpar），
 * VP9 的 level 沒有記錄時依畫面大小推算，AV1 取自 av1C。
 */
export function videoDecoderConfig(p: VideoCodecParams): VideoConfig | null {
  const coded = { codedWidth: p.width, codedHeight: p.height };
  const ex = p.extradata;
  switch (p.codec) {
    case 'h264': {
      if (ex && isConfigRecord(ex) && ex.length >= 4) {
        return { codec: `avc1.${hex(ex[1])}${hex(ex[2])}${hex(ex[3])}`, ...coded, description: ex };
      }
      const sps = ex ? findNal(ex, (header) => (header & 0x1f) === 7) : null;
      if (sps && sps.length >= 4) {
        return { codec: `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`, ...coded };
      }
      const profile = p.profile > 0 ? p.profile : 100;
      const level = p.level > 0 ? p.level : 40;
      return { codec: `avc1.${hex(profile)}00${hex(level)}`, ...coded };
    }
    case 'hevc': {
      if (ex && isConfigRecord(ex) && ex.length >= 23) {
        return { codec: hevcCodecString(ex), ...coded, description: ex };
      }
      const profile = p.profile > 0 ? p.profile : 1;
      const level = p.level > 0 ? p.level : 93;
      return { codec: `hev1.${String(profile)}.6.L${String(level)}.B0`, ...coded };
    }
    case 'vp9': {
      const profile = Math.max(0, p.profile);
      const level = p.level > 0 ? p.level : vp9Level(p.width * p.height);
      const depth = profile >= 2 ? 10 : 8;
      return { codec: `vp09.${pad2(profile)}.${pad2(level)}.${pad2(depth)}`, ...coded };
    }
    case 'av1': {
      if (ex && ex.length >= 4 && ex[0] === 0x81) {
        const profile = (ex[1] ?? 0) >> 5;
        const level = (ex[1] ?? 0) & 0x1f;
        const flags = ex[2] ?? 0;
        const tier = flags & 0x80 ? 'H' : 'M';
        const high = (flags & 0x40) !== 0;
        const twelve = (flags & 0x20) !== 0;
        const depth = high ? (profile === 2 && twelve ? 12 : 10) : 8;
        return { codec: `av01.${String(profile)}.${pad2(level)}${tier}.${pad2(depth)}`, ...coded };
      }
      const profile = Math.max(0, p.profile);
      return { codec: `av01.${String(profile)}.08M.08`, ...coded };
    }
    case 'vp8':
      return { codec: 'vp8', ...coded };
    default:
      return null;
  }
}

/**
 * Annex B（沒有 avcC／hvcC）的 keyframe 不帶參數集（H.264 的 SPS、HEVC 的 VPS／SPS）時，在前面補上 extradata 的參數集：
 * 不帶 description 的 `VideoDecoder` 只能從 keyframe 取得參數集。其他情況原樣回傳同一個 `data`。
 */
export function withParameterSets(
  codec: string,
  data: Uint8Array,
  extradata: Uint8Array | null,
): Uint8Array {
  if (!extradata || isConfigRecord(extradata) || startCodeAt(extradata, 0) === 0) return data;
  const isParameterSet =
    codec === 'h264'
      ? (header: number) => (header & 0x1f) === 7
      : codec === 'hevc'
        ? (header: number) => ((header >> 1) & 0x3f) >= 32 && ((header >> 1) & 0x3f) <= 34
        : null;
  if (!isParameterSet || findNal(data, isParameterSet)) return data;
  const out = new Uint8Array(extradata.length + data.length);
  out.set(extradata, 0);
  out.set(data, extradata.length);
  return out;
}

/**
 * display matrix（`AV_PKT_DATA_DISPLAYMATRIX`，3×3 的 16.16／2.30 定點數）的順時針旋轉角度，取最接近的 90° 倍數。
 * 與 FFmpeg 的 `av_display_rotation_get()` 方向相反（它回傳逆時針的角度）。
 */
export function displayRotation(matrix: Int32Array | null): DisplaySize['rotation'] {
  if (!matrix || matrix.length < 9) return 0;
  const degrees = (Math.atan2(matrix[1] ?? 0, matrix[0] ?? 0) * 180) / Math.PI;
  const normalized = (((Math.round(degrees / 90) * 90) % 360) + 360) % 360;
  return normalized as DisplaySize['rotation'];
}

/** 套用 SAR（只拉寬或拉高，不縮小）與旋轉後的顯示尺寸；SAR 未知時視為 1:1。 */
export function displaySize(
  width: number,
  height: number,
  sar: readonly [number, number] | null,
  rotation: DisplaySize['rotation'],
): DisplaySize {
  const [num, den] = sar && sar[0] > 0 && sar[1] > 0 ? sar : [1, 1];
  const w = num > den ? Math.round((width * num) / den) : width;
  const h = num < den ? Math.round((height * den) / num) : height;
  return rotation === 90 || rotation === 270
    ? { width: h, height: w, rotation }
    : { width: w, height: h, rotation };
}

/** avcC／hvcC 等 ISO BMFF 的 decoder configuration record（第一個 byte 是 version 1）。 */
function isConfigRecord(data: Uint8Array): boolean {
  return data[0] === 1;
}

/** `offset` 起的 start code（`00 00 01` 或 `00 00 00 01`）長度；不是 start code 時為 0。 */
function startCodeAt(data: Uint8Array, offset: number): number {
  if (data[offset] !== 0 || data[offset + 1] !== 0) return 0;
  if (data[offset + 2] === 1) return 3;
  return data[offset + 2] === 0 && data[offset + 3] === 1 ? 4 : 0;
}

/** Annex B 資料中第一個 NAL header 符合 `match` 的 NAL（從 header byte 開始，到下一個 start code 之前）。 */
function findNal(data: Uint8Array, match: (header: number) => boolean): Uint8Array | null {
  for (let i = 0; i + 3 < data.length; i++) {
    const length = startCodeAt(data, i);
    if (length === 0) continue;
    const start = i + length;
    const header = data[start];
    if (header !== undefined && match(header)) {
      let end = start + 1;
      while (end + 2 < data.length && startCodeAt(data, end) === 0) end++;
      return data.subarray(start, end + 2 < data.length ? end : data.length);
    }
    i = start - 1;
  }
  return null;
}

/** `hvc1.<space><profile>.<compat 反轉>.<tier><level>.<constraint…>`（ISO/IEC 14496-15 附錄 E）。 */
function hevcCodecString(hvcC: Uint8Array): string {
  const b1 = hvcC[1] ?? 0;
  const space = ['', 'A', 'B', 'C'][b1 >> 6] ?? '';
  const tier = b1 & 0x20 ? 'H' : 'L';
  const profile = b1 & 0x1f;
  const compat =
    (((hvcC[2] ?? 0) << 24) | ((hvcC[3] ?? 0) << 16) | ((hvcC[4] ?? 0) << 8) | (hvcC[5] ?? 0)) >>>
    0;
  let reversed = 0;
  for (let i = 0; i < 32; i++) if (compat & (1 << i)) reversed |= 1 << (31 - i);
  const constraints = [...hvcC.subarray(6, 12)];
  while (constraints.length > 0 && constraints.at(-1) === 0) constraints.pop();
  const level = hvcC[12] ?? 0;
  return [
    `hvc1.${space}${String(profile)}`,
    (reversed >>> 0).toString(16).toUpperCase(),
    `${tier}${String(level)}`,
    ...constraints.map((c) => c.toString(16).toUpperCase()),
  ].join('.');
}

/** VP9 的 level（Annex A）：最大的 luma picture size 容得下這個畫面的最小 level。 */
function vp9Level(pictureSize: number): number {
  const levels: [number, number][] = [
    [10, 36_864],
    [11, 73_728],
    [20, 122_880],
    [21, 245_760],
    [30, 552_960],
    [31, 983_040],
    [40, 2_228_224],
    [50, 8_912_896],
    [60, 35_651_584],
  ];
  return levels.find(([, max]) => pictureSize <= max)?.[0] ?? 62;
}

function hex(value: number | undefined): string {
  return (value ?? 0).toString(16).padStart(2, '0');
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
