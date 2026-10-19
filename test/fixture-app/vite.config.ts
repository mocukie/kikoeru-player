// fixture App 的 Vite 設定：除了 /media/* 的測試媒體之外，與 README「Vite 設定」寫給 App 的設定相同。
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { serveMedia } from '../server/index.ts';

const mediaRoot = fileURLToPath(new URL('../media/out', import.meta.url));

/** `vite preview` 提供 CI 組的測試媒體（支援 Range）。 */
const testMedia: Plugin = {
  name: 'kikoeru-fixture-media',
  configurePreviewServer(server) {
    server.middlewares.use('/media', serveMedia(mediaRoot));
  },
};

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [testMedia],
  optimizeDeps: { exclude: ['kikoeru-player'] },
});
