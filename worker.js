// Cloudflare Workers 用の入口: /api/* は中継、それ以外は public/ の静的ファイルを返す
import { handleApi } from './src/api.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request);
    return env.ASSETS.fetch(request);
  },
};
