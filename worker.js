// Cloudflare Workers 用の入口: /api/room/* はルーム（同時編集）、ほかの /api/* は中継、それ以外は public/ の静的ファイル
import { handleApi } from './src/api.js';

export { DeckRoom } from './src/room.js';

// 合言葉の比べ方で長さや中身が推測されないよう、ハッシュにしてから一定時間で比べる
async function sameSecret(given, expected) {
  const hash = async (s) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return crypto.subtle.timingSafeEqual(await hash(given), await hash(expected));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const room = url.pathname.match(/^\/api\/room\/([a-z0-9]{12})$/);
    if (room) {
      // このサイトのページからの接続だけ受け付ける
      if (request.headers.get('Origin') !== url.origin) return new Response('Forbidden', { status: 403 });
      return env.ROOMS.get(env.ROOMS.idFromName(room[1])).fetch(request);
    }
    // 管理者用: ルームを過去の時点に戻す。合言葉（ADMIN_TOKEN、wrangler secret で設定）が必要
    //   POST /api/room/<id>/restore  Authorization: Bearer <ADMIN_TOKEN>  body: { "time": "2026-11-07T19:05:00+09:00" }
    //   POST /api/room/<id>/writes  （同じ合言葉）body: { "from": …, "to": …, "stepSec": 60 }  書き込みがあった時刻を調べる（読み取りだけ）
    const admin = url.pathname.match(/^\/api\/room\/([a-z0-9]{12})\/(restore|writes)$/);
    if (admin) {
      const token = env.ADMIN_TOKEN;
      if (request.method !== 'POST' || !token || !(await sameSecret(request.headers.get('Authorization') || '', `Bearer ${token}`))) {
        return new Response('Forbidden', { status: 403 });
      }
      const body = await request.text();
      return env.ROOMS.get(env.ROOMS.idFromName(admin[1])).fetch(new Request(`https://room/${admin[2]}`, { method: 'POST', body }));
    }
    if (url.pathname.startsWith('/api/')) return handleApi(request);
    return env.ASSETS.fetch(request);
  },
};
