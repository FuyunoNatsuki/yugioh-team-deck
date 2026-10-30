// 初手シミュレーション: メインデッキからランダムに hand 枚引くことを trials 回くり返し、
// タグの付いたカードを何枚引いたか、タグ同士の組み合わせがそろったかを数える。DOM を使わないので Node でも試せる。

export const START_TAG = '初動';
export const COMBO_TAG = '組み合わせ初動'; // 2 枚そろうと初動になるカード

// main: [{ cid, count }]、tags: { cid: [タグ…] }
// options:
//   order          この順にタグを並べる（デッキで使っていないタグは除く）。残りは使われた順
//   comboSameName  組み合わせ初動を同名の 2 枚でも成立とするか（既定は別名の 2 枚が必要）
//
// 結果:
//   results[]  タグごと
//     dist[k]    タグの付いたカードをちょうど k 枚引いた回数
//     dup[k]     そのうち、同じカード（同名）を 2 枚以上引いていた回数
//     dupByCard  同名カードを 2 枚以上引いた回数（cid ごと）
//   pairs[]    タグ 2 つの組み合わせごとに、両方を別々のカードでそろえた回数（1 枚で両方は数えない）
//   start      「初動」か「組み合わせ初動」を使っているときだけ
//     count         初動で動けた回数（初動 1 枚以上、または組み合わせ初動 2 枚）
//     bySingle      初動 1 枚以上で動けた回数
//     byComboOnly   初動がなく、組み合わせ初動 2 枚で動けた回数
//     sameNameOnly  組み合わせ初動が同名の 2 枚以上しかなく、別名ではそろわなかった回数
//     withTag[]     動けたうえで、そのカードとは別にタグ X のカードを持っていた回数（初動系以外のタグごと）
export function simulateHands(main, tags, { trials = 10000, hand = 5, random = Math.random, order = [], comboSameName = false } = {}) {
  const pool = main.flatMap((e) => Array(e.count).fill(e.cid));
  const size = pool.length;
  const used = [...new Set(main.flatMap((e) => tags[e.cid] || []))];
  const tagNames = [...order.filter((t) => used.includes(t)), ...used.filter((t) => !order.includes(t))];
  const has = new Map(main.map((e) => [e.cid, new Set(tags[e.cid] || [])]));
  const results = tagNames.map((tag) => {
    const cards = main.filter((e) => has.get(e.cid).has(tag));
    return {
      tag,
      cards,
      copies: cards.reduce((n, e) => n + e.count, 0),
      dist: new Array(hand + 1).fill(0),
      dup: new Array(hand + 1).fill(0),
      dupByCard: {},
    };
  });
  const pairs = [];
  for (let a = 0; a < tagNames.length; a++) for (let b = a + 1; b < tagNames.length; b++) pairs.push({ a: tagNames[a], b: tagNames[b], count: 0 });
  const useStart = tagNames.includes(START_TAG) || tagNames.includes(COMBO_TAG);
  const others = tagNames.filter((t) => t !== START_TAG && t !== COMBO_TAG);
  const start = useStart ? { count: 0, bySingle: 0, byComboOnly: 0, sameNameOnly: 0, withTag: others.map((tag) => ({ tag, count: 0 })), comboSameName } : null;
  if (size < hand) return { size, hand, trials: 0, results, pairs, start };

  // 毎回、先頭 hand 枚だけを並べ替える（フィッシャー–イェーツの途中まで）。前回の並びから続けても偏らない
  const deck = pool.slice();
  const drawn = new Map();
  const h = new Array(hand);
  for (let t = 0; t < trials; t++) {
    for (let i = 0; i < hand; i++) {
      const j = i + Math.floor(random() * (size - i));
      [deck[i], deck[j]] = [deck[j], deck[i]];
      h[i] = deck[i];
    }

    for (const r of results) {
      drawn.clear();
      let k = 0;
      for (const cid of h) {
        if (!has.get(cid).has(r.tag)) continue;
        k++;
        drawn.set(cid, (drawn.get(cid) || 0) + 1);
      }
      r.dist[k]++;
      let dup = false;
      for (const [cid, n] of drawn) {
        if (n < 2) continue;
        dup = true;
        r.dupByCard[cid] = (r.dupByCard[cid] || 0) + 1;
      }
      if (dup) r.dup[k]++;
    }

    for (const p of pairs) {
      let ok = false;
      for (let i = 0; i < hand && !ok; i++) {
        if (!has.get(h[i]).has(p.a)) continue;
        for (let j = 0; j < hand; j++) {
          if (j !== i && has.get(h[j]).has(p.b)) {
            ok = true;
            break;
          }
        }
      }
      if (ok) p.count++;
    }

    if (start) {
      // 動き出しに使うカードの組（初動 1 枚、または組み合わせ初動 2 枚）を全部挙げる
      const units = [];
      let anyComboPair = false;
      let diffComboPair = false;
      for (let i = 0; i < hand; i++) if (has.get(h[i]).has(START_TAG)) units.push([i]);
      const singles = units.length;
      for (let i = 0; i < hand; i++) {
        if (!has.get(h[i]).has(COMBO_TAG)) continue;
        for (let j = i + 1; j < hand; j++) {
          if (!has.get(h[j]).has(COMBO_TAG)) continue;
          anyComboPair = true;
          if (h[i] !== h[j]) diffComboPair = true;
          if (comboSameName || h[i] !== h[j]) units.push([i, j]);
        }
      }
      if (units.length) {
        start.count++;
        if (singles) start.bySingle++;
        else start.byComboOnly++;
        for (const w of start.withTag) {
          if (units.some((u) => h.some((cid, k) => !u.includes(k) && has.get(cid).has(w.tag)))) w.count++;
        }
      }
      if (!singles && anyComboPair && !diffComboPair) start.sameNameOnly++;
    }
  }
  return { size, hand, trials, results, pairs, start };
}
