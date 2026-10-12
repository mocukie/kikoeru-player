# 拋棄式 spike（#10）：libav.js 自訂 variant 的 build 環境。
# emsdk 版本對齊 libav.js v6.10.9.0 上游 CI（.github/workflows/build-and-test.yaml 的 setup-emsdk version: 6.0.5），
# 並以 digest 釘死，避免 tag 被重推。
FROM emscripten/emsdk:6.0.5@sha256:76a44fff907397784decc435115d07fcb9587a4f1504977f39f3745e538e3a1e

# pkg-config：FFmpeg configure 找外部 lib 用；m4：Makefile.m4 比 Makefile 新時 make 會重生 Makefile。
RUN apt-get update \
 && apt-get install -y --no-install-recommends pkg-config m4 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /work/libav.js
