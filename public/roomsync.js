// ルームの同時編集で使う変更の形。ブラウザとルームのサーバー（src/room.js）の両方で使う。
// 変更（op）は次のどれか。値をそのまま上書きする形なので、同じ op を何度適用しても結果は変わらない。
//   { d, s, cid, count }  デッキ d の枠 s のカード cid を count 枚にする
//   { d, name }           デッキ d の名前を name にする
//   { d, cid, tags }      デッキ d のカード cid のタグを tags にする（空なら外す）
//   { d, cid, draw }      デッキ d のカード cid のドロー枚数を draw にする（0 なら指定を外す）

export const ROOM_SECTIONS = ['main', 'extra', 'side'];
export const MAX_TAGS = 8;
export const MAX_TAG_LENGTH = 20;
export const MAX_DRAW = 10;

export function opKey(op) {
  if ('name' in op) return `${op.d}:name`;
  if ('tags' in op) return `${op.d}:tags:${op.cid}`;
  if ('draw' in op) return `${op.d}:draw:${op.cid}`;
  return `${op.d}:${op.s}:${op.cid}`;
}

// タグの一覧を整える（前後の空白を取り、空・重複を除き、長さと数をそろえる）
export function cleanTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  for (const t of tags) {
    const tag = typeof t === 'string' ? t.trim().slice(0, MAX_TAG_LENGTH) : '';
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out.slice(0, MAX_TAGS);
}

// 2 つのデッキ一覧の違いを op の一覧にする
export function diffDecks(prev, next) {
  const ops = [];
  next.forEach((deck, d) => {
    const old = prev[d];
    if (!old) return;
    if (old.name !== deck.name) ops.push({ d, name: deck.name });
    for (const s of ROOM_SECTIONS) {
      const before = new Map(old[s].map((e) => [e.cid, e.count]));
      const after = new Map(deck[s].map((e) => [e.cid, e.count]));
      for (const [cid, count] of after) if (before.get(cid) !== count) ops.push({ d, s, cid, count });
      for (const cid of before.keys()) if (!after.has(cid)) ops.push({ d, s, cid, count: 0 });
    }
    const oldTags = old.tags || {};
    const newTags = deck.tags || {};
    for (const cid of new Set([...Object.keys(oldTags), ...Object.keys(newTags)])) {
      const tags = newTags[cid] || [];
      if (JSON.stringify(oldTags[cid] || []) !== JSON.stringify(tags)) ops.push({ d, cid, tags });
    }
    const oldDraws = old.draws || {};
    const newDraws = deck.draws || {};
    for (const cid of new Set([...Object.keys(oldDraws), ...Object.keys(newDraws)])) {
      if ((oldDraws[cid] || 0) !== (newDraws[cid] || 0)) ops.push({ d, cid, draw: newDraws[cid] || 0 });
    }
  });
  return ops;
}

export function applyOps(decks, ops) {
  for (const op of ops) {
    const deck = decks[op.d];
    if (!deck) continue;
    if ('name' in op) {
      deck.name = op.name;
      continue;
    }
    if ('tags' in op) {
      deck.tags ||= {};
      if (op.tags.length) deck.tags[op.cid] = [...op.tags];
      else delete deck.tags[op.cid];
      continue;
    }
    if ('draw' in op) {
      deck.draws ||= {};
      if (op.draw > 0) deck.draws[op.cid] = op.draw;
      else delete deck.draws[op.cid];
      continue;
    }
    const list = deck[op.s];
    const e = list.find((x) => x.cid === op.cid);
    if (op.count <= 0) {
      if (e) list.splice(list.indexOf(e), 1);
    } else if (e) e.count = op.count;
    else list.push({ cid: op.cid, count: op.count });
  }
}

// 受け取った op の一覧から、形の正しいものだけを残す
export function validOps(ops) {
  if (!Array.isArray(ops)) return [];
  return ops.slice(0, 500).flatMap((op) => {
    if (!op || !Number.isInteger(op.d) || op.d < 0 || op.d > 2) return [];
    if ('name' in op) return typeof op.name === 'string' ? [{ d: op.d, name: op.name.slice(0, 40) }] : [];
    if (!/^\d{1,8}$/.test(op.cid)) return [];
    if ('tags' in op) return Array.isArray(op.tags) ? [{ d: op.d, cid: op.cid, tags: cleanTags(op.tags) }] : [];
    if ('draw' in op) return Number.isInteger(op.draw) && op.draw >= 0 && op.draw <= MAX_DRAW ? [{ d: op.d, cid: op.cid, draw: op.draw }] : [];
    if (!ROOM_SECTIONS.includes(op.s) || !Number.isInteger(op.count) || op.count < 0 || op.count > 60) return [];
    return [{ d: op.d, s: op.s, cid: op.cid, count: op.count }];
  });
}

// デッキのドロー枚数（cid → 枚数）を整える
export function cleanDeckDraws(draws) {
  const out = {};
  if (!draws || typeof draws !== 'object') return out;
  for (const [cid, n] of Object.entries(draws).slice(0, 200)) {
    if (/^\d{1,8}$/.test(cid) && Number.isInteger(n) && n > 0 && n <= MAX_DRAW) out[cid] = n;
  }
  return out;
}

// デッキのタグ（cid → タグ一覧）を整える。保存データやルームの最初の内容を受け取るときに使う
export function cleanDeckTags(tags) {
  const out = {};
  if (!tags || typeof tags !== 'object') return out;
  for (const [cid, list] of Object.entries(tags).slice(0, 200)) {
    const clean = cleanTags(list);
    if (/^\d{1,8}$/.test(cid) && clean.length) out[cid] = clean;
  }
  return out;
}
