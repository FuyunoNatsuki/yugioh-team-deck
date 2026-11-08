// ルーム 1 つ分のサーバー（Cloudflare Durable Object）。
// 3 デッキの内容を保存し、つながっている全員に変更を同じ順番で配る。
//
// やりとり（WebSocket、JSON）:
//   ブラウザ → { type: 'hello', seed?, name }  参加。seed（{ decks, cards }）付きなら、ルームがまだなければそれで作る
//   ブラウザ → { type: 'name', name }          名前を変える
//   ブラウザ → { type: 'ops', id, from, ops, cards, action }  変更（op の形は public/roomsync.js）。action は操作の種類
//   ブラウザ → { type: 'log', before? }        変更履歴を新しい順に 50 件。before（前回の最後の key）より古いもの
//   サーバー → { type: 'init', decks, cards }   参加したときの今の内容
//   サーバー → { type: 'ops', id, from, ops, cards }  受け付けた変更（送った本人にも返す）
//   サーバー → { type: 'log', entries, more }  変更履歴（{ key, t, name, action, lines }）
//   サーバー → { type: 'logEntry', entry }     新しく記録した変更履歴
//   サーバー → { type: 'peers', count, names }  つながっている人数と名前
//   サーバー → { type: 'error', code, message }
import { ROOM_SECTIONS, applyOps, cleanDeckDraws, cleanDeckTags, validOps } from '../public/roomsync.js';

const MAX_MESSAGE = 512 * 1024;
const IDLE_MS = 30 * 24 * 60 * 60 * 1000; // 最後の変更からこの期間たったルームは消す
const CARD_FIELDS = ['cid', 'name', 'ruby', 'kind', 'attr', 'level', 'species', 'effect', 'pscale', 'atk', 'def', 'pendText', 'text', 'img'];
const MAX_LOG = 2000; // 変更履歴はルームごとに新しいものからこの件数まで残す
const LOG_PAGE = 50;
const SECTION_LABEL = { main: 'メイン', extra: 'エクストラ', side: 'サイド' };

const cleanName = (name) => (typeof name === 'string' && name.trim() ? name.trim().slice(0, 20) : '名無し');

// 変更の中身を、履歴に出す短い文にする。適用する前のデッキと比べるので、適用する前に呼ぶ
function describeOps(decks, cards, ops) {
  const lines = [];
  decks.forEach((deck, d) => {
    const items = ops
      .filter((op) => op.d === d)
      .map((op) => {
        const card = cards[op.cid]?.name || `cid:${op.cid}`;
        if ('name' in op) return `デッキ名「${deck.name}」→「${op.name}」`;
        if ('tags' in op) return `${card} のタグ → ${op.tags.length ? op.tags.join('・') : 'なし'}`;
        if ('draw' in op) return `${card} のドロー枚数 → ${op.draw || '既定'}`;
        const before = deck[op.s].find((e) => e.cid === op.cid)?.count || 0;
        return `${card} ${before}→${op.count}枚（${SECTION_LABEL[op.s]}）`;
      });
    if (!items.length) return;
    const shown = items.length > 8 ? [...items.slice(0, 6), `ほか ${items.length - 6}件`] : items;
    lines.push(`デッキ${'ABC'[d]}「${deck.name}」: ${shown.join('、')}`);
  });
  return lines;
}

function cleanCards(cards) {
  const out = {};
  if (!cards || typeof cards !== 'object') return out;
  for (const [cid, c] of Object.entries(cards).slice(0, 400)) {
    if (!/^\d{1,8}$/.test(cid) || !c || typeof c !== 'object') continue;
    const card = { isExtra: c.isExtra === true };
    for (const f of CARD_FIELDS) if (typeof c[f] === 'string') card[f] = c[f].slice(0, 3000);
    card.cid = cid;
    out[cid] = card;
  }
  return out;
}

function cleanDecks(decks) {
  if (!Array.isArray(decks) || decks.length !== 3) return null;
  return decks.map((d, i) => {
    const deck = { name: typeof d?.name === 'string' ? d.name.slice(0, 40) : `デッキ${'ABC'[i]}` };
    for (const s of ROOM_SECTIONS) {
      deck[s] = (Array.isArray(d?.[s]) ? d[s] : [])
        .filter((e) => /^\d{1,8}$/.test(e?.cid) && Number.isInteger(e.count) && e.count > 0 && e.count <= 60)
        .slice(0, 100)
        .map((e) => ({ cid: e.cid, count: e.count }));
    }
    deck.tags = cleanDeckTags(d?.tags);
    deck.draws = cleanDeckDraws(d?.draws);
    return deck;
  });
}

function send(ws, data) {
  try {
    ws.send(typeof data === 'string' ? data : JSON.stringify(data));
  } catch {}
}

export class DeckRoom {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/restore' && request.method === 'POST') return this.restore(request);
    if (path === '/writes' && request.method === 'POST') return this.writeTimes(request);
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket only', { status: 426 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // ルームを過去の時点に戻す（管理者用。worker.js で合言葉を確かめてから呼ばれる）。
  // Cloudflare の Point-in-Time Recovery を使うので、戻せるのは過去 30 日まで。
  // body: { time: 日時 } か { bookmark: 戻し先 }。戻す直前の状態を指す undo を返すので、それを bookmark に渡せば取り消せる
  async restore(request) {
    const { time, bookmark } = await request.json().catch(() => ({}));
    let target = typeof bookmark === 'string' ? bookmark : '';
    if (!target) {
      const at = Date.parse(time);
      if (!Number.isFinite(at)) return Response.json({ error: 'time か bookmark を指定してください' }, { status: 400 });
      try {
        target = await this.ctx.storage.getBookmarkForTime(at);
      } catch (e) {
        return Response.json({ error: `その時点には戻せません（${e.message}）` }, { status: 400 });
      }
    }
    const undo = await this.ctx.storage.onNextSessionRestoreBookmark(target);
    // 参加中の人は一度切断する（再起動を表す 1012）。ブラウザは自動でつなぎ直し、戻した内容を受け取る
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1012, 'restored');
      } catch {}
    }
    // 応答を返してから再起動する。再起動したときに戻し先の状態になる
    setTimeout(() => this.ctx.abort('restore'), 100);
    return Response.json({ restoredTo: target, undo });
  }

  // いつ書き込みがあったかを調べる（管理者用・読み取りだけ）。from〜to を stepSec 秒ごとに見て、
  // 時点のブックマーク（データの位置）が変わったところを返す。変わった区間に、ルームへの書き込みがあった
  async writeTimes(request) {
    const { from, to, stepSec = 60 } = await request.json().catch(() => ({}));
    const start = Date.parse(from);
    const end = Date.parse(to);
    const step = Math.max(1, Number(stepSec)) * 1000;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return Response.json({ error: 'from と to を指定してください' }, { status: 400 });
    if ((end - start) / step > 5000) return Response.json({ error: '範囲が広すぎます（5000 区間まで）' }, { status: 400 });
    const changes = [];
    let prev = null;
    for (let t = start; t <= end; t += step) {
      let bookmark;
      try {
        bookmark = await this.ctx.storage.getBookmarkForTime(t);
      } catch (e) {
        return Response.json({ error: `${new Date(t).toISOString()} のブックマークを取れません（${e.message}）`, changes }, { status: 400 });
      }
      if (prev !== null && bookmark !== prev) changes.push({ after: new Date(t - step).toISOString(), before: new Date(t).toISOString(), bookmark });
      prev = bookmark;
    }
    return Response.json({ from: new Date(start).toISOString(), to: new Date(end).toISOString(), stepSec: step / 1000, changes, current: await this.ctx.storage.getCurrentBookmark() });
  }

  joined() {
    return this.ctx.getWebSockets().filter((ws) => ws.deserializeAttachment()?.joined);
  }

  broadcastPeers(leaving) {
    const peers = this.joined().filter((ws) => ws !== leaving);
    const names = peers.map((ws) => ws.deserializeAttachment()?.name || '名無し');
    const msg = JSON.stringify({ type: 'peers', count: peers.length, names });
    for (const ws of peers) send(ws, msg);
  }

  // 変更履歴を 1 件残し、つながっている全員に知らせる。ときどき古いものを消して MAX_LOG 件に収める
  async addLog(name, action, lines) {
    const t = Date.now();
    const key = `log:${String(t).padStart(15, '0')}:${Math.random().toString(36).slice(2, 8)}`;
    const entry = { t, name, action, lines };
    await this.ctx.storage.put(key, entry);
    const msg = JSON.stringify({ type: 'logEntry', entry: { key, ...entry } });
    for (const ws of this.joined()) send(ws, msg);
    if (Math.random() < 0.05) {
      const keys = [...(await this.ctx.storage.list({ prefix: 'log:', reverse: true, limit: MAX_LOG + 300 })).keys()].slice(MAX_LOG);
      for (let i = 0; i < keys.length; i += 128) await this.ctx.storage.delete(keys.slice(i, i + 128));
    }
  }

  async save(room) {
    const used = new Set(room.decks.flatMap((d) => ROOM_SECTIONS.flatMap((s) => d[s].map((e) => e.cid))));
    for (const cid of Object.keys(room.cards)) if (!used.has(cid)) delete room.cards[cid];
    await this.ctx.storage.put('room', room);
    await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE) return ws.close(1009, 'message too large');
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    let room = await this.ctx.storage.get('room');

    if (msg.type === 'hello') {
      const name = cleanName(msg.name);
      let created = false;
      if (!room && msg.seed) {
        const decks = cleanDecks(msg.seed.decks);
        if (decks) {
          room = { decks, cards: cleanCards(msg.seed.cards) };
          await this.save(room);
          created = true;
        }
      }
      if (!room) {
        send(ws, { type: 'error', code: 'notfound', message: 'ルームが見つかりません（URL が違うか、30日間使われずに削除されました）' });
        return ws.close(4004, 'not found');
      }
      ws.serializeAttachment({ joined: true, name });
      send(ws, { type: 'init', decks: room.decks, cards: room.cards });
      this.broadcastPeers();
      if (created) await this.addLog(name, 'ルームを作成', room.decks.map((d, i) => `デッキ${'ABC'[i]}「${d.name}」`));
      return;
    }

    const me = ws.deserializeAttachment();
    if (!room || !me?.joined) return;

    if (msg.type === 'name') {
      ws.serializeAttachment({ ...me, name: cleanName(msg.name) });
      this.broadcastPeers();
      return;
    }

    if (msg.type === 'log') {
      const options = { prefix: 'log:', reverse: true, limit: LOG_PAGE };
      if (typeof msg.before === 'string' && msg.before.startsWith('log:')) options.end = msg.before;
      const entries = [...(await this.ctx.storage.list(options))].map(([key, e]) => ({ key, ...e }));
      send(ws, { type: 'log', entries, more: entries.length === LOG_PAGE, before: options.end || null });
      return;
    }

    if (msg.type === 'ops') {
      const ops = validOps(msg.ops);
      if (!ops.length) return;
      const cards = cleanCards(msg.cards);
      const lines = describeOps(room.decks, { ...room.cards, ...cards }, ops);
      applyOps(room.decks, ops);
      Object.assign(room.cards, cards);
      await this.save(room);
      const out = JSON.stringify({ type: 'ops', id: String(msg.id || '').slice(0, 20), from: String(msg.from || '').slice(0, 20), ops, cards });
      for (const peer of this.joined()) send(peer, out);
      const action = typeof msg.action === 'string' && msg.action.trim() ? msg.action.trim().slice(0, 30) : '編集';
      await this.addLog(me.name || '名無し', action, lines);
    }
  }

  webSocketClose(ws, code) {
    this.broadcastPeers(ws);
    try {
      ws.close(code === 1005 ? 1000 : code, 'bye');
    } catch {}
  }

  webSocketError(ws) {
    this.broadcastPeers(ws);
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
