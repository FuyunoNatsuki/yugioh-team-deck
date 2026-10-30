// Cloudflare Workers 用の入口: /api/room/* はルーム（同時編集）、ほかの /api/* は中継、それ以外は public/ の静的ファイル
import { handleApi } from './src/api.js';

export { DeckRoom } from './src/room.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const room = url.pathname.match(/^\/api\/room\/([a-z0-9]{12})$/);
    if (room) {
      // このサイトのページからの接続だけ受け付ける
      if (request.headers.get('Origin') !== url.origin) return new Response('Forbidden', { status: 403 });
      return env.ROOMS.get(env.ROOMS.idFromName(room[1])).fetch(request);
    }
    if (url.pathname.startsWith('/api/')) return handleApi(request);
    return env.ASSETS.fetch(request);
  },
};
