#!/usr/bin/env python3
"""產生內嵌字幕軌的來源檔，由 gen-media.sh mux 進 MKV／MP4。

每整秒一個 0.5 秒的 cue，與 beep 同時出現（見 README.md）。2 秒的短檔另有 WebVTT、mov_text 用的 SRT 與
PGS（圖形字幕，.sup）的來源。

用法：gen-subs.py <輸出目錄> <秒數>
"""
import struct
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


SHORT = 2


def vtt(tag):
    return "WEBVTT\n\n" + "".join(f"{ts(n, '.')} --> {ts(n+0.5, '.')}\n[{tag}] {n}\n\n" for n in range(SHORT))


def pgs():
    """PGS（.sup）：每整秒顯示一個 8×2 的方塊，0.5 秒後清掉。每個 display set 是 PCS、WDS、(PDS、ODS)、END。"""

    def segment(pts, kind, body):
        return b"PG" + struct.pack(">IIBH", pts, 0, kind, len(body)) + body

    def display_set(sec, number, show):
        pts = round(sec * 90000)
        w, h = 8, 2
        objects = struct.pack(">HBBHH", 0, 0, 0, 10, 10) if show else b""
        pcs = struct.pack(">HHBHBBBB", 320, 180, 0x10, number, 0x80 if show else 0, 0, 0, int(show)) + objects
        out = segment(pts, 0x16, pcs) + segment(pts, 0x17, struct.pack(">BBHHHH", 1, 0, 10, 10, w, h))
        if show:
            out += segment(pts, 0x14, struct.pack(">BBBBBBB", 0, 0, 1, 235, 128, 128, 255))
            rle = (b"\x01" * w + b"\x00\x00") * h
            ods = struct.pack(">HBB", 0, 0, 0xC0) + (len(rle) + 4).to_bytes(3, "big") + struct.pack(">HH", w, h) + rle
            out += segment(pts, 0x15, ods)
        return out + segment(pts, 0x80, b"")

    return b"".join(display_set(n, 2 * n, True) + display_set(n + 0.5, 2 * n + 1, False) for n in range(SHORT))


(out / "short.vtt").write_text(vtt("embedded webvtt"), encoding="utf-8")
(out / "short-mov-text.srt").write_text(
    "".join(f"{n+1}\n{ts(n)} --> {ts(n+0.5)}\n[embedded mov_text] {n}\n\n" for n in range(SHORT)), encoding="utf-8"
)
(out / "short.sup").write_bytes(pgs())
