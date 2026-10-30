// 初手シミュレーション: メインデッキからランダムに hand 枚引くことを trials 回くり返し、
// タグの付いたカードを何枚引いたか、タグ同士の組み合わせがそろったかを数える。DOM を使わないので Node でも試せる。
// 「ドロー系」のカードを引いたら、その枚数だけ追加で引いた手札でも同じように数える。

export const START_TAG = '初動';
export const COMBO_TAG = '組み合わせ初動'; // 2 枚以上引くと初動になるカード（同名の 2 枚でもよい）
export const DRAW_TAG = 'ドロー系'; // 使うと山札から追加で引くカード
export const DEFAULT_DRAW = 2;

// そのタグが「そろった」とみなす枚数。組み合わせ初動は 2 枚、ほかは 1 枚
export const needOf = (tag) => (tag === COMBO_TAG ? 2 : 1);

// 集計の入れ物（初手だけの分と、ドロー込みの分で 1 つずつ使う）
//   results[]  タグごと
//     dist[k]    タグの付いたカードをちょうど k 枚引いた回数
//     dup[k]     そのうち、同じカード（同名）を 2 枚以上引いていた回数
//     dupByCard  同名カードを 2 枚以上引いた回数（cid ごと）
//   pairs[]    タグ 2 つの組み合わせごとに、それぞれ必要な枚数（needOf）を別々のカードでそろえた回数
//              （1 枚で両方のタグを持つカードは、片方にしか数えない）
//   start      「初動」か「組み合わせ初動」を使っているときだけ
//     count         初動で動けた回数（初動 1 枚以上、または組み合わせ初動 2 枚以上）
//     bySingle      初動 1 枚以上で動けた回数
//     byComboOnly   初動がなく、組み合わせ初動 2 枚以上で動けた回数
//     sameNameOnly  そのうち、引いた組み合わせ初動がすべて同名だった回数
//     withTag[]     動けたうえで、そのカードとは別にタグ X のカードを持っていた回数（初動系・ドロー系以外のタグごと）
function newTally(main, has, tagNames, maxCards) {
  const results = tagNames.map((tag) => {
    const cards = main.filter((e) => has.get(e.cid).has(tag));
    return {
      tag,
      need: needOf(tag),
      cards,
      copies: cards.reduce((n, e) => n + e.count, 0),
      dist: new Array(maxCards + 1).fill(0),
      dup: new Array(maxCards + 1).fill(0),
      dupByCard: {},
    };
  });
  const roleTags = tagNames.filter((t) => t !== DRAW_TAG);
  const pairs = [];
  for (let a = 0; a < roleTags.length; a++) for (let b = a + 1; b < roleTags.length; b++) pairs.push({ a: roleTags[a], b: roleTags[b], count: 0 });
  const useStart = tagNames.includes(START_TAG) || tagNames.includes(COMBO_TAG);
  const others = roleTags.filter((t) => t !== START_TAG && t !== COMBO_TAG);
  const start = useStart ? { count: 0, bySingle: 0, byComboOnly: 0, sameNameOnly: 0, withTag: others.map((tag) => ({ tag, count: 0 })) } : null;
  return { results, pairs, start };
}

// 手札 h（cid の配列）を 1 回分として数える
function tally(acc, h, has) {
  const drawn = new Map();
  for (const r of acc.results) {
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

  // タグ a を needA 枚、タグ b を needB 枚、別々のカードでそろえられるのは、
  // a の枚数 ≥ needA、b の枚数 ≥ needB、a か b の付いたカードの枚数 ≥ needA + needB のとき
  for (const p of acc.pairs) {
    let na = 0;
    let nb = 0;
    let either = 0;
    for (const cid of h) {
      const tagSet = has.get(cid);
      const ia = tagSet.has(p.a);
      const ib = tagSet.has(p.b);
      if (ia) na++;
      if (ib) nb++;
      if (ia || ib) either++;
    }
    const needA = needOf(p.a);
    const needB = needOf(p.b);
    if (na >= needA && nb >= needB && either >= needA + needB) p.count++;
  }

  const start = acc.start;
  if (!start) return;
  // 動き出しに使うカードの組（初動 1 枚、または組み合わせ初動 2 枚）を全部挙げる
  const units = [];
  for (let i = 0; i < h.length; i++) if (has.get(h[i]).has(START_TAG)) units.push([i]);
  const singles = units.length;
  const combos = [];
  for (let i = 0; i < h.length; i++) if (has.get(h[i]).has(COMBO_TAG)) combos.push(i);
  for (let x = 0; x < combos.length; x++) for (let y = x + 1; y < combos.length; y++) units.push([combos[x], combos[y]]);
  if (!units.length) return;
  start.count++;
  if (singles) start.bySingle++;
  else {
    start.byComboOnly++;
    if (combos.every((i) => h[i] === h[combos[0]])) start.sameNameOnly++;
  }
  for (const w of start.withTag) {
    if (units.some((u) => h.some((cid, k) => !u.includes(k) && has.get(cid).has(w.tag)))) w.count++;
  }
}

// main: [{ cid, count }]、tags: { cid: [タグ…] }、draws: { cid: ドロー枚数 }（ドロー系のカードだけ見る。なければ DEFAULT_DRAW）
// options:
//   order          この順にタグを並べる（デッキで使っていないタグは除く）。残りは使われた順
//   drawOncePerName  同名のドロー系は 1 枚だけ使う（1 ターンに 1 枚の制限があるものとみなす）
//
// 結果:
//   base   初手 hand 枚だけで数えた集計
//   drawn  ドロー系で追加で引いた分まで含めた手札で数えた集計（ドロー系がなければ base と同じもの）
//   draw   ドロー系を使っているときだけ { used: ドロー系を 1 枚以上使えた回数, extra: 追加で引いた枚数の合計, maxCards }
export function simulateHands(main, tags, { trials = 10000, hand = 5, random = Math.random, order = [], draws = {}, drawOncePerName = true } = {}) {
  const pool = main.flatMap((e) => Array(e.count).fill(e.cid));
  const size = pool.length;
  const used = [...new Set(main.flatMap((e) => tags[e.cid] || []))];
  const tagNames = [...order.filter((t) => used.includes(t)), ...used.filter((t) => !order.includes(t))];
  const has = new Map(main.map((e) => [e.cid, new Set(tags[e.cid] || [])]));
  const drawOf = new Map(
    main.filter((e) => has.get(e.cid).has(DRAW_TAG)).map((e) => [e.cid, Math.max(1, Math.min(10, Math.floor(draws[e.cid] ?? DEFAULT_DRAW)))])
  );
  const maxCards = Math.min(size, hand + main.reduce((n, e) => n + (drawOf.get(e.cid) || 0) * e.count, 0));
  const base = newTally(main, has, tagNames, maxCards);
  const drawn = drawOf.size ? newTally(main, has, tagNames, maxCards) : base;
  const draw = drawOf.size ? { used: 0, extra: 0, maxCards } : null;
  if (size < hand) return { size, hand, trials: 0, base, drawn, draw };

  // 先頭から必要な枚数だけ並べ替えて引く（フィッシャー–イェーツの途中まで）。前回の並びから続けても偏らない
  const deck = pool.slice();
  const drawAt = (p) => {
    const j = p + Math.floor(random() * (size - p));
    [deck[p], deck[j]] = [deck[j], deck[p]];
    return deck[p];
  };
  const h = [];
  const usedNames = new Set();
  for (let t = 0; t < trials; t++) {
    h.length = 0;
    for (let i = 0; i < hand; i++) h.push(drawAt(i));
    tally(base, h, has);
    if (!draw) continue;

    // 手札のドロー系を順に使う。引いたカードにドロー系があれば、それも使う
    usedNames.clear();
    let usedAny = false;
    for (let i = 0; i < h.length && h.length < size; i++) {
      const n = drawOf.get(h[i]);
      if (!n || (drawOncePerName && usedNames.has(h[i]))) continue;
      usedNames.add(h[i]);
      usedAny = true;
      for (let k = 0; k < n && h.length < size; k++) h.push(drawAt(h.length));
    }
    if (usedAny) draw.used++;
    draw.extra += h.length - hand;
    tally(drawn, h, has);
  }
  return { size, hand, trials, base, drawn, draw };
}
