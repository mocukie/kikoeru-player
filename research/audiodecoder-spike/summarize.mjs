// 拋棄式 spike（#18）：把 run.mjs 的 JSON 印成 Markdown 表格。用法：node summarize.mjs <results.json> [test]
import { readFileSync } from "node:fs";
const [file, only] = process.argv.slice(2);
const R = JSON.parse(readFileSync(file, "utf8"));
const row = (a) => console.log(`| ${a.join(" | ")} |`);
const hdr = (a) => { row(a); row(a.map(() => "---")); };

for (const [key, byB] of Object.entries(R)) {
  const test = key.split(" ")[0];
  if (only && test !== only) continue;
  console.log(`\n### ${key}\n`);
  for (const [b, r] of Object.entries(byB)) {
    console.log(`\n**${b} ${r.version}**${r.ok ? "" : " FAIL " + r.error}\n`);
    if (!r.ok) continue;
    const res = r.result;
    if (test === "accuracy") {
      hdr(["檔案", "codec", "skip side data（pkt:start/end）", "initial_padding／trailing／seek_preroll", "FFmpeg lag／長度差", "AD 變體", "supported", "AD lag", "AD 長度差", "尾端多出", "第一個 ts（µs）／首封包", "ts 最大間隙 µs", "vs FFmpeg 未裁切 max（全段／內部）", "vs truth SNR dB", "錯誤"]);
      for (const [f, x] of Object.entries(res)) {
        if (x.error) { row([f, "", "", "", "", "", "", "", "", "", "", "", "", "", x.error.slice(0, 120)]); continue; }
        const i = x.info;
        for (const v of ["ad", "adNoDesc", "adShift"]) {
          const a = x[v]; if (!a) continue;
          row([f, i.codec, i.skips.map((s) => `${s.pkt}:${s.start}/${s.end}`).join(" ") || "-",
            `${i.initial_padding}／${i.trailing_padding}／${i.seek_preroll}`, `${x.ffmpeg.lag}／${x.ffmpeg.lenDiff}（raw lag ${x.ffmpeg.rawLag}）`, v, a.supported,
            a.lag ?? "", a.lenDiff ?? "", a.tailExtra ?? "", a.firstTs != null ? `${a.firstTs}／${i.firstPktUs}` : "", a.maxTsGapUs ?? "",
            a.vsFFmpegRaw ? `${a.vsFFmpegRaw.max}／${a.vsFFmpegRawInterior.max}` : "", a.vsTruth?.snrDb ?? "", a.error ?? ""]);
        }
      }
    } else {
      console.log("```json\n" + JSON.stringify(res, null, 1).slice(0, 20000) + "\n```");
    }
  }
}
