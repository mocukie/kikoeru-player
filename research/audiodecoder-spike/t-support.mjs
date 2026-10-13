// 拋棄式 spike（#18）：AudioDecoder.isConfigSupported 的實際回報，以及拿真實檔案 configure + decode 驗證（誤報／漏報）。
import { createLibAV } from "./lib.mjs";
import { openAudio, readAllPackets, adDecode, adConfig, wasmDecode, supported } from "./audio.mjs";

const CODECS = ["mp4a.40.2", "mp4a.40.5", "mp4a.40.29", "mp4a.40.42", "mp4a.67", "mp4a.69", "mp4a.6B", "mp3", "opus", "vorbis", "flac",
  "ac-3", "ec-3", "mp4a.a5", "mp4a.a6", "alac", "wavpack", "dtsc", "pcm-u8", "pcm-s16", "pcm-s24", "pcm-s32", "pcm-f32", "ulaw", "alaw"];
const RATES = [8000, 22050, 44100, 48000, 96000, 192000, 384000];
const CHS = [1, 2, 6, 8];
const FILES = ["acc-aac.m4a", "acc-aac.aac", "acc-mp3.mp3", "acc-opus.opus", "acc-opus.webm", "acc-flac.flac", "acc-vorbis.ogg", "acc-vorbis.webm",
  "cs-aac-6ch.m4a", "cs-aac-96k.m4a", "cs-opus-6ch.opus", "cs-flac-6ch.flac", "cs-flac-192k24.flac", "cs-flac-384k24.flac", "cs-vorbis-6ch.ogg",
  "cs-mp3-22k-mono.mp3", "cs-mp3-8k-mono.mp3", "cs-ac3-6ch.ac3", "cs-eac3-6ch.eac3", "cs-alac.m4a", "cs-pcm-s24-96k.wav", "cs-pcm-f32.wav", "cpu-pcm192.wav"];

export async function run({ files = FILES } = {}, progress) {
  const out = { hasAudioDecoder: typeof AudioDecoder !== "undefined", matrix: {}, files: {} };
  if (!out.hasAudioDecoder) return out;
  // 1. 矩陣：codec × 取樣率 × 聲道數（不帶 description）
  for (const codec of CODECS) {
    const yes = [], no = [], thrown = new Set();
    for (const sampleRate of RATES) for (const numberOfChannels of CHS) {
      const v = await supported({ codec, sampleRate, numberOfChannels }, 3000);
      if (v === true) yes.push(`${sampleRate / 1000}k/${numberOfChannels}`); else if (v === false) no.push(1); else thrown.add(v);
    }
    out.matrix[codec] = { yes: yes.length === RATES.length * CHS.length ? "all" : yes, noCount: no.length, thrown: [...thrown] };
  }
  // 2. 真實檔案：用 Engine 會給的 config 問 isConfigSupported，再實際 configure + decode
  const lib = await createLibAV();
  for (const f of files) {
    progress?.(f);
    const r = out.files[f] = {};
    try {
      const o = await openAudio(lib, `/media/${f}`);
      const { info } = o;
      let pk = await readAllPackets(lib, o.fmt, info.index);
      if (f.startsWith("cpu-")) pk = pk.slice(0, 200);
      const cfg = adConfig(info);
      r.config = { codec: cfg.codec, sampleRate: cfg.sampleRate, numberOfChannels: cfg.numberOfChannels, description: cfg.description?.length ?? null };
      r.supported = await supported(cfg);
      const ref = await wasmDecode(lib, info, o.stream.codecpar, pk).catch(() => null);
      const a = await adDecode(info, pk, { config: cfg });
      r.decode = { error: a.error, outputs: a.meta.length, samples: a.planes?.[0]?.length ?? 0, wasmSamples: ref?.[0]?.length ?? null,
        outSr: a.meta[0]?.sr, outCh: a.meta[0]?.ch, format: a.format };
      // 判定：supported 與實際能否解出聲音不一致 → 誤報／漏報
      const works = !a.error && r.decode.samples > 0 && r.decode.outSr === info.sample_rate && r.decode.outCh === info.channels;
      r.verdict = r.supported === true ? (works ? "ok" : "false-positive") : (works ? "false-negative" : "unsupported");
      await lib.avformat_close_input_js(o.fmt);
      await lib.unlink(o.name);
    } catch (e) { r.error = String(e?.stack ?? e).slice(0, 500); }
  }
  return out;
}
