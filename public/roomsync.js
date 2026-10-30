// ルームの同時編集で使う変更の形。ブラウザとルームのサーバー（src/room.js）の両方で使う。
// 変更（op）は「デッキ d の枠 s のカード cid を count 枚にする」か「デッキ d の名前を name にする」。
// 値をそのまま上書きする形なので、同じ op を何度適用しても結果は変わらない。

export const ROOM_SECTIONS = ['main', 'extra', 'side'];

export const opKey = (op) => ('name' in op ? `${op.d}:name` : `${op.d}:${op.s}:${op.cid}`);

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
    if (!ROOM_SECTIONS.includes(op.s) || !/^\d{1,8}$/.test(op.cid) || !Number.isInteger(op.count) || op.count < 0 || op.count > 60) return [];
    return [{ d: op.d, s: op.s, cid: op.cid, count: op.count }];
  });
}
