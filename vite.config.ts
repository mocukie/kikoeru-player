// Demo 頁的 dev server：HTTPS（自簽），手機以開發機的主機名稱連線（AudioWorklet 需要 secure context）；掛上 test/server。
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig, type Plugin } from 'vite';
import { testServer } from './test/server/index.ts';

/** `/` 導向 Demo 頁。 */
const demoIndex: Plugin = {
  name: 'kikoeru-demo-index',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url !== '/') {
        next();
        return;
      }
      res.statusCode = 302;
      res.setHeader('Location', '/demo/');
      res.end();
    });
  },
};

export default defineConfig({
  plugins: [basicSsl(), testServer(), demoIndex],
  server: { host: true },
});
