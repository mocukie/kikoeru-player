# browser mode 與 E2E 的執行環境（docs/testing.md「瀏覽器」）：Playwright 官方 image 加上 Firefox 需要的 PulseAudio。
# tag 必須與 package.json 的 playwright 版本相同，run.sh 會檢查。
FROM mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f

ARG PNPM_VERSION

# 關掉 autospawn：Chromium 不能自己把 PulseAudio 叫起來（見 test/browser-launch.ts）。
RUN apt-get update \
  && apt-get install -y --no-install-recommends pulseaudio \
  && rm -rf /var/lib/apt/lists/* \
  && echo 'autospawn = no' > /etc/pulse/client.conf.d/99-no-autospawn.conf \
  && npm install -g "pnpm@${PNPM_VERSION}"
