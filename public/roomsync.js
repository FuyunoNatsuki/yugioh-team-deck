// デッキの一覧と、採用する 3 デッキ（A・B・C の枠）の扱い。ブラウザとルームのサーバー（src/room.js）の両方で使う。
//
// データの形: { decks: [{ id, name, main, extra, side, tags, draws }, …], slots: [A の id, B の id, C の id] }
//
// 変更（op）は次のどれか。値をそのまま上書きする形なので、同じ op を何度適用しても結果は変わらない。
// d はデッキの id。
//   { d, create: デッキ }  デッキを一覧に足す
//   { d, remove: true }    デッキを一覧から消す（採用中のものと、残りが 3 つ以下になるものは消さない）
//   { slots: [id, id, id] } 採用する 3 デッキを決める
//   { d, s, cid, count }   デッキ d の枠 s のカード cid を count 枚にする
//   { d, name }            デッキ d の名前を name にする
//   { d, cid, tags }       デッキ d のカード cid のタグを tags にする（空なら外す）
//   { d, cid, draw }       デッキ d のカード cid のドロー枚数を draw にする（0 なら指定を外す）

export const ROOM_SECTIONS = ['main', 'extra', 'side'];
export const SLOT_COUNT = 3;
export const MAX_DECKS = 30;
export const MAX_TAGS = 8;
export const MAX_TAG_LENGTH = 20;
export const MAX_DRAW = 10;
const DECK_ID = /^[a-z0-9]{1,16}$/;
const CID = /^\d{1,8}$/;

export function newDeckId() {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  return [...crypto.getRandomValues(new Uint8Array(10))].map((b) => chars[b % chars.length]).join('');
}

export function opKey(op) {
  if ('slots' in op) return 'slots';
  if ('create' in op || 'remove' in op) return `${op.d}:deck`;
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

// デッキのドロー枚数（cid → 枚数）を整える
export function cleanDeckDraws(draws) {
  const out = {};
  if (!draws || typeof draws !== 'object') return out;
  for (const [cid, n] of Object.entries(draws).slice(0, 200)) {
    if (CID.test(cid) && Number.isInteger(n) && n > 0 && n <= MAX_DRAW) out[cid] = n;
  }
  return out;
}

// デッキのタグ（cid → タグ一覧）を整える
export function cleanDeckTags(tags) {
  const out = {};
  if (!tags || typeof tags !== 'object') return out;
  for (const [cid, list] of Object.entries(tags).slice(0, 200)) {
    const clean = cleanTags(list);
    if (CID.test(cid) && clean.length) out[cid] = clean;
  }
  return out;
}

// デッキ 1 つを整える（外から受け取ったものにも使う）
export function cleanDeck(d, id, fallbackName) {
  const deck = { id, name: typeof d?.name === 'string' && d.name ? d.name.slice(0, 40) : fallbackName };
  for (const s of ROOM_SECTIONS) {
    deck[s] = (Array.isArray(d?.[s]) ? d[s] : [])
      .filter((e) => CID.test(e?.cid) && Number.isInteger(e.count) && e.count > 0 && e.count <= 60)
      .slice(0, 100)
      .map((e) => ({ cid: e.cid, count: e.count }));
  }
  deck.tags = cleanDeckTags(d?.tags);
  deck.draws = cleanDeckDraws(d?.draws);
  return deck;
}

export const blankDeck = (id, name) => cleanDeck({}, id, name);

// { decks, slots } を整える。デッキの一覧と採用枠がなかった頃のデータ（3 デッキの配列）もここで移行する。
// makeId は id のないデッキに付ける id を作る（サーバーでは決まった値、ブラウザでは乱数）
export function normalizeDeckSet(decks, slots, makeId = (i) => `deck${i + 1}`) {
  const list = [];
  for (const [i, d] of (Array.isArray(decks) ? decks : []).slice(0, MAX_DECKS).entries()) {
    let id = typeof d?.id === 'string' && DECK_ID.test(d.id) ? d.id : makeId(i);
    while (list.some((x) => x.id === id)) id = makeId(i + list.length + 100);
    list.push(cleanDeck(d, id, `デッキ${list.length + 1}`));
  }
  while (list.length < SLOT_COUNT) list.push(blankDeck(makeId(list.length + 200), `デッキ${'ABC'[list.length]}`));
  const ids = list.map((d) => d.id);
  const valid = Array.isArray(slots) && slots.length === SLOT_COUNT && new Set(slots).size === SLOT_COUNT && slots.every((id) => ids.includes(id));
  return { decks: list, slots: valid ? [...slots] : ids.slice(0, SLOT_COUNT) };
}

const copyDeck = (deck) => JSON.parse(JSON.stringify(deck));

// 2 つの { decks, slots } の違いを op の一覧にする。
// 順番は「デッキの追加・変更 → 採用枠 → デッキの削除」（採用枠を外してから消すため）
export function diffDecks(prev, next) {
  const ops = [];
  const before = new Map(prev.decks.map((d) => [d.id, d]));
  const after = new Set(next.decks.map((d) => d.id));
  for (const deck of next.decks) {
    const d = deck.id;
    const old = before.get(d);
    if (!old) {
      ops.push({ d, create: copyDeck(deck) });
      continue;
    }
    if (old.name !== deck.name) ops.push({ d, name: deck.name });
    for (const s of ROOM_SECTIONS) {
      const was = new Map(old[s].map((e) => [e.cid, e.count]));
      const now = new Map(deck[s].map((e) => [e.cid, e.count]));
      for (const [cid, count] of now) if (was.get(cid) !== count) ops.push({ d, s, cid, count });
      for (const cid of was.keys()) if (!now.has(cid)) ops.push({ d, s, cid, count: 0 });
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
  }
  if (JSON.stringify(prev.slots) !== JSON.stringify(next.slots)) ops.push({ slots: [...next.slots] });
  for (const old of prev.decks) if (!after.has(old.id)) ops.push({ d: old.id, remove: true });
  return ops;
}

// op を { decks, slots } に当てる。当てられなかった op の数を返す（ほかの人の変更とぶつかったときなど）
export function applyOps(data, ops) {
  let rejected = 0;
  const find = (id) => data.decks.find((x) => x.id === id);
  for (const op of ops) {
    if ('slots' in op) {
      if (new Set(op.slots).size === SLOT_COUNT && op.slots.every((id) => find(id))) data.slots = [...op.slots];
      else rejected++;
      continue;
    }
    if ('create' in op) {
      if (find(op.d)) continue; // 同じ op をもう一度受け取っただけ
      if (data.decks.length >= MAX_DECKS) rejected++;
      else data.decks.push(cleanDeck(op.create, op.d, 'デッキ'));
      continue;
    }
    if ('remove' in op) {
      if (!find(op.d)) continue;
      if (data.slots.includes(op.d) || data.decks.length <= SLOT_COUNT) rejected++;
      else data.decks = data.decks.filter((x) => x.id !== op.d);
      continue;
    }
    const deck = find(op.d);
    if (!deck) {
      rejected++;
      continue;
    }
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
  return rejected;
}

// 受け取った op の一覧から、形の正しいものだけを残す
export function validOps(ops) {
  if (!Array.isArray(ops)) return [];
  return ops.slice(0, 1500).flatMap((op) => {
    if (!op || typeof op !== 'object') return [];
    if ('slots' in op) {
      return Array.isArray(op.slots) && op.slots.length === SLOT_COUNT && op.slots.every((id) => typeof id === 'string' && DECK_ID.test(id)) ? [{ slots: [...op.slots] }] : [];
    }
    if (typeof op.d !== 'string' || !DECK_ID.test(op.d)) return [];
    if ('create' in op) return op.create && typeof op.create === 'object' ? [{ d: op.d, create: cleanDeck(op.create, op.d, 'デッキ') }] : [];
    if ('remove' in op) return [{ d: op.d, remove: true }];
    if ('name' in op) return typeof op.name === 'string' ? [{ d: op.d, name: op.name.slice(0, 40) }] : [];
    if (!CID.test(op.cid)) return [];
    if ('tags' in op) return Array.isArray(op.tags) ? [{ d: op.d, cid: op.cid, tags: cleanTags(op.tags) }] : [];
    if ('draw' in op) return Number.isInteger(op.draw) && op.draw >= 0 && op.draw <= MAX_DRAW ? [{ d: op.d, cid: op.cid, draw: op.draw }] : [];
    if (!ROOM_SECTIONS.includes(op.s) || !Number.isInteger(op.count) || op.count < 0 || op.count > 60) return [];
    return [{ d: op.d, s: op.s, cid: op.cid, count: op.count }];
  });
}
