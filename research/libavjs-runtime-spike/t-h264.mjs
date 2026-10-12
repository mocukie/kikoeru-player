// 拋棄式 spike（#17）：H.264 以 Annex B 送進 VideoDecoder、不帶 description，能不能解；對照 AVCC＋avcC description。
// 在 Worker 內跑（Engine 的 VideoDecoder 在 media Worker）；m-h264 在主執行緒跑同一份。
import { accessUnits, decodeAll } from "./h264.mjs";

export async function run({ files = ["v1280x720.h264", "v1920x1080.h264"] } = {}) {
  const out = { where: typeof window === "undefined" ? "worker" : "main", hasVideoDecoder: typeof VideoDecoder !== "undefined" };
  if (!out.hasVideoDecoder) return out;
  for (const f of files) {
    const [width, height] = f.match(/(\d+)x(\d+)/).slice(1).map(Number);
    const s = accessUnits(new Uint8Array(await (await fetch(`/media/${f}`)).arrayBuffer()));
    out[f] = { codec: s.codec, annexb: await decodeAll(s, "annexb", { width, height }), avcc: await decodeAll(s, "avcc", { width, height }) };
    // seek 情境：從第二個 IDR 開始解；另外把 in-band 的 SPS／PPS 拿掉，看 Annex B 沒有 description 時是否就解不了
    const k2 = s.aus.findIndex((a, i) => i > 0 && a.key);
    const mid = { ...s, aus: s.aus.slice(k2) };
    out[f].keyframesWithSps = s.aus.filter((a) => a.key && a.hasSps).length + "/" + s.aus.filter((a) => a.key).length;
    out[f].annexbFromMidIdr = await decodeAll(mid, "annexb", { width, height });
    out[f].avccFromMidIdr = await decodeAll(mid, "avcc", { width, height });
    out[f].annexbNoParamSetsFromMidIdr = await decodeAll(mid, "annexb-nops", { width, height });
  }
  return out;
}
