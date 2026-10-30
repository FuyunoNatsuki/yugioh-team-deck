import { HttpError, fetchArts, fetchDeck, fetchImage, fetchLimits, fetchPool, searchCards } from './konami.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// /api/* へのリクエストを処理する（Node サーバーと Cloudflare Worker で共通）
export async function handleApi(request) {
  const url = new URL(request.url);
  try {
    switch (url.pathname) {
      case '/api/search':
        return json(await searchCards(url.searchParams));
      case '/api/limits':
        return json(await fetchLimits());
      case '/api/deck':
        return json(await fetchDeck(url.searchParams.get('url') || ''));
      case '/api/pool':
        return json(await fetchPool(url.searchParams.get('keyword')));
      case '/api/arts':
        return json(await fetchArts(url.searchParams.get('cid')));
      case '/api/img':
        return await fetchImage(url.searchParams);
      default:
        if (url.pathname.startsWith('/api/room/')) return json({ error: 'ルーム機能は Cloudflare Workers 版でのみ使えます' }, 501);
        return json({ error: 'not found' }, 404);
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 502;
    return json({ error: e instanceof HttpError ? e.message : 'カードデータベースに接続できませんでした' }, status);
  }
}
