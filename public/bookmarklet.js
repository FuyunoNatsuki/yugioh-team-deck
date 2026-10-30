// 非公開デッキを読み込むためのブックマークレット。
// ニューロン（db.yugioh-card.com）にログインしてデッキレシピの画面を開き、そこで実行する。
// 画面に表示されているデッキの内容だけを読み取り、このツールの URL の # 以降に入れて開く
// （# 以降はサーバーに送られないので、デッキの内容もログイン情報もこのツールのサーバーを通らない）。
//
// この関数はそのまま javascript: の URL になるので、外の変数や import を使わないこと。
export function sendDeckFromNeuron(app) {
  /* 表ごとの枠（メイン・エクストラ・サイド） */
  const tables = { monster_list: 'main', spell_list: 'main', trap_list: 'main', extra_list: 'extra', side_list: 'side' };
  /* カードの種類は、表の行のアイコン画像の名前から分かる */
  const kindOf = (icon) => {
    if (/card_icon_spell/.test(icon)) return 'spell';
    if (/card_icon_trap/.test(icon)) return 'trap';
    if (/card_icon_(fusion|synchro|xyz|link)/.test(icon)) return 'extra';
    return 'monster';
  };
  /* 画像のパラメータ（cid → cid=…&ciid=…&enc=…）をページ内から集める */
  const imgs = {};
  for (const m of document.documentElement.innerHTML.matchAll(/get_image\.action\?[^'"]*?cid=(\d+)&(?:amp;)?ciid=(\d+)&(?:amp;)?enc=([\w-]+)/g)) {
    if (!imgs[m[1]]) imgs[m[1]] = `cid=${m[1]}&ciid=${m[2]}&enc=${m[3]}`;
  }
  const deck = { v: 1, name: (document.querySelector('#broad_title h1')?.textContent || '').trim(), main: [], extra: [], side: [] };
  for (const [id, section] of Object.entries(tables)) {
    for (const tr of document.querySelectorAll(`#${id} tr.row`)) {
      const cid = ((tr.querySelector('input.link_value')?.value || '').match(/cid=(\d+)/) || [])[1];
      const count = parseInt(tr.querySelector('td.num span')?.textContent || '', 10);
      if (!cid || !count) continue;
      const name = (tr.querySelector('td.card_name span')?.textContent || tr.title || '').trim();
      deck[section].push([cid, count, name, kindOf(tr.querySelector('td.c_img img')?.getAttribute('src') || ''), imgs[cid] || '']);
    }
  }
  if (!deck.main.length && !deck.extra.length && !deck.side.length) {
    alert('デッキが見つかりません。ニューロンでデッキレシピ（カードの一覧）が表示されている画面で実行してください。');
    return;
  }
  const url = `${app}/#deck=${encodeURIComponent(JSON.stringify(deck))}`;
  if (!window.open(url, '_blank')) location.href = url;
}
