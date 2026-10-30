// 遊戯王ニューロン（公式カードデータベース）から HTML を取得して読み取る。
// Node 18+ と Cloudflare Workers の両方で動くよう、標準の fetch / Response だけを使う。

const BASE = 'https://www.db.yugioh-card.com/yugiohdb';
const UA = 'Mozilla/5.0 (compatible; team-deck-builder)';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// 同じリクエストの同時実行もまとめられるよう、Promise ごと短期間キャッシュする
const cache = new Map();
function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.promise;
  const promise = fn();
  promise.catch(() => cache.delete(key));
  cache.set(key, { promise, exp: Date.now() + ttlMs });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return promise;
}

async function getHtml(pathAndQuery) {
  return (await getPage(pathAndQuery)).html;
}

// cookie を付けて開き、返ってきた cookie も返す（同じセッションで続けて開くため）
async function getPage(pathAndQuery, cookie = '') {
  const res = await fetch(BASE + pathAndQuery, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ja', ...(cookie ? { Cookie: cookie } : {}) },
  });
  if (!res.ok) throw new HttpError(502, `カードデータベースの応答エラー (${res.status})`);
  const setCookies = res.headers.getSetCookie?.() || [];
  const received = setCookies.map((c) => c.split(';')[0]).filter(Boolean);
  return { html: await res.text(), cookie: [cookie, ...received].filter(Boolean).join('; ') };
}

// ---- HTML の読み取り ----

function decode(s) {
  return s
    .replace(/&lt;br&gt;/g, '\n')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&times;/g, '×')
    .replace(/&minus;/g, '−')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function stripTags(s) {
  return s.replace(/<!--[\s\S]*?-->/g, '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
}

// 1 行にまとめる
function clean(s) {
  return decode(stripTags(s)).replace(/\s+/g, ' ').trim();
}

// 改行を残す（カードテキスト用）
function cleanText(s) {
  return decode(stripTags(s).replace(/[\r\n\t]+/g, ' '))
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

function pick(chunk, re) {
  const m = chunk.match(re);
  return m ? m[1] : '';
}

// ページ内の画像 URL から cid → 画像パラメータを集める
function imageMap(html) {
  const map = {};
  for (const m of html.matchAll(/get_image\.action\?[^'"]*?cid=(\d+)&ciid=(\d+)&enc=([\w-]+)/g)) {
    if (!map[m[1]]) map[m[1]] = `cid=${m[1]}&ciid=${m[2]}&enc=${m[3]}`;
  }
  return map;
}

const EXTRA_TYPES = /融合|シンクロ|エクシーズ|リンク/;

// 検索結果・デッキ詳細の「t_row c_normal」1 枚分を読み取る
function parseRows(html) {
  const images = imageMap(html);
  const cards = [];
  const chunks = html.split(/<div class="t_row c_normal[^"]*">/).slice(1);
  for (let chunk of chunks) {
    chunk = chunk.split(/<!-- \.t_row/)[0];
    const cid = pick(chunk, /class="cid" value="(\d+)"/) || pick(chunk, /link_value" value="[^"]*cid=(\d+)/);
    if (!cid) continue;
    const attr = clean(pick(chunk, /class="box_card_attribute">[\s\S]*?<span>([\s\S]*?)<\/span>/));
    const species = clean(pick(chunk, /class="card_info_species_and_other_item">([\s\S]*?)<\/span>\s*<\/span>/)).replace(/\s/g, '');
    const kind = attr === '魔法' ? 'spell' : attr === '罠' ? 'trap' : 'monster';
    cards.push({
      cid,
      name: clean(pick(chunk, /<span class="card_name">([\s\S]*?)<\/span>/)) || clean(pick(chunk, /class="cnm" value='([^']*)'/)),
      ruby: clean(pick(chunk, /<span class="card_ruby">([\s\S]*?)<\/span>/)),
      kind,
      isExtra: kind === 'monster' && EXTRA_TYPES.test(species),
      attr,
      level:
        clean(pick(chunk, /class="box_card_level_rank[^"]*">[\s\S]*?<span>([\s\S]*?)<\/span>/)) ||
        clean(pick(chunk, /class="box_card_linkmarker[^"]*">[\s\S]*?<span>([\s\S]*?)<\/span>/)),
      species,
      effect: clean(pick(chunk, /class="box_card_effect">[\s\S]*?<span>([\s\S]*?)<\/span>/)),
      pscale: clean(pick(chunk, /class="box_card_pen_scale[^"]*">[\s\S]*?<span>([\s\S]*?)<\/span>/)),
      atk: clean(pick(chunk, /class="atk_power">\s*<span>([\s\S]*?)<\/span>/)),
      def: clean(pick(chunk, /class="def_power">\s*<span>([\s\S]*?)<\/span>/)),
      pendText: cleanText(pick(chunk, /class="box_card_pen_effect[^"]*">([\s\S]*?)<\/dd>/)),
      text: cleanText(pick(chunk, /class="box_card_text[^"]*">([\s\S]*?)<\/dd>/)),
      img: images[cid] || '',
    });
  }
  return cards;
}

// ---- 公開する機能 ----

const oneOf = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);

export function searchCards(params) {
  const q = new URLSearchParams({
    ope: '1',
    sess: '1',
    request_locale: 'ja',
    keyword: (params.get('keyword') || '').slice(0, 100),
    stype: oneOf(params.get('stype'), ['1', '2', '3', '4'], '1'),
    ctype: oneOf(params.get('ctype') || '', ['', '1', '2', '3'], ''),
    othercon: oneOf(params.get('othercon'), ['1', '2'], '2'),
    sort: oneOf(params.get('sort'), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '11', '12', '20', '21'], '1'),
    rp: oneOf(params.get('rp'), ['10', '50', '100'], '50'),
    page: String(Math.min(Math.max(parseInt(params.get('page'), 10) || 1, 1), 150)),
  });
  for (const key of ['attr', 'species', 'other', 'effe']) {
    for (const v of params.getAll(key)) if (/^\d{1,2}$/.test(v)) q.append(key, v);
  }
  const query = q.toString();
  return cached('search:' + query, 10 * 60 * 1000, async () => {
    const html = await getHtml('/card_search.action?' + query);
    const total = html.includes('該当データがありません') ? 0 : Number((html.match(/検索結果\s*([\d,]+)件/) || [, '0'])[1].replace(/,/g, ''));
    return { total, page: Number(q.get('page')), rp: Number(q.get('rp')), cards: parseRows(html) };
  });
}

// 禁止・制限・準制限カード。cards は cid → 採用できる上限枚数
export function fetchLimits() {
  return cached('limits', 6 * 60 * 60 * 1000, async () => {
    const html = await getHtml('/forbidden_limited.action?request_locale=ja');
    const sections = { list_forbidden: 0, list_limited: 1, list_semi_limited: 2 };
    const cards = {};
    const names = {};
    for (const [id, limit] of Object.entries(sections)) {
      const start = html.indexOf(`<div id="${id}"`);
      if (start < 0) continue;
      const end = html.indexOf('<div id="list_', start + 10);
      const section = html.slice(start, end < 0 ? undefined : end);
      for (const row of section.split('<div class="t_row').slice(1)) {
        const cid = pick(row, /card_search\.action\?ope=2&(?:amp;)?cid=(\d+)/);
        if (!cid) continue;
        cards[cid] = limit;
        names[cid] = clean(pick(row, /<span class="name">([\s\S]*?)<\/span>/));
      }
    }
    if (!Object.keys(cards).length) throw new HttpError(502, '禁止・制限リストを読み取れませんでした');
    const updated = (html.match(/(\d{4}\/\d{2}\/\d{2})\s*更新/) || [, ''])[1];
    return { updated, cards, names };
  });
}

// ニューロンのデッキコード（例: 1sgb47h）から読み込む。デッキコードがあれば、ログインしていなくても
// 非公開のデッキを見られる。デッキ検索の結果に出るリンク（deck_code 付き）を、同じセッションのまま開く
function fetchDeckByCode(code) {
  return cached('deckcode:' + code, 5 * 60 * 1000, async () => {
    const q = new URLSearchParams({ ope: '1', sess: '1', rp: '10', deck_code: code, request_locale: 'ja' });
    const search = await getPage('/deck_search.action?' + q);
    const href = search.html.match(/href="\/yugiohdb(\/member_deck\.action\?[^"]*deck_code=[^"]*)"/)?.[1];
    if (!href) throw new HttpError(404, `デッキコード「${code}」のデッキが見つかりません。コードが正しいか確認してください`);
    const page = await getPage(decode(href), search.cookie);
    return parseDeckPage(page.html, `デッキコード「${code}」のデッキを開けませんでした`);
  });
}

// デッキのページ（member_deck.action）から、枠ごとのカードと枚数を読み取る
function parseDeckPage(html, notFound) {
  const details = Object.fromEntries(parseRows(html).map((c) => [c.cid, c]));
  const tables = {
    monster_list: ['main', 'monster'],
    spell_list: ['main', 'spell'],
    trap_list: ['main', 'trap'],
    extra_list: ['extra', 'monster'],
    side_list: ['side', null],
  };
  const deck = { main: [], extra: [], side: [] };
  const cards = {};
  for (const [id, [section, kind]] of Object.entries(tables)) {
    const start = html.indexOf(`<table id="${id}"`);
    if (start < 0) continue;
    const table = html.slice(start, html.indexOf('</table>', start));
    for (const row of table.split(/<tr class='[^']*row'/).slice(1)) {
      const cid = pick(row, /cid=(\d+)/);
      const count = Number(pick(row, /<td class="num">\s*<span>(\d+)<\/span>/));
      if (!cid || !count) continue;
      deck[section].push({ cid, count });
      cards[cid] = details[cid] || {
        cid,
        name: clean(pick(row, /<span>([\s\S]*?)<\/span>/)),
        kind: kind || 'monster',
        isExtra: section === 'extra',
        img: imageMap(html)[cid] || '',
      };
    }
  }
  if (!deck.main.length && !deck.extra.length && !deck.side.length) throw new HttpError(404, notFound);
  const name = clean(pick(html, /<header id="broad_title">[\s\S]*?<h1>([\s\S]*?)<\/h1>/));
  return { name, ...deck, cards };
}

// ニューロンのデッキの URL（member_deck.action?cgid=...&dno=...）かデッキコードから読み込む
export function fetchDeck(input) {
  const text = String(input).trim();
  if (/^[0-9a-z]{4,20}$/i.test(text)) return fetchDeckByCode(text.toLowerCase());
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new HttpError(400, 'デッキの URL かデッキコードを入力してください');
  }
  const cgid = url.searchParams.get('cgid') || '';
  const dno = url.searchParams.get('dno') || '';
  if (!/(^|\.)db\.yugioh-card\.com$/.test(url.hostname) || !/^[0-9a-f]{32}$/.test(cgid) || !/^\d{1,6}$/.test(dno)) {
    throw new HttpError(400, '遊戯王ニューロンのデッキ URL（cgid と dno を含むもの）を入力してください');
  }
  // デッキコード付きの URL（デッキ検索の結果のリンクなど）なら、コードから開く（非公開でも見られる）
  const code = url.searchParams.get('deck_code') || '';
  if (/^[0-9a-z]{4,20}$/i.test(code)) return fetchDeckByCode(code.toLowerCase());
  return cached(`deck:${cgid}:${dno}`, 60 * 1000, async () => {
    const html = await getHtml(`/member_deck.action?ope=1&cgid=${cgid}&dno=${dno}&request_locale=ja`);
    return parseDeckPage(html, 'デッキが見つかりません。非公開のデッキは、デッキコードを入力するか、ブックマークレットで読み込んでください');
  });
}

// 公開デッキを新しい順に探して「cgid:dno」の一覧を返す
async function recentDecks(keyword, limit) {
  const q = new URLSearchParams({ ope: '1', sess: '1', rp: '50', keyword, request_locale: 'ja' });
  const html = await getHtml('/deck_search.action?' + q);
  return [...new Set([...html.matchAll(/cgid=([0-9a-f]{32})&(?:amp;)?dno=(\d+)/g)].map((m) => `${m[1]}:${m[2]}`))].slice(0, limit);
}

// 画像照合の候補になるカードを集める: キーワードで見つかる公開デッキと、テーマを問わない最近の公開デッキ
// （汎用カード用）に入っているカード、カード名にキーワードを含むカード。uses は何個のデッキで使われていたか
export function fetchPool(keyword) {
  keyword = String(keyword || '').trim().slice(0, 50);
  if (!keyword) throw new HttpError(400, 'デッキのテーマ（キーワード）を入力してください');
  return cached('pool:' + keyword, 60 * 60 * 1000, async () => {
    const [themed, recent] = await Promise.all([recentDecks(keyword, 12), cached('recent-decks', 60 * 60 * 1000, () => recentDecks('', 10))]);
    const decks = [...new Set([...themed, ...recent])];
    // デッキごとに選ばれているイラストが違うことがあるので、見つかったイラストはすべて残す（imgs）
    const pool = new Map();
    const add = (card) => {
      if (!card?.img) return;
      const hit = pool.get(card.cid);
      if (hit) {
        hit.uses++;
        if (!hit.imgs.includes(card.img)) hit.imgs.push(card.img);
      } else pool.set(card.cid, { ...card, uses: 1, imgs: [card.img] });
    };
    let next = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (next < decks.length) {
          const [cgid, dno] = decks[next++].split(':');
          try {
            const deck = await fetchDeck(`https://www.db.yugioh-card.com/yugiohdb/member_deck.action?cgid=${cgid}&dno=${dno}`);
            Object.values(deck.cards).forEach(add);
          } catch {}
        }
      })
    );
    const named = await searchCards(new URLSearchParams({ keyword, stype: '1', rp: '100' }));
    for (const c of named.cards) if (!pool.has(c.cid)) add({ ...c, uses: 0 });
    return { keyword, decks: themed.length, cards: [...pool.values()] };
  });
}

// カードのイラスト違いをすべて返す（画像のパラメータの一覧）
export function fetchArts(cid) {
  if (!/^\d+$/.test(String(cid))) throw new HttpError(400, 'bad cid');
  return cached('arts:' + cid, 24 * 60 * 60 * 1000, async () => {
    const html = await getHtml(`/card_search.action?ope=2&cid=${cid}&request_locale=ja`);
    const imgs = [...html.matchAll(/get_image\.action\?type=1&cid=(\d+)&ciid=(\d+)&enc=([\w-]+)/g)]
      .filter((m) => m[1] === String(cid))
      .map((m) => `cid=${m[1]}&ciid=${m[2]}&enc=${m[3]}`);
    return { cid: String(cid), imgs: [...new Set(imgs)] };
  });
}

const imageCache = new Map();

export async function fetchImage(params) {
  const cid = params.get('cid') || '';
  const ciid = params.get('ciid') || '1';
  const enc = params.get('enc') || '';
  if (!/^\d+$/.test(cid) || !/^\d+$/.test(ciid) || !/^[\w-]+$/.test(enc)) throw new HttpError(400, 'bad image params');
  const key = `${cid}:${ciid}:${enc}`;
  let body = imageCache.get(key);
  if (!body) {
    const res = await fetch(`${BASE}/get_image.action?type=1&lang=ja&cid=${cid}&ciid=${ciid}&enc=${enc}`, {
      headers: { 'User-Agent': UA, Referer: BASE + '/' },
    });
    if (!res.ok) throw new HttpError(502, `image ${res.status}`);
    body = new Uint8Array(await res.arrayBuffer());
    imageCache.set(key, body);
    if (imageCache.size > 600) imageCache.delete(imageCache.keys().next().value);
  }
  const type = body[0] === 0x89 ? 'image/png' : body[0] === 0xff ? 'image/jpeg' : 'application/octet-stream';
  return new Response(body, { headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=604800' } });
}
