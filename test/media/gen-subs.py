#!/usr/bin/env python3
"""產生內嵌字幕軌的來源檔，由 gen-media.sh mux 進 MKV。

每整秒一個 0.5 秒的 cue，與 beep 同時出現（見 README.md）。

用法：gen-subs.py <輸出目錄> <秒數>
"""
import sys
from pathlib import Path

out, dur = Path(sys.argv[1]), int(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)

JA = lambda n: f"{n}秒目、ビープ音が鳴りました。"
HANT = lambda n: f"第{n}秒，聽到嗶聲了。"


def ts(sec, sep=","):
    ms = round(sec * 1000)
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02}:{m:02}:{s:02}{sep}{ms:03}"


def srt(text, tag):
    return "".join(f"{n+1}\n{ts(n)} --> {ts(n+0.5)}\n[{tag}] {text(n)}\n\n" for n in range(dur))


def ass(text, tag):
    # 用 libass／FFmpeg 預期的完整 V4+ Format；精簡欄位的 Format 包進 MKV 後，
    # 照 Matroska 規格的固定欄位切 packet 會切不到文字。
    head = (
        "[Script Info]\nScriptType: v4.00+\nPlayResX: 640\nPlayResY: 360\n\n"
        "[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding\n"
        "Style: Default,sans-serif,28,&H0000FF00,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,0,8,10,10,20,1\n\n"
        "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )
    ass_ts = lambda s: ts(s, ".")[1:-1]  # H:MM:SS.cc
    return head + "".join(
        f"Dialogue: 0,{ass_ts(n)},{ass_ts(n+0.5)},Default,,0,0,0,,{{\\fad(50,50)}}[{tag}] {text(n)}\n" for n in range(dur)
    )


(out / "embedded-ja.srt").write_text(srt(JA, "embedded srt"), encoding="utf-8")
(out / "embedded-zh.ass").write_text(ass(HANT, "embedded ass"), encoding="utf-8")
