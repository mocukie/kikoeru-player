# browser mode 與 E2E 的執行環境（docs/testing.md「瀏覽器」）：Playwright 官方 image 加上 Firefox 需要的 PulseAudio。
# tag 必須與 package.json 的 playwright 版本相同，run.sh 會檢查。
FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:7852dc5a7d72f5fe458a597d690f6c42fbc8e9e26ddfa95f8e6ef552558d9bbf

ARG PNPM_VERSION

# 關掉 autospawn：Chromium 不能自己把 PulseAudio 叫起來（見 test/browser-launch.ts）。
RUN apt-get update \
  && apt-get install -y --no-install-recommends pulseaudio \
  && rm -rf /var/lib/apt/lists/* \
  && echo 'autospawn = no' > /etc/pulse/client.conf.d/99-no-autospawn.conf \
  && npm install -g "pnpm@${PNPM_VERSION}"
