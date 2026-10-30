import { HttpError, fetchArts, fetchDeck, fetchImage, fetchLimits, fetchPool, searchCards } from './konami.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// 1 人が短時間に大量に使っても、コナミのサーバーへの負担が増えすぎないよう、IP ごとに回数を抑える。
// 実行インスタンスごとに数える簡単なもの。「画像から登録」1 回（候補の画像の読み込み）で 700 回ほど使う
const LIMIT_WINDOW_MS = 10 * 60 * 1000;
const LIMIT_REQUESTS = 3000;
const recentRequests = new Map(); // IP → { count, reset }

function overLimit(ip) {
  const now = Date.now();
  let entry = recentRequests.get(ip);
  if (!entry || entry.reset < now) {
    entry = { count: 0, reset: now + LIMIT_WINDOW_MS };
    recentRequests.set(ip, entry);
    if (recentRequests.size > 5000) {
      for (const [key, e] of recentRequests) if (e.reset < now) recentRequests.delete(key);
    }
  }
  return ++entry.count > LIMIT_REQUESTS;
}

// /api/* へのリクエストを処理する（Node サーバーと Cloudflare Worker で共通）
export async function handleApi(request) {
  const url = new URL(request.url);
  if (overLimit(request.headers.get('CF-Connecting-IP') || 'local')) {
    return json({ error: '短時間に使いすぎています。しばらく待ってからもう一度試してください' }, 429);
  }
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
