// デッキ画像（遊戯王ニューロンのデッキ一覧画像）からカードを切り出し、絵柄でカードを照合する。
// 画像は { width, height, data: RGBA の配列 }（canvas の ImageData と同じ形）で受け取る。
// DOM を使わないので Node でもそのまま試せる。

// ニューロンの画像は横 10 枚並びで、各寸法は 1 列分の幅 p に比例する
const COLS = 10;
const CARD_LEFT = 0.033; // 列の左端からカードまで
const CARD_WIDTH = 0.912;
const CARD_HEIGHT = 1.322;
const ROW_PITCH = 1.426;
const TOP_AFTER_HEADER = 0.01; // 見出しの下の線からカードの上端まで

// 絵柄の枠（カード全体に対する割合）。ニューロンの画像とカードデータベースの画像では枠の形が違うので別々に持つ。
// 値は実際の画像で照合の差が最も大きくなるように合わせたもの
const TILE_ART = { x0: 0.1, x1: 0.9, y0: 0.2, y1: 0.75 };
const CARD_ART = { x0: 0.12, x1: 0.88, y0: 0.185, y1: 0.705 };
const ART_MARGIN = 0.1; // 枠が少しずれても絵柄だけを見るよう、内側を使う
const GRID = 12;

function pixel(img, x, y) {
  const i = ((y | 0) * img.width + (x | 0)) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

// 見出し（「メインデッキ：40枚」などの帯）を上から順に探す。
// 帯の上下には横幅いっぱいの明るい線があるので、その線の組を見出しとする
function findHeaders(img) {
  const { width: W, height: H } = img;
  const p = W / COLS;
  const x0 = Math.round(W * 0.03);
  const x1 = Math.round(W * 0.97);
  const lines = [];
  for (let y = 0; y < H; y++) {
    let n = 0;
    let total = 0;
    for (let x = x0; x < x1; x += 3) {
      const [, g, b] = pixel(img, x, y);
      if (g > 150 && b > 150) n++;
      total++;
    }
    if (n / total < 0.95) continue;
    const last = lines.at(-1);
    if (last && y - last.end <= 2) last.end = y;
    else lines.push({ start: y, end: y });
  }
  const headers = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    const gap = lines[i + 1].start - lines[i].end;
    if (gap > p * 0.25 && gap < p * 0.6) {
      headers.push({ start: lines[i].start, end: lines[i + 1].end });
      i++;
    }
  }
  return headers;
}

// 枠の中が背景（なめらかなグラデーション）ではなくカードか
function hasCard(img, r) {
  let sum = 0;
  let sq = 0;
  let n = 0;
  for (let i = 1; i < 10; i++) {
    for (let j = 1; j < 10; j++) {
      const [R, G, B] = pixel(img, r.x + (r.w * i) / 10, r.y + (r.h * j) / 10);
      const v = 0.299 * R + 0.587 * G + 0.114 * B;
      sum += v;
      sq += v * v;
      n++;
    }
  }
  const mean = sum / n;
  return Math.sqrt(sq / n - mean * mean) > 18;
}

// 見出しごとにカードの位置を返す。見出しは上から メイン・エクストラ・サイド の順
export function detectTiles(img) {
  const { width: W, height: H } = img;
  const p = W / COLS;
  const headers = findHeaders(img);
  return headers.map((h, i) => {
    const top = h.end + p * TOP_AFTER_HEADER;
    const bottom = i + 1 < headers.length ? headers[i + 1].start : H;
    const rows = Math.max(0, Math.floor((bottom - top + p * (ROW_PITCH - CARD_HEIGHT)) / (p * ROW_PITCH)));
    const tiles = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < COLS; c++) {
        const rect = {
          x: Math.round(c * p + p * CARD_LEFT),
          y: Math.round(top + r * p * ROW_PITCH),
          w: Math.round(p * CARD_WIDTH),
          h: Math.round(p * CARD_HEIGHT),
        };
        if (rect.y + rect.h > H) break;
        if (hasCard(img, rect)) tiles.push(rect);
      }
    }
    return tiles;
  });
}

// 絵柄の特徴量: 絵柄部分を GRID×GRID に区切った平均色を、チャンネルごとに平均 0・全体の長さ 1 にしたもの
function artFeature(img, rect, art) {
  const mx = (art.x1 - art.x0) * ART_MARGIN;
  const my = (art.y1 - art.y0) * ART_MARGIN;
  const f = new Float32Array(GRID * GRID * 3);
  const ax = rect.x + rect.w * (art.x0 + mx);
  const ay = rect.y + rect.h * (art.y0 + my);
  const cw = (rect.w * (art.x1 - art.x0 - 2 * mx)) / GRID;
  const ch = (rect.h * (art.y1 - art.y0 - 2 * my)) / GRID;
  const S = 4; // 1 マスあたり S×S 点を平均する
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const [R, G, B] = pixel(img, ax + cw * (gx + (sx + 0.5) / S), ay + ch * (gy + (sy + 0.5) / S));
          r += R;
          g += G;
          b += B;
        }
      }
      const k = (gy * GRID + gx) * 3;
      f[k] = r / (S * S);
      f[k + 1] = g / (S * S);
      f[k + 2] = b / (S * S);
    }
  }
  const n = GRID * GRID;
  for (let c = 0; c < 3; c++) {
    let mean = 0;
    for (let i = 0; i < n; i++) mean += f[i * 3 + c];
    mean /= n;
    for (let i = 0; i < n; i++) f[i * 3 + c] -= mean;
  }
  let norm = 0;
  for (const v of f) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < f.length; i++) f[i] /= norm;
  return f;
}

// デッキ画像から切り出した 1 枚分
export const tileFeature = (img, rect) => artFeature(img, rect, TILE_ART);

// カードデータベースのカード画像 1 枚
export const cardFeature = (img) => artFeature(img, { x: 0, y: 0, w: img.width, h: img.height }, CARD_ART);

// 1 が完全一致、0 付近は無関係
export function similarity(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// 並んでいる同じカード（ほぼ同じ絵柄）をまとめる。features は 1 セクション分を並び順で
export function groupCopies(features) {
  const groups = [];
  features.forEach((f, i) => {
    const last = groups.at(-1);
    if (last && similarity(features[last.first], f) > 0.93) last.count++;
    else groups.push({ first: i, count: 1 });
  });
  return groups;
}

// 候補（{ cid, feature }）を似ている順に並べる。イラスト違いで同じ cid が複数あれば、いちばん似ているものを使う
export function rankCandidates(feature, pool, limit = 8) {
  const best = new Map();
  for (const c of pool) {
    const score = similarity(feature, c.feature);
    if (!(best.get(c.cid) >= score)) best.set(c.cid, score);
  }
  return [...best]
    .map(([cid, score]) => ({ cid, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// 照合結果の確からしさ。似ている度合いと、2 位との差で決める
export function confidence(ranked) {
  const [first, second] = ranked;
  if (!first || first.score < 0.55) return 'none';
  if (first.score >= 0.75 && first.score - (second?.score ?? 0) >= 0.15) return 'exact';
  return 'fuzzy';
}
