// 初手シミュレーション: メインデッキからランダムに hand 枚引くことを trials 回くり返し、
// タグごとに「タグの付いたカードを何枚引いたか」を数える。DOM を使わないので Node でも試せる。

// main: [{ cid, count }]、tags: { cid: [タグ…] }
// 結果のタグごとの値:
//   dist[k]    タグの付いたカードをちょうど k 枚引いた回数
//   dup[k]     そのうち、同じカード（同名）を 2 枚以上引いていた回数
//   dupByCard  同名カードを 2 枚以上引いた回数（cid ごと）
export function simulateHands(main, tags, { trials = 10000, hand = 5, random = Math.random } = {}) {
  const pool = main.flatMap((e) => Array(e.count).fill(e.cid));
  const size = pool.length;
  const tagNames = [...new Set(main.flatMap((e) => tags[e.cid] || []))];
  const results = tagNames.map((tag) => {
    const cards = main.filter((e) => (tags[e.cid] || []).includes(tag));
    return {
      tag,
      cards,
      cids: new Set(cards.map((e) => e.cid)),
      copies: cards.reduce((n, e) => n + e.count, 0),
      dist: new Array(hand + 1).fill(0),
      dup: new Array(hand + 1).fill(0),
      dupByCard: {},
    };
  });
  if (size < hand) return { size, hand, trials: 0, results };

  // 毎回、先頭 hand 枚だけを並べ替える（フィッシャー–イェーツの途中まで）。前回の並びから続けても偏らない
  const deck = pool.slice();
  const drawn = new Map();
  for (let t = 0; t < trials; t++) {
    for (let i = 0; i < hand; i++) {
      const j = i + Math.floor(random() * (size - i));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    for (const r of results) {
      drawn.clear();
      let k = 0;
      for (let i = 0; i < hand; i++) {
        if (!r.cids.has(deck[i])) continue;
        k++;
        drawn.set(deck[i], (drawn.get(deck[i]) || 0) + 1);
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
  }
  return { size, hand, trials, results };
}
