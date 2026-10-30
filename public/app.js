// チーム戦デッキビルダー
// 3 デッキを同時に編集し、同名カードの採用枚数をチーム全体で制限する。
import { cardFeature, confidence, detectTiles, groupCopies, rankCandidates, tileFeature } from './deckimage.js';
import { applyOps, diffDecks, opKey } from './roomsync.js';

const SECTIONS = ['main', 'extra', 'side'];
const SECTION_LABEL = { main: 'メイン', extra: 'エクストラ', side: 'サイド' };
const SECTION_MAX = { main: 60, extra: 15, side: 15 };
const DECK_LABELS = ['A', 'B', 'C'];
const KIND_ORDER = { monster: 0, spell: 1, trap: 2 };
const LIMIT_MARK = { 0: '禁', 1: '制', 2: '準' };
const LIMIT_NAME = { 0: '禁止', 1: '制限', 2: '準制限' };
const STORE_KEY = 'ygoTeamDeck.v1';

const FILTERS = [
  { key: 'attr', label: '属性', items: [[12, '闇'], [11, '光'], [15, '地'], [13, '水'], [14, '炎'], [16, '風'], [17, '神']] },
  {
    key: 'effe',
    label: '魔法・罠の種類',
    items: [[20, '通常'], [25, '速攻'], [24, '永続'], [23, '装備'], [22, 'フィールド'], [26, '儀式'], [21, 'カウンター']],
  },
  {
    key: 'other',
    label: 'モンスターの種類',
    items: [
      [0, '通常'], [1, '効果'], [3, '儀式'], [2, '融合'], [9, 'シンクロ'], [10, 'エクシーズ'], [17, 'リンク'], [15, 'ペンデュラム'],
      [8, 'チューナー'], [16, '特殊召喚'], [14, 'リバース'], [4, 'トゥーン'], [5, 'スピリット'], [6, 'ユニオン'], [7, 'デュアル'],
    ],
  },
  {
    key: 'species',
    label: '種族',
    items: [
      [18, '魔法使い'], [1, 'ドラゴン'], [2, 'アンデット'], [15, '戦士'], [12, '獣戦士'], [11, '獣'], [16, '鳥獣'], [3, '悪魔'],
      [17, '天使'], [10, '昆虫'], [9, '恐竜'], [20, '爬虫類'], [8, '魚'], [5, '海竜'], [14, '水'], [4, '炎'], [19, '雷'],
      [6, '岩石'], [13, '植物'], [7, '機械'], [21, 'サイキック'], [26, '幻竜'], [27, 'サイバース'], [34, '幻想魔'], [22, '幻神獣'], [23, '創造神'],
    ],
  },
];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---- 状態 ----

function newDeck(label) {
  return { name: `デッキ${label}`, main: [], extra: [], side: [] };
}

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && Array.isArray(s.decks) && s.decks.length === 3) return { active: 0, cards: {}, ...s };
  } catch {}
  return { decks: DECK_LABELS.map(newDeck), cards: {}, active: 0 };
}

const state = loadState();
let limits = { cards: {}, names: {}, updated: '' };
let selected = null; // { cid, deck, section } — deck が null なら検索結果のカード
const searchCards = {}; // 検索で見つけたカードの情報（デッキに入れたら state.cards へ）
let search = { page: 1, total: 0, rp: 50, cards: [], params: null };
const undoStack = [];
const redoStack = [];
let room = null; // 参加中のルーム（同時編集）。下の「ルーム」を参照

// 起動時に、デッキで使っていないカードの情報を捨てる（編集中は「元に戻す」のため残す）
function pruneCards() {
  const used = new Set(state.decks.flatMap((d) => SECTIONS.flatMap((s) => d[s].map((e) => e.cid))));
  for (const cid of Object.keys(state.cards)) if (!used.has(cid)) delete state.cards[cid];
}

// ルームに参加している間は、手元のデッキ（ブラウザの保存）を上書きしない
function save() {
  if (room) return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {}
}

function mutate(fn) {
  const before = JSON.stringify(state.decks);
  fn();
  if (JSON.stringify(state.decks) === before) return render();
  undoStack.push(before);
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
  save();
  sendRoomOps(diffDecks(JSON.parse(before), state.decks));
  render();
}

function restore(from, to) {
  if (!from.length) return;
  const before = state.decks;
  to.push(JSON.stringify(state.decks));
  state.decks = JSON.parse(from.pop());
  save();
  sendRoomOps(diffDecks(before, state.decks));
  render();
}

// ---- ルール ----

const cardInfo = (cid) => state.cards[cid] || searchCards[cid] || { cid, name: limits.names[cid] || `cid:${cid}`, kind: 'monster', isExtra: false };
const limitOf = (cid) => (cid in limits.cards ? limits.cards[cid] : 3);
const countIn = (list, cid) => list.find((e) => e.cid === cid)?.count || 0;
const sectionTotal = (list) => list.reduce((n, e) => n + e.count, 0);

function teamCount(cid) {
  let n = 0;
  for (const d of state.decks) for (const s of SECTIONS) n += countIn(d[s], cid);
  return n;
}

function allowedSection(card, section) {
  if (section === 'side') return true;
  return card.isExtra ? section === 'extra' : section === 'main';
}

function violations() {
  const cids = new Set(state.decks.flatMap((d) => SECTIONS.flatMap((s) => d[s].map((e) => e.cid))));
  return [...cids].filter((cid) => teamCount(cid) > limitOf(cid));
}

function remember(cid) {
  if (!state.cards[cid] && searchCards[cid]) state.cards[cid] = searchCards[cid];
}

function addCard(cid, deckIdx, section, n = 1) {
  const card = cardInfo(cid);
  section ||= $('toSide').checked ? 'side' : card.isExtra ? 'extra' : 'main';
  if (!allowedSection(card, section)) return toast(`「${card.name}」は${SECTION_LABEL[section]}デッキに入れられません`, 'error');
  const lim = limitOf(cid);
  const used = teamCount(cid);
  if (used + n > lim) {
    return toast(lim === 0 ? `「${card.name}」は禁止カードです` : `「${card.name}」はチーム全体で${lim}枚までです（現在${used}枚採用）`, 'error');
  }
  const list = state.decks[deckIdx][section];
  if (sectionTotal(list) + n > SECTION_MAX[section]) return toast(`${SECTION_LABEL[section]}デッキは${SECTION_MAX[section]}枚までです`, 'error');
  remember(cid);
  mutate(() => {
    const e = list.find((x) => x.cid === cid);
    if (e) e.count += n;
    else list.push({ cid, count: n });
  });
}

function removeCard(cid, deckIdx, section, n = 1) {
  mutate(() => {
    const list = state.decks[deckIdx][section];
    const e = list.find((x) => x.cid === cid);
    if (!e) return;
    e.count -= n;
    if (e.count <= 0) list.splice(list.indexOf(e), 1);
  });
  if (selected?.deck === deckIdx && selected.section === section && !countIn(state.decks[deckIdx][section], cid)) {
    selected = { cid, deck: null };
    renderDetail();
  }
}

// デッキ間の移動はチームの合計枚数を変えないので、枠の種類と枚数上限だけ確認する
function moveCard(cid, from, to, n = 1) {
  if (from.deck === to.deck && from.section === to.section) return;
  const card = cardInfo(cid);
  if (!allowedSection(card, to.section)) return toast(`「${card.name}」は${SECTION_LABEL[to.section]}デッキに入れられません`, 'error');
  const have = countIn(state.decks[from.deck][from.section], cid);
  n = Math.min(n, have);
  if (!n) return;
  const target = state.decks[to.deck][to.section];
  if (sectionTotal(target) + n > SECTION_MAX[to.section]) return toast(`${SECTION_LABEL[to.section]}デッキは${SECTION_MAX[to.section]}枚までです`, 'error');
  mutate(() => {
    const src = state.decks[from.deck][from.section];
    const e = src.find((x) => x.cid === cid);
    e.count -= n;
    if (e.count <= 0) src.splice(src.indexOf(e), 1);
    const t = target.find((x) => x.cid === cid);
    if (t) t.count += n;
    else target.push({ cid, count: n });
  });
  if (selected?.cid === cid && !countIn(state.decks[from.deck][from.section], cid)) selected = { cid, ...to };
  renderDetail();
}

// ---- 描画 ----

function imgUrl(card) {
  return card.img ? `/api/img?${card.img}` : '';
}

function limitBadge(cid) {
  const lim = limitOf(cid);
  return lim < 3 ? `<span class="lim lim${lim}" title="${LIMIT_NAME[lim]}">${LIMIT_MARK[lim]}</span>` : '';
}

// 種類（モンスター・魔法・罠）ごとに読み順で並べる。ルームで同時に追加しても全員が同じ並びになる
function sortedList(list) {
  return [...list].sort((a, b) => {
    const ca = cardInfo(a.cid);
    const cb = cardInfo(b.cid);
    return (KIND_ORDER[ca.kind] ?? 0) - (KIND_ORDER[cb.kind] ?? 0) || (ca.ruby || ca.name).localeCompare(cb.ruby || cb.name, 'ja');
  });
}

function kindBreakdown(list) {
  const n = { monster: 0, spell: 0, trap: 0 };
  for (const e of list) n[cardInfo(e.cid).kind || 'monster'] += e.count;
  return `モ${n.monster} 魔${n.spell} 罠${n.trap}`;
}

function sectionStatus(section, total) {
  if (section === 'main') return total < 40 || total > 60 ? 'bad' : 'ok';
  return total > 15 ? 'bad' : 'ok';
}

function renderDecks() {
  const bad = new Set(violations());
  $('decks').innerHTML = state.decks
    .map((d, i) => {
      const sections = SECTIONS.map((s) => {
        const total = sectionTotal(d[s]);
        const tiles = sortedList(d[s])
          .map(({ cid, count }) => {
            const c = cardInfo(cid);
            const sel = selected && selected.cid === cid && selected.deck === i && selected.section === s;
            const url = imgUrl(c);
            return `<div class="tile${sel ? ' selected' : ''}${bad.has(cid) ? ' over' : ''}" draggable="true" data-cid="${cid}" data-deck="${i}" data-section="${s}" title="${esc(c.name)}">
              ${url ? `<img src="${url}" alt="${esc(c.name)}" loading="lazy" draggable="false">` : `<span class="noimg">${esc(c.name)}</span>`}
              ${limitBadge(cid)}<span class="cnt">${count}</span></div>`;
          })
          .join('');
        const extraInfo = s === 'main' ? ` <small>${kindBreakdown(d[s])}</small>` : '';
        return `<div class="deck-section" data-deck="${i}" data-section="${s}">
            <div class="sec-head"><span>${SECTION_LABEL[s]}</span> <b class="${sectionStatus(s, total)}">${total}</b>${extraInfo}</div>
            <div class="tiles">${tiles || '<span class="empty">ここにドラッグ</span>'}</div>
          </div>`;
      }).join('');
      return `<div class="deck${state.active === i ? ' active' : ''}" data-deck="${i}">
          <div class="deck-head">
            <span class="deck-label">${DECK_LABELS[i]}</span>
            <input class="deck-name" data-deck="${i}" value="${esc(d.name)}" aria-label="デッキ${DECK_LABELS[i]}の名前">
            <button type="button" data-act="import" data-deck="${i}" title="ニューロンから読み込む">取込</button>
            <button type="button" data-act="clear" data-deck="${i}">クリア</button>
          </div>
          ${sections}
        </div>`;
    })
    .join('');
  $('deckTabs').innerHTML = state.decks
    .map((d, i) => `<button type="button" class="${state.active === i ? 'active' : ''}" data-deck="${i}">${DECK_LABELS[i]}: ${esc(d.name)} (${sectionTotal(d.main)})</button>`)
    .join('');
}

function renderTeamStatus() {
  const bad = violations();
  const el = $('teamStatus');
  el.className = 'status ' + (bad.length ? 'bad' : 'ok');
  el.textContent = bad.length ? `チーム制限違反 ${bad.length}件` : 'チーム制限 OK';
  el.title = 'チーム内の採用枚数を表示';
  $('undoBtn').disabled = !undoStack.length;
  $('redoBtn').disabled = !redoStack.length;
}

function usageText(cid) {
  return `${teamCount(cid)}/${limitOf(cid)}`;
}

function renderResults() {
  const box = $('results');
  if (!search.cards.length) {
    box.innerHTML = search.params ? '<p class="muted pad">該当するカードがありません</p>' : '';
    return;
  }
  box.innerHTML = search.cards
    .map((c) => {
      const used = teamCount(c.cid);
      const lim = limitOf(c.cid);
      const full = used >= lim;
      const spec = [c.attr, c.level, c.species, c.effect, c.atk && `${c.atk.replace('攻撃力 ', 'ATK ')}`, c.def && c.def.replace('守備力 ', 'DEF ')]
        .filter(Boolean)
        .join(' ');
      const sel = selected && selected.cid === c.cid && selected.deck === null;
      return `<div class="result${sel ? ' selected' : ''}" draggable="true" data-cid="${c.cid}">
          <div class="thumb">${c.img ? `<img src="${imgUrl(c)}" alt="" loading="lazy" draggable="false">` : ''}${limitBadge(c.cid)}</div>
          <div class="info">
            <div class="name">${esc(c.name)}</div>
            <div class="spec">${esc(spec)}</div>
            <div class="use ${full ? 'full' : ''}">チーム ${used}/${lim}</div>
          </div>
          <div class="adds">${DECK_LABELS.map((l, i) => `<button type="button" data-add="${i}" ${full ? 'disabled' : ''} title="デッキ${l}に追加">${l}</button>`).join('')}</div>
        </div>`;
    })
    .join('');
}

function renderDetail() {
  const box = $('detail');
  if (!selected) {
    box.innerHTML = '<p class="muted">カードをクリックすると詳細を表示します</p>';
    return;
  }
  const { cid } = selected;
  const c = cardInfo(cid);
  const lim = limitOf(cid);
  const perDeck = state.decks.map((d, i) => `${DECK_LABELS[i]}:${SECTIONS.reduce((n, s) => n + countIn(d[s], cid), 0)}`).join(' ');
  let actions = '';
  if (selected.deck === null || selected.deck === undefined) {
    actions = `<div class="act-row">${DECK_LABELS.map((l, i) => `<button type="button" data-dadd="${i}">${l}に追加</button>`).join('')}</div>
      <div class="act-row">${DECK_LABELS.map((l, i) => `<button type="button" data-dadd="${i}" data-dsec="side">${l}サイドに追加</button>`).join('')}</div>`;
  } else {
    const here = countIn(state.decks[selected.deck][selected.section], cid);
    const targets = [];
    state.decks.forEach((d, i) => {
      for (const s of SECTIONS) {
        if ((i === selected.deck && s === selected.section) || !allowedSection(c, s)) continue;
        targets.push(`<button type="button" data-move="${i}" data-msec="${s}">${DECK_LABELS[i]}・${SECTION_LABEL[s]}へ</button>`);
      }
    });
    actions = `<div class="act-row">
        <span>デッキ${DECK_LABELS[selected.deck]}・${SECTION_LABEL[selected.section]}: <b>${here}</b>枚</span>
        <button type="button" data-dminus>−1</button><button type="button" data-dplus>+1</button><button type="button" data-dremove>すべて外す</button>
      </div>
      <div class="act-row">${targets.join('')}<label class="move-all"><input type="checkbox" id="moveAll"> 全部移動</label></div>`;
  }
  const stats = [c.attr, c.level, c.pscale && `スケール ${c.pscale}`, c.species, c.effect, c.atk, c.def].filter(Boolean).join(' / ');
  box.innerHTML = `<div class="detail-body">
      ${c.img ? `<img class="big" src="${imgUrl(c)}" alt="">` : ''}
      <div class="detail-info">
        <div class="name">${esc(c.name)} ${limitBadge(cid)}</div>
        ${c.ruby ? `<div class="ruby">${esc(c.ruby)}</div>` : ''}
        <div class="stats">${esc(stats)}</div>
        <div class="use ${teamCount(cid) > lim ? 'full' : ''}">チーム採用 ${usageText(cid)}（${perDeck}）${lim < 3 ? `・${LIMIT_NAME[lim]}` : ''}</div>
        ${c.pendText ? `<div class="text pend">${esc(c.pendText)}</div>` : ''}
        ${c.text ? `<div class="text">${esc(c.text)}</div>` : ''}
      </div>
    </div>${actions}`;
}

function render() {
  renderDecks();
  renderTeamStatus();
  renderResults();
  renderDetail();
}

let toastTimer;
function toast(msg, type = 'info') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), 3200);
}

// ---- 検索 ----

function renderFilters() {
  $('filterGroups').innerHTML = FILTERS.map(
    (g) => `<fieldset><legend>${g.label}</legend>${g.items
      .map(([v, l]) => `<label class="chip"><input type="checkbox" name="${g.key}" value="${v}"><span>${l}</span></label>`)
      .join('')}</fieldset>`
  ).join('');
}

function searchParams(page) {
  const p = new URLSearchParams({
    keyword: $('keyword').value.trim(),
    stype: $('stype').value,
    ctype: $('ctype').value,
    sort: $('sort').value,
    othercon: $('othercon').value,
    rp: '50',
    page: String(page),
  });
  for (const el of $('filterGroups').querySelectorAll('input:checked')) p.append(el.name, el.value);
  return p;
}

function updateFilterCount() {
  const n = $('filterGroups').querySelectorAll('input:checked').length;
  $('filterCount').textContent = n ? `（${n}）` : '';
}

let searchSeq = 0;
async function runSearch(page = 1) {
  const params = searchParams(page);
  const seq = ++searchSeq;
  $('resultInfo').textContent = '検索中…';
  try {
    const res = await fetch('/api/search?' + params);
    const data = await res.json();
    if (seq !== searchSeq) return;
    if (!res.ok) throw new Error(data.error);
    for (const c of data.cards) searchCards[c.cid] = c;
    search = { ...data, params };
    const pages = Math.max(1, Math.ceil(data.total / data.rp));
    $('resultInfo').textContent = `${data.total.toLocaleString()}件`;
    $('pageInfo').textContent = data.total ? `${data.page} / ${pages}` : '';
    $('prevPage').disabled = data.page <= 1;
    $('nextPage').disabled = data.page >= pages;
    $('results').scrollTop = 0;
    renderResults();
  } catch (e) {
    if (seq !== searchSeq) return;
    $('resultInfo').textContent = '';
    toast(e.message || '検索に失敗しました', 'error');
  }
}

// ---- インポート・出力・保存 ----

function openImport(deckIdx = state.active) {
  $('importTarget').innerHTML = state.decks.map((d, i) => `<option value="${i}">${DECK_LABELS[i]}: ${esc(d.name)}</option>`).join('');
  $('importTarget').value = String(deckIdx);
  $('importError').textContent = '';
  $('importDialog').showModal();
  $('importUrl').focus();
}

// 読み込んだデッキ（{ name, main, extra, side }）で指定のデッキを置き換える。チーム制限は超えていても読み込み、警告する
function applyDeck(deckIdx, deck, cards) {
  Object.assign(state.cards, cards);
  mutate(() => {
    const d = state.decks[deckIdx];
    d.name = deck.name || d.name;
    for (const s of SECTIONS) d[s] = deck[s].map((e) => ({ ...e }));
  });
  const bad = violations();
  if (bad.length) {
    toast(`登録しました。チーム制限を超えているカードが${bad.length}種類あります`, 'error');
    openTeamDialog();
  } else {
    toast(`デッキ${DECK_LABELS[deckIdx]}に「${state.decks[deckIdx].name}」を登録しました`);
  }
}

async function doImport() {
  const btn = $('importSubmit');
  const deckIdx = Number($('importTarget').value);
  btn.disabled = true;
  $('importError').textContent = '読み込み中…';
  try {
    const res = await fetch('/api/deck?url=' + encodeURIComponent($('importUrl').value));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    $('importDialog').close();
    $('importUrl').value = '';
    applyDeck(deckIdx, data, data.cards);
  } catch (e) {
    $('importError').textContent = e.message || 'インポートに失敗しました';
  } finally {
    btn.disabled = false;
  }
}

// ---- 画像から登録 ----
// デッキ画像からカードを切り出し、同じテーマの公開デッキに入っているカードと絵柄を見比べて照合する（すべてブラウザ内）

let pendingImage = null; // { url, img }
let review = null; // { name, main: { rows }, extra, side }
const featureCache = new Map(); // 画像のパラメータ → カード画像の特徴量

function openImageDialog(deckIdx = state.active) {
  $('imageTarget').innerHTML = state.decks.map((d, i) => `<option value="${i}">${DECK_LABELS[i]}: ${esc(d.name)}</option>`).join('');
  $('imageTarget').value = String(deckIdx);
  showImageStep(1);
  $('imageDialog').showModal();
}

function showImageStep(n) {
  $('imageStep1').hidden = n !== 1;
  $('imageStep2').hidden = n !== 2;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('画像を読み込めませんでした'));
    img.src = src;
  });
}

function imageData(img) {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function cropUrl(img, r) {
  const canvas = document.createElement('canvas');
  canvas.width = r.w;
  canvas.height = r.h;
  canvas.getContext('2d').drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  return canvas.toDataURL('image/jpeg', 0.85);
}

async function setImage(file) {
  if (!file.type.startsWith('image/')) {
    $('imageStatus').textContent = '画像ファイルを選んでください';
    return;
  }
  try {
    const url = URL.createObjectURL(file);
    const img = await loadImage(url);
    if (pendingImage) URL.revokeObjectURL(pendingImage.url);
    pendingImage = { url, img };
    $('imagePreview').src = url;
    $('imagePreview').hidden = false;
    $('dropText').hidden = true;
    $('imageStatus').textContent = '';
    $('readImage').disabled = false;
  } catch (e) {
    $('imageStatus').textContent = e.message;
  }
}

async function imageFeature(img) {
  if (!featureCache.has(img)) featureCache.set(img, cardFeature(imageData(await loadImage(`/api/img?${img}`))));
  return featureCache.get(img);
}

// カード画像（イラスト違いがあればそのすべて）を並行して読み込み、特徴量を作る。読み込めなかった画像は除く
async function featuresFor(cards, onProgress) {
  const jobs = cards.flatMap((card) => (card.imgs || [card.img]).filter(Boolean).map((img) => ({ cid: card.cid, img })));
  const out = [];
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        try {
          out.push({ cid: job.cid, feature: await imageFeature(job.img) });
        } catch {}
        onProgress?.(++done, jobs.length);
      }
    })
  );
  return out;
}

async function readImage() {
  if (!pendingImage) return;
  const keyword = $('imageKeyword').value.trim();
  const status = (text) => ($('imageStatus').textContent = text);
  if (!keyword) {
    status('デッキのテーマを入力してください');
    $('imageKeyword').focus();
    return;
  }
  const btn = $('readImage');
  btn.disabled = true;
  try {
    const { img } = pendingImage;
    const data = imageData(img);
    const sections = detectTiles(data);
    if (!sections[0]?.length) throw new Error('ニューロンのデッキ画像として読み取れませんでした（「メインデッキ」などの見出しが見つかりません）');
    status('候補のカードを集めています…');
    const res = await fetch('/api/pool?keyword=' + encodeURIComponent(keyword));
    const pool = await res.json();
    if (!res.ok) throw new Error(pool.error);
    const poolCards = Object.fromEntries(pool.cards.map((c) => [c.cid, c]));
    const features = await featuresFor(pool.cards, (done, total) => status(`候補のカードの絵柄を読み込み中… ${done}/${total}`));
    review = { name: keyword };
    SECTIONS.forEach((s, i) => {
      const tiles = sections[i] || [];
      const tf = tiles.map((t) => tileFeature(data, t));
      review[s] = {
        rows: groupCopies(tf).map((g) => {
          const ranked = rankCandidates(tf[g.first], features, 6);
          const match = confidence(ranked);
          const candidates = ranked.map((r) => poolCards[r.cid]);
          return { count: g.count, crop: cropUrl(img, tiles[g.first]), feature: tf[g.first], status: match, card: match === 'none' ? null : candidates[0], candidates };
        }),
      };
    });
    status('');
    $('reviewImage').src = pendingImage.url;
    renderReview();
    showImageStep(2);
  } catch (e) {
    status(e.message || '読み取りに失敗しました');
  } finally {
    btn.disabled = false;
  }
}

function renderReview() {
  const tag = { exact: '', fuzzy: '<span class="tag fuzzy">要確認</span>', none: '<span class="tag none">未確定</span>' };
  $('reviewList').innerHTML = SECTIONS.map((s) => {
    const { rows } = review[s];
    const total = rows.reduce((n, r) => n + (Number(r.count) || 0), 0);
    const items = rows
      .map((r, i) => {
        const match = r.card ? r.status : 'none';
        const options = [r.card, ...r.candidates.filter((c) => c.cid !== r.card?.cid)].filter(Boolean);
        const select = options.length
          ? `<select data-cand>${r.card ? '' : '<option value="">候補から選ぶ</option>'}${options
              .map((c) => `<option value="${c.cid}" ${c.cid === r.card?.cid ? 'selected' : ''}>${esc(c.name)}</option>`)
              .join('')}</select>`
          : '';
        return `<div class="rrow ${match}" data-section="${s}" data-row="${i}">
            <div class="thumb" title="画像から切り出したカード">${r.crop ? `<img src="${r.crop}" alt="">` : ''}</div>
            <div class="thumb" title="照合したカード">${r.card?.img ? `<img src="${imgUrl(r.card)}" alt="" loading="lazy">` : ''}</div>
            <div class="rinfo">
              <div class="rname">${r.card ? esc(r.card.name) : '（未確定）'} ${tag[match]}</div>
              <div class="rtools">${select}<input data-find type="search" placeholder="名前で探す（Enter）"></div>
            </div>
            <input data-count type="number" min="0" max="60" value="${r.count}" aria-label="枚数">
            <button type="button" data-drop title="この行を削除">×</button>
          </div>`;
      })
      .join('');
    return `<section class="rsec">
        <h3>${SECTION_LABEL[s]}デッキ <b>${total}枚</b></h3>
        ${items || '<p class="muted">なし</p>'}
        <button type="button" class="add-row" data-addrow="${s}">＋ 行を追加</button>
      </section>`;
  }).join('');
}

function reviewRow(el) {
  const rowEl = el.closest('.rrow');
  return rowEl && review[rowEl.dataset.section].rows[Number(rowEl.dataset.row)];
}

function pickCandidate(row, cid) {
  const card = [row.card, ...row.candidates].find((c) => c?.cid === cid);
  if (!card) return;
  row.card = card;
  row.status = 'exact';
}

// 名前で探し、切り出したカードがあれば絵柄の近い順に並べ替える
async function findForRow(row, keyword) {
  if (!keyword.trim()) return;
  try {
    const res = await fetch('/api/search?' + new URLSearchParams({ keyword: keyword.trim(), stype: '1', rp: '50' }));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    if (!data.cards.length) return toast('該当するカードがありません', 'error');
    for (const c of data.cards) searchCards[c.cid] = c;
    let cards = data.cards;
    if (row.feature) {
      const byCid = Object.fromEntries(cards.map((c) => [c.cid, c]));
      const features = await featuresFor(cards.filter((c) => c.img));
      let ranked = rankCandidates(row.feature, features, 50);
      // よく似たものがなければ、上位のカードのイラスト違いも見比べる
      if (ranked.length && ranked[0].score < 0.75) {
        const arts = await Promise.all(
          ranked.slice(0, 20).map((r) => fetch(`/api/arts?cid=${r.cid}`).then((res) => (res.ok ? res.json() : null)).catch(() => null))
        );
        features.push(...(await featuresFor(arts.filter(Boolean))));
        ranked = rankCandidates(row.feature, features, 50);
      }
      cards = ranked.map((r) => byCid[r.cid]);
      if (!cards.length) cards = data.cards;
    }
    row.candidates = cards.slice(0, 20);
    pickCandidate(row, row.candidates[0].cid);
    renderReview();
  } catch (e) {
    toast(e.message || '検索に失敗しました', 'error');
  }
}

function registerImage() {
  const deck = { name: review.name, main: [], extra: [], side: [] };
  const cards = {};
  let skipped = 0;
  for (const s of SECTIONS) {
    for (const row of review[s].rows) {
      const count = Math.max(0, Math.min(60, Math.floor(Number(row.count) || 0)));
      if (!count) continue;
      if (!row.card) {
        skipped += count;
        continue;
      }
      // メインとエクストラの取り違えは、カードの種類に合わせて直す
      const section = s === 'side' ? 'side' : row.card.isExtra ? 'extra' : 'main';
      const e = deck[section].find((x) => x.cid === row.card.cid);
      if (e) e.count += count;
      else deck[section].push({ cid: row.card.cid, count });
      cards[row.card.cid] = row.card;
    }
  }
  if (skipped && !confirm(`未確定のカード${skipped}枚は登録されません。登録しますか？`)) return;
  $('imageDialog').close();
  applyDeck(Number($('imageTarget').value), deck, cards);
}

function bindImageEvents() {
  $('imageBtn').addEventListener('click', () => openImageDialog());
  $('imageFile').addEventListener('change', (e) => {
    if (e.target.files[0]) setImage(e.target.files[0]);
    e.target.value = '';
  });
  const zone = $('dropzone');
  zone.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    zone.classList.add('drop-over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drop-over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drop-over');
    if (e.dataTransfer.files[0]) setImage(e.dataTransfer.files[0]);
  });
  document.addEventListener('paste', (e) => {
    if (!$('imageDialog').open || $('imageStep1').hidden) return;
    const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'));
    if (file) setImage(file);
  });
  $('imageKeyword').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') readImage();
  });
  $('readImage').addEventListener('click', readImage);
  $('backToStep1').addEventListener('click', () => showImageStep(1));
  $('registerImage').addEventListener('click', registerImage);
  $('imageDialog').addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) $('imageDialog').close();
  });

  const list = $('reviewList');
  list.addEventListener('change', (e) => {
    const row = reviewRow(e.target);
    if (!row) return;
    if (e.target.matches('[data-cand]')) {
      pickCandidate(row, e.target.value);
      renderReview();
    } else if (e.target.matches('[data-count]')) {
      row.count = Number(e.target.value) || 0;
      renderReview();
    }
  });
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.matches('[data-find]')) return;
    e.preventDefault();
    findForRow(reviewRow(e.target), e.target.value);
  });
  list.addEventListener('click', (e) => {
    const drop = e.target.closest('[data-drop]');
    if (drop) {
      const rowEl = drop.closest('.rrow');
      review[rowEl.dataset.section].rows.splice(Number(rowEl.dataset.row), 1);
      return renderReview();
    }
    const add = e.target.closest('[data-addrow]');
    if (add) {
      review[add.dataset.addrow].rows.push({ count: 1, crop: null, feature: null, status: 'none', card: null, candidates: [] });
      renderReview();
      list.querySelector(`.rrow[data-section="${add.dataset.addrow}"]:last-of-type [data-find]`)?.focus();
    }
  });
}

function exportText() {
  return state.decks
    .map((d, i) => {
      const parts = [`【デッキ${DECK_LABELS[i]}】${d.name}`];
      for (const s of SECTIONS) {
        parts.push(`＜${SECTION_LABEL[s]}デッキ ${sectionTotal(d[s])}枚＞`);
        for (const e of sortedList(d[s])) parts.push(`${e.count} ${cardInfo(e.cid).name}`);
      }
      return parts.join('\n');
    })
    .join('\n\n');
}

function openTeamDialog() {
  const cids = [...new Set(state.decks.flatMap((d) => SECTIONS.flatMap((s) => d[s].map((e) => e.cid))))];
  const rows = cids
    .map((cid) => ({ cid, used: teamCount(cid), lim: limitOf(cid) }))
    .sort((a, b) => b.used - b.lim - (a.used - a.lim) || b.used - a.used);
  $('teamTable').innerHTML =
    `<thead><tr><th>カード名</th><th>区分</th>${DECK_LABELS.map((l) => `<th>${l}</th>`).join('')}<th>合計/上限</th></tr></thead><tbody>` +
    rows
      .map(({ cid, used, lim }) => {
        const per = state.decks.map((d) => SECTIONS.reduce((n, s) => n + countIn(d[s], cid), 0) || '');
        return `<tr class="${used > lim ? 'over' : used === lim ? 'full' : ''}"><td>${esc(cardInfo(cid).name)}</td><td>${lim < 3 ? LIMIT_NAME[lim] : ''}</td>${per
          .map((n) => `<td class="num">${n}</td>`)
          .join('')}<td class="num">${used}/${lim}</td></tr>`;
      })
      .join('') +
    '</tbody>';
  $('teamDialog').showModal();
}

function downloadSave() {
  const blob = new Blob([JSON.stringify({ app: 'ygo-team-deck', version: 1, decks: state.decks, cards: state.cards }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `team-deck-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function loadSave(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.decks) || data.decks.length !== 3) throw new Error();
    Object.assign(state.cards, data.cards || {});
    mutate(() => {
      state.decks = data.decks.map((d, i) => ({
        name: String(d.name || `デッキ${DECK_LABELS[i]}`),
        ...Object.fromEntries(SECTIONS.map((s) => [s, (d[s] || []).filter((e) => /^\d+$/.test(e.cid) && e.count > 0).map((e) => ({ cid: e.cid, count: Number(e.count) }))])),
      }));
    });
    toast('読み込みました');
  } catch {
    toast('このファイルは読み込めません', 'error');
  }
}

// ---- イベント ----

// ---- ルーム（同時編集） ----
// 変更は「デッキ・枠・カードごとの枚数」単位で送り、サーバーが決めた順番で全員に配られる。
// 自分が送ってまだ返ってきていない変更（inflight）がある項目は、ほかの人の変更を当てずに待つ
// （サーバーでは自分の変更が後に当たるので、最後は全員同じ内容になる）。

const ROOM_ID = /^[a-z0-9]{12}$/;
const clientId = Math.random().toString(36).slice(2, 12);

function newRoomId() {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  return [...crypto.getRandomValues(new Uint8Array(12))].map((b) => chars[b % chars.length]).join('');
}

function roomShareUrl(id) {
  const url = new URL(location.pathname, location.origin);
  url.searchParams.set('room', id);
  return url.toString();
}

function usedCards() {
  const cards = {};
  for (const d of state.decks) for (const s of SECTIONS) for (const e of d[s]) if (state.cards[e.cid]) cards[e.cid] = state.cards[e.cid];
  return cards;
}

// seed が true なら今のデッキでルームを作る（すでにあればそのルームに参加する）
function enterRoom(id, seed) {
  if (room) leaveRoom(false);
  room = { id, ws: null, joined: false, everJoined: false, seed, pending: [], unacked: new Map(), inflight: new Map(), peers: 0, retry: 0, timer: 0 };
  history.replaceState(null, '', roomShareUrl(id));
  connectRoom(room);
  renderRoom();
}

function connectRoom(r) {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/room/${r.id}`);
  r.ws = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'hello', seed: r.seed ? { decks: state.decks, cards: usedCards() } : undefined }));
  };
  ws.onmessage = (e) => {
    if (room !== r) return;
    try {
      onRoomMessage(r, JSON.parse(e.data));
    } catch {}
  };
  ws.onclose = (e) => {
    if (room !== r) return;
    // 届いたか分からない変更は、つなぎ直したあとに送り直す（同じ変更を 2 回当てても結果は同じ）
    r.pending = [...[...r.unacked.values()].flat(), ...r.pending];
    r.unacked.clear();
    r.inflight.clear();
    r.joined = false;
    if (e.code === 4004) return;
    if (!r.everJoined && r.retry >= 2) {
      toast('ルームに接続できませんでした（ルーム機能は公開版でのみ使えます）', 'error');
      leaveRoom(false);
      return;
    }
    r.timer = setTimeout(() => room === r && connectRoom(r), Math.min(30000, 1000 * 2 ** r.retry++));
    renderRoom();
  };
}

function onRoomMessage(r, msg) {
  if (msg.type === 'init') {
    const first = !r.everJoined;
    r.joined = true;
    r.everJoined = true;
    r.seed = false;
    r.retry = 0;
    state.decks = msg.decks;
    Object.assign(state.cards, msg.cards);
    const pending = r.pending;
    r.pending = [];
    applyOps(state.decks, pending);
    undoStack.length = 0;
    redoStack.length = 0;
    sendRoomOps(pending);
    render();
    renderRoom();
    if (first) toast('ルームに参加しました');
  } else if (msg.type === 'ops') {
    Object.assign(state.cards, msg.cards || {});
    if (msg.from === clientId && r.unacked.has(msg.id)) {
      // 自分の変更が返ってきた。手元にはもう当ててある
      for (const op of r.unacked.get(msg.id)) {
        const key = opKey(op);
        const n = (r.inflight.get(key) || 1) - 1;
        if (n) r.inflight.set(key, n);
        else r.inflight.delete(key);
      }
      r.unacked.delete(msg.id);
      return;
    }
    const ops = msg.ops.filter((op) => !r.inflight.has(opKey(op)));
    if (!ops.length) return;
    applyOps(state.decks, ops);
    // ほかの人の変更をまたいで「元に戻す」と、その変更まで消してしまうので履歴を捨てる
    undoStack.length = 0;
    redoStack.length = 0;
    render();
  } else if (msg.type === 'peers') {
    r.peers = msg.count;
    renderRoom();
  } else if (msg.type === 'error') {
    toast(msg.message, 'error');
    if (msg.code === 'notfound') leaveRoom(false);
  }
}

function sendRoomOps(ops) {
  if (!room || !ops.length) return;
  if (!room.joined || room.ws?.readyState !== WebSocket.OPEN) {
    room.pending.push(...ops);
    renderRoom();
    return;
  }
  const id = Math.random().toString(36).slice(2, 12);
  const cards = {};
  for (const op of ops) if (op.count > 0 && state.cards[op.cid]) cards[op.cid] = state.cards[op.cid];
  room.unacked.set(id, ops);
  for (const op of ops) room.inflight.set(opKey(op), (room.inflight.get(opKey(op)) || 0) + 1);
  room.ws.send(JSON.stringify({ type: 'ops', id, from: clientId, ops, cards }));
}

// keepAsk が true なら、ルームのデッキを手元に残すか聞く
function leaveRoom(keepAsk = true) {
  const r = room;
  if (!r) return;
  room = null;
  clearTimeout(r.timer);
  try {
    r.ws?.close(1000);
  } catch {}
  const keep = keepAsk && r.everJoined && confirm('ルームのデッキを手元のデッキとして残しますか？\n「キャンセル」で、ルームに入る前の手元のデッキに戻します。');
  if (keep) {
    save();
  } else {
    const local = loadState();
    state.decks = local.decks;
    Object.assign(state.cards, local.cards);
  }
  undoStack.length = 0;
  redoStack.length = 0;
  history.replaceState(null, '', location.pathname);
  render();
  renderRoom();
}

function renderRoom() {
  const chip = $('roomStatus');
  chip.hidden = !room;
  $('roomOut').hidden = !!room;
  $('roomIn').hidden = !room;
  if (!room) return;
  const online = room.joined;
  chip.classList.toggle('offline', !online);
  const waiting = room.pending.length ? `・未送信 ${room.pending.length}件` : '';
  chip.textContent = online ? `ルーム参加中（${room.peers}人）` : `${room.everJoined ? '再接続中' : '接続中'}…${waiting}`;
  chip.title = 'ルームの共有 URL を表示';
  $('roomShareUrl').value = roomShareUrl(room.id);
  $('roomInfo').textContent = online
    ? `ルーム ${room.id} に参加中です。いま ${room.peers} 人がつながっています。`
    : `ルーム ${room.id} に${room.everJoined ? 'つなぎ直しています' : '接続しています'}…${waiting}`;
}

function bindRoomEvents() {
  const open = () => {
    renderRoom();
    $('roomDialog').showModal();
  };
  $('roomBtn').addEventListener('click', open);
  $('roomStatus').addEventListener('click', open);
  $('roomDialog').addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) $('roomDialog').close();
  });
  $('createRoom').addEventListener('click', () => {
    enterRoom(newRoomId(), true);
    renderRoom();
    $('roomShareUrl').select();
  });
  const join = () => {
    const text = $('joinRoomInput').value.trim();
    let id = text;
    try {
      id = new URL(text).searchParams.get('room') || '';
    } catch {}
    if (!ROOM_ID.test(id)) return toast('ルームの URL か ID（英数字 12 文字）を入力してください', 'error');
    $('joinRoomInput').value = '';
    enterRoom(id, false);
    $('roomDialog').close();
  };
  $('joinRoom').addEventListener('click', join);
  $('joinRoomInput').addEventListener('keydown', (e) => e.key === 'Enter' && join());
  $('copyRoomUrl').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('roomShareUrl').value);
      toast('共有 URL をコピーしました');
    } catch {
      $('roomShareUrl').select();
    }
  });
  $('leaveRoom').addEventListener('click', () => {
    $('roomDialog').close();
    leaveRoom();
  });
}

// 再描画すると入力中のデッキ名からフォーカスが外れるので、クラスだけ切り替える
function setActive(i) {
  if (state.active === i) return;
  state.active = i;
  save();
  for (const el of document.querySelectorAll('.deck, #deckTabs button')) el.classList.toggle('active', Number(el.dataset.deck) === i);
}

function bindEvents() {
  $('searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    runSearch(1);
  });
  for (const id of ['stype', 'ctype', 'sort', 'othercon']) $(id).addEventListener('change', () => search.params && runSearch(1));
  $('filterGroups').addEventListener('change', updateFilterCount);
  $('clearFilters').addEventListener('click', () => {
    for (const el of $('filterGroups').querySelectorAll('input:checked')) el.checked = false;
    updateFilterCount();
  });
  $('prevPage').addEventListener('click', () => runSearch(search.page - 1));
  $('nextPage').addEventListener('click', () => runSearch(search.page + 1));

  // 検索結果
  $('results').addEventListener('click', (e) => {
    const row = e.target.closest('.result');
    if (!row) return;
    const add = e.target.closest('[data-add]');
    if (add) return addCard(row.dataset.cid, Number(add.dataset.add));
    selected = { cid: row.dataset.cid, deck: null };
    renderResults();
    renderDetail();
    renderDecks();
  });
  $('results').addEventListener('dblclick', (e) => {
    const row = e.target.closest('.result');
    if (row && !e.target.closest('button')) addCard(row.dataset.cid, state.active);
  });

  // デッキ
  $('decks').addEventListener('click', (e) => {
    const deckEl = e.target.closest('.deck');
    if (!deckEl) return;
    const act = e.target.closest('[data-act]');
    if (act) {
      const i = Number(act.dataset.deck);
      if (act.dataset.act === 'import') return openImport(i);
      if (act.dataset.act === 'clear' && confirm(`デッキ${DECK_LABELS[i]}のカードをすべて外しますか？`)) {
        mutate(() => SECTIONS.forEach((s) => (state.decks[i][s] = [])));
      }
      return;
    }
    const tile = e.target.closest('.tile');
    if (tile) {
      selected = { cid: tile.dataset.cid, deck: Number(tile.dataset.deck), section: tile.dataset.section };
      state.active = selected.deck;
      render();
      return;
    }
    setActive(Number(deckEl.dataset.deck));
  });
  $('decks').addEventListener('contextmenu', (e) => {
    const tile = e.target.closest('.tile');
    if (!tile) return;
    e.preventDefault();
    removeCard(tile.dataset.cid, Number(tile.dataset.deck), tile.dataset.section);
  });
  $('decks').addEventListener('change', (e) => {
    if (!e.target.classList.contains('deck-name')) return;
    const i = Number(e.target.dataset.deck);
    const name = e.target.value.trim() || `デッキ${DECK_LABELS[i]}`;
    mutate(() => (state.decks[i].name = name));
  });
  $('deckTabs').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) setActive(Number(b.dataset.deck));
  });

  // 詳細パネルの操作
  $('detail').addEventListener('click', (e) => {
    if (!selected) return;
    const { cid } = selected;
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.dadd !== undefined) return addCard(cid, Number(b.dataset.dadd), b.dataset.dsec);
    if (b.dataset.move !== undefined) {
      const all = $('moveAll')?.checked;
      const from = { deck: selected.deck, section: selected.section };
      return moveCard(cid, from, { deck: Number(b.dataset.move), section: b.dataset.msec }, all ? 99 : 1);
    }
    if (b.hasAttribute('data-dplus')) return addCard(cid, selected.deck, selected.section);
    if (b.hasAttribute('data-dminus')) return removeCard(cid, selected.deck, selected.section);
    if (b.hasAttribute('data-dremove')) return removeCard(cid, selected.deck, selected.section, 99);
  });

  // ドラッグ＆ドロップ
  document.addEventListener('dragstart', (e) => {
    const tile = e.target.closest?.('.tile, .result');
    if (!tile) return;
    const data = tile.classList.contains('tile')
      ? { cid: tile.dataset.cid, deck: Number(tile.dataset.deck), section: tile.dataset.section }
      : { cid: tile.dataset.cid, deck: null };
    e.dataTransfer.setData('application/x-ygo-card', JSON.stringify(data));
    e.dataTransfer.setData('text/plain', cardInfo(data.cid).name);
    e.dataTransfer.effectAllowed = 'move';
    document.body.classList.add('dragging');
  });
  document.addEventListener('dragend', () => {
    document.body.classList.remove('dragging');
    document.querySelectorAll('.drop-over').forEach((el) => el.classList.remove('drop-over'));
  });
  const dropTarget = (e) => e.target.closest?.('.deck-section, #searchPane');
  document.addEventListener('dragover', (e) => {
    const t = dropTarget(e);
    if (!t || !e.dataTransfer.types.includes('application/x-ygo-card')) return;
    e.preventDefault();
    document.querySelectorAll('.drop-over').forEach((el) => el !== t && el.classList.remove('drop-over'));
    t.classList.add('drop-over');
  });
  document.addEventListener('drop', (e) => {
    const t = dropTarget(e);
    const raw = e.dataTransfer.getData('application/x-ygo-card');
    if (!t || !raw) return;
    e.preventDefault();
    t.classList.remove('drop-over');
    const data = JSON.parse(raw);
    if (t.id === 'searchPane') {
      if (data.deck !== null) removeCard(data.cid, data.deck, data.section);
      return;
    }
    const to = { deck: Number(t.dataset.deck), section: t.dataset.section };
    if (data.deck === null) addCard(data.cid, to.deck, to.section);
    else moveCard(data.cid, data, to);
  });

  // ヘッダー
  $('teamStatus').addEventListener('click', openTeamDialog);
  $('undoBtn').addEventListener('click', () => restore(undoStack, redoStack));
  $('redoBtn').addEventListener('click', () => restore(redoStack, undoStack));
  $('importBtn').addEventListener('click', () => openImport());
  $('importForm').addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    if ($('importForm').reportValidity()) doImport();
  });
  $('exportBtn').addEventListener('click', () => {
    $('exportText').value = exportText();
    $('exportDialog').showModal();
  });
  $('copyExport').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('exportText').value);
      toast('コピーしました');
    } catch {
      $('exportText').select();
    }
  });
  $('saveBtn').addEventListener('click', downloadSave);
  $('loadBtn').addEventListener('click', () => $('loadFile').click());
  $('loadFile').addEventListener('change', (e) => {
    if (e.target.files[0]) loadSave(e.target.files[0]);
    e.target.value = '';
  });
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.target.matches('input, textarea')) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) {
      e.preventDefault();
      restore(undoStack, redoStack);
    } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
      e.preventDefault();
      restore(redoStack, undoStack);
    }
  });
}

async function loadLimits() {
  try {
    const res = await fetch('/api/limits');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    limits = data;
    $('regulation').textContent = `禁止・制限: ${data.updated || '最新'} 適用`;
  } catch (e) {
    $('regulation').textContent = '禁止・制限リストを取得できませんでした（全カード3枚として扱います）';
    $('regulation').classList.add('error');
  }
  render();
}

pruneCards();
renderFilters();
bindEvents();
bindImageEvents();
bindRoomEvents();
render();
loadLimits();
const sharedRoom = new URLSearchParams(location.search).get('room');
if (ROOM_ID.test(sharedRoom || '')) enterRoom(sharedRoom, false);
