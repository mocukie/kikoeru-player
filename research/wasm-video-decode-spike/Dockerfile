# 拋棄式 spike（#20）：libav.js（含 dav1d）的 build 環境。沿用 #10 的 build-spike，emsdk 以 digest 釘死。
# 多裝 meson、ninja：dav1d 用 meson build（上游 CI 在 c05a676 也加了 `apt install meson`）。
# nasm：只給原生 dav1d（對照組，x86 asm）用。
FROM emscripten/emsdk:6.0.5@sha256:76a44fff907397784decc435115d07fcb9587a4f1504977f39f3745e538e3a1e

RUN apt-get update \
 && apt-get install -y --no-install-recommends pkg-config m4 meson ninja-build nasm \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /work/libav.js
