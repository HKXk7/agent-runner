import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { api } from '../routes/api.js';

export function buildApp(): Hono {
  const app = new Hono();

  app.route('/api', api);

  // 生产形态：直接托管 web 构建产物（npm run build:web && npm start 一条命令起全栈）
  app.use('/*', serveStatic({ root: '../web/dist' }));
  app.get('/*', serveStatic({ root: '../web/dist', path: 'index.html' })); // SPA fallback

  return app;
}

export function startHttpServer(app: Hono, port = Number(process.env.PORT ?? 8787)): void {
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[http] console + api listening on http://localhost:${info.port}`);
  });
}
