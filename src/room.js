// ルーム 1 つ分のサーバー（Cloudflare Durable Object）。
// 3 デッキの内容を保存し、つながっている全員に変更を同じ順番で配る。
//
// やりとり（WebSocket、JSON）:
//   ブラウザ → { type: 'hello', seed? }        参加。seed（{ decks, cards }）付きなら、ルームがまだなければそれで作る
//   ブラウザ → { type: 'ops', id, from, ops, cards }  変更（op の形は public/roomsync.js）
//   サーバー → { type: 'init', decks, cards }   参加したときの今の内容
//   サーバー → { type: 'ops', id, from, ops, cards }  受け付けた変更（送った本人にも返す）
//   サーバー → { type: 'peers', count }         つながっている人数
//   サーバー → { type: 'error', code, message }
import { ROOM_SECTIONS, applyOps, cleanDeckTags, validOps } from '../public/roomsync.js';

const MAX_MESSAGE = 512 * 1024;
const IDLE_MS = 30 * 24 * 60 * 60 * 1000; // 最後の変更からこの期間たったルームは消す
const CARD_FIELDS = ['cid', 'name', 'ruby', 'kind', 'attr', 'level', 'species', 'effect', 'pscale', 'atk', 'def', 'pendText', 'text', 'img'];

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
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket only', { status: 426 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  joined() {
    return this.ctx.getWebSockets().filter((ws) => ws.deserializeAttachment()?.joined);
  }

  broadcastPeers(leaving) {
    const peers = this.joined().filter((ws) => ws !== leaving);
    const msg = JSON.stringify({ type: 'peers', count: peers.length });
    for (const ws of peers) send(ws, msg);
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
      if (!room && msg.seed) {
        const decks = cleanDecks(msg.seed.decks);
        if (decks) {
          room = { decks, cards: cleanCards(msg.seed.cards) };
          await this.save(room);
        }
      }
      if (!room) {
        send(ws, { type: 'error', code: 'notfound', message: 'ルームが見つかりません（URL が違うか、30日間使われずに削除されました）' });
        return ws.close(4004, 'not found');
      }
      ws.serializeAttachment({ joined: true });
      send(ws, { type: 'init', decks: room.decks, cards: room.cards });
      this.broadcastPeers();
      return;
    }

    if (msg.type === 'ops') {
      if (!room || !ws.deserializeAttachment()?.joined) return;
      const ops = validOps(msg.ops);
      if (!ops.length) return;
      applyOps(room.decks, ops);
      const cards = cleanCards(msg.cards);
      Object.assign(room.cards, cards);
      await this.save(room);
      const out = JSON.stringify({ type: 'ops', id: String(msg.id || '').slice(0, 20), from: String(msg.from || '').slice(0, 20), ops, cards });
      for (const peer of this.joined()) send(peer, out);
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
