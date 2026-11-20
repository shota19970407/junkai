// ============================================================
//  定期巡回アプリ（iPad 用・電波なしで動く）
//  ・施設を選ぶ → しおりQRを画面に出してカメラで撮る（1枚目）
//  ・撮るたびに「撮った」を押す → カメラの何枚目かを記録
//  ・損傷が増えたら「＋ここに追加」で枠を足す
//  ・帰ったら「記録を書き出す」→ PC の振り分けツールへ
// ============================================================
'use strict';

const APP_VER = '1.0.0';
const QR_PREFIX = 'JK1';           // QR の中身：JK1/<施設ID>/<iPad番号>/<しおり番号>

// ---------- 設定（この iPad だけ） ----------
const settings = (() => {
  let s = {};
  try { s = JSON.parse(localStorage.getItem('jk.settings') || '{}'); } catch (e) {}
  return Object.assign({ deviceNo: 1, deviceName: '', route: '', cat: '' }, s);
})();
function saveSettings() { try { localStorage.setItem('jk.settings', JSON.stringify(settings)); } catch (e) {} }

// ---------- データベース（IndexedDB） ----------
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('junkai', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('fac', { keyPath: 'id' });   // 施設（枠の一覧）
      d.createObjectStore('img');                      // 去年の写真 key=施設ID|枠の順
      d.createObjectStore('rec', { keyPath: 'id' });   // 今年の撮影記録
    };
    r.onsuccess = () => { db = r.result; res(db); };
    r.onerror = () => rej(r.error);
  });
}
function tx(store, mode = 'readonly') { return db.transaction(store, mode).objectStore(store); }
function reqP(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
const getAll = (s) => reqP(tx(s).getAll());
const getOne = (s, k) => reqP(tx(s).get(k));
const putOne = (s, v, k) => reqP(k === undefined ? tx(s, 'readwrite').put(v) : tx(s, 'readwrite').put(v, k));

// ---------- 画面の部品 ----------
const $app = document.getElementById('app');
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
function toast(msg, ms = 2200) {
  const t = h('div', { class: 'toast' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}
function modal(title, body, buttons) {
  return new Promise((resolve) => {
    const close = (v) => { m.remove(); resolve(v); };
    const m = h('div', { class: 'modal' },
      h('div', { class: 'box' }, h('h2', null, title), body,
        h('div', { class: 'acts' }, buttons.map(b => h('button', { class: b.cls || '', onclick: () => close(typeof b.value === 'function' ? b.value() : b.value) }, b.label)))));
    document.body.append(m);
    const f = m.querySelector('input,textarea'); if (f) setTimeout(() => f.focus(), 50);
  });
}
const confirmBox = (title, text, yes = 'はい', no = 'やめる') =>
  modal(title, h('p', null, text), [{ label: no, value: false }, { label: yes, value: true, cls: 'main' }]);

// ---------- 撮影記録 ----------
//  rec = { id, slots:[{k,type:'f'|'a',n,pos,memo}], blocks:[{b,at,seq:[{k|null,at}]}], skip:{k:true}, updated }
//  カメラの番号：しおりQR が 1枚目、seq[i] が (i+2) 枚目
function newRec(fac) {
  return { id: fac.id, slots: fac.frames.map((f, i) => ({ k: 'f' + i, type: 'f', n: f.n, pos: f.pos })), blocks: [], skip: {}, updated: null };
}
function curBlock(rec) { return rec.blocks[rec.blocks.length - 1] || null; }
function shotOf(rec, k) {
  for (let bi = rec.blocks.length - 1; bi >= 0; bi--) {
    const seq = rec.blocks[bi].seq;
    for (let i = seq.length - 1; i >= 0; i--) if (seq[i].k === k) return { b: rec.blocks[bi].b, cam: i + 2 };
  }
  return null;
}
function recStats(rec, fac) {
  if (!rec) return { shot: 0, total: fac.frames.length, adds: 0, started: false };
  let shot = 0, total = 0, adds = 0;
  for (const s of rec.slots) {
    if (rec.skip[s.k]) continue;
    total++;
    if (s.type === 'a') adds++;
    if (shotOf(rec, s.k)) shot++;
  }
  return { shot, total, adds, started: rec.blocks.length > 0 };
}
function nextSlot(rec) {
  return rec.slots.find(s => !rec.skip[s.k] && !shotOf(rec, s.k)) || null;
}
async function saveRec(rec) { rec.updated = new Date().toISOString(); await putOne('rec', rec); }
function slotLabel(rec, s) {
  if (s.type === 'f') return '写真番号 ' + s.n;
  const i = rec.slots.indexOf(s);
  let prev = null;
  for (let j = i - 1; j >= 0; j--) if (rec.slots[j].type === 'f') { prev = rec.slots[j]; break; }
  return prev ? '追加（' + prev.n + ' の後）' : '追加（先頭）';
}
function camText(rec, sh) {
  if (!sh) return '';
  return (rec.blocks.length > 1 ? 'しおり' + sh.b + 'の ' : '') + sh.cam + '枚目';
}

// ---------- 状態 ----------
let facs = [];          // 施設の一覧
let recs = new Map();   // 施設ID → 記録
let view = { name: 'home' };

async function loadAll() {
  facs = await getAll('fac');
  facs.sort((a, b) => (a.route + a.category).localeCompare(b.route + b.category, 'ja') || (parseInt(a.no) || 0) - (parseInt(b.no) || 0));
  recs = new Map((await getAll('rec')).map(r => [r.id, r]));
}

// ---------- ホーム（施設の一覧） ----------
function renderHome() {
  const routes = [...new Set(facs.map(f => f.route))];
  if (!routes.includes(settings.route)) settings.route = routes[0] || '';
  const cats = [...new Set(facs.filter(f => f.route === settings.route).map(f => f.category))];
  if (!cats.includes(settings.cat)) settings.cat = cats[0] || '';
  const q = (view.q || '').trim();
  const list = facs.filter(f => f.route === settings.route && f.category === settings.cat &&
    (!q || (f.no + ' ' + f.name + ' ' + f.struct).toLowerCase().includes(q.toLowerCase())));
  const anyRec = [...recs.values()].some(r => r.blocks.length);

  $app.replaceChildren(
    h('header', { class: 'bar' },
      h('h1', null, '定期巡回　iPad ' + settings.deviceNo + (settings.deviceName ? '（' + settings.deviceName + '）' : '')),
      h('button', { onclick: () => exportRecords() }, '記録を書き出す'),
      h('button', { onclick: () => go({ name: 'settings' }) }, '設定')),
    h('main', null,
      facs.length === 0 ? h('div', { class: 'empty' },
        h('h2', null, 'まず施設のデータを入れてください'),
        h('p', { class: 'muted' }, 'PC で作った「R39_排水施設.json」などのファイルを、この iPad の「ファイル」に入れてから読み込みます。'),
        h('button', { class: 'main', onclick: importData }, 'データを読み込む')) : [
        h('div', { class: 'chips' }, routes.map(r => h('button', { class: 'chip' + (r === settings.route ? ' on' : ''), onclick: () => { settings.route = r; saveSettings(); render(); } }, r))),
        h('div', { class: 'chips' }, cats.map(c => {
          const fs = facs.filter(f => f.route === settings.route && f.category === c);
          const done = fs.filter(f => { const s = recStats(recs.get(f.id), f); return s.started && s.shot >= s.total; }).length;
          return h('button', { class: 'chip' + (c === settings.cat ? ' on' : ''), onclick: () => { settings.cat = c; saveSettings(); view.q = ''; render(); } }, c + ' ' + done + '/' + fs.length);
        })),
        h('input', { type: 'search', placeholder: '番号・KP・名前でさがす（例 47.1）', value: q, oninput: (e) => { view.q = e.target.value; renderListOnly(); } }),
        h('div', { class: 'list', id: 'faclist', style: 'margin-top:10px' }, facRows(list)),
        anyRec ? null : h('p', { class: 'muted', style: 'margin-top:18px' }, '使い方：施設を選ぶ →「しおりQR」をカメラで撮る → 写真を撮るたびに「撮った」。'),
      ]));
}
function facRows(list) {
  if (!list.length) return [h('p', { class: 'muted' }, '見つかりません')];
  return list.map(f => {
    const s = recStats(recs.get(f.id), f);
    const st = !s.started ? h('span', { class: 'badge' }, '未 ' + s.total + '枚')
      : s.shot >= s.total ? h('span', { class: 'badge done' }, '済 ' + s.shot + '/' + s.total)
      : h('span', { class: 'badge part' }, '途中 ' + s.shot + '/' + s.total);
    return h('button', { class: 'fac', onclick: () => go({ name: 'fac', id: f.id }) },
      h('span', { class: 'no' }, f.no),
      h('span', { class: 'nm' }, f.name, f.struct && f.struct !== f.name ? h('small', null, f.struct) : null),
      s.adds ? h('span', { class: 'badge part' }, '追加' + s.adds) : null, st);
  });
}
function renderListOnly() {
  const el = document.getElementById('faclist'); if (!el) return;
  const q = (view.q || '').trim().toLowerCase();
  const list = facs.filter(f => f.route === settings.route && f.category === settings.cat &&
    (!q || (f.no + ' ' + f.name + ' ' + f.struct).toLowerCase().includes(q)));
  el.replaceChildren(...facRows(list));
}

// ---------- 施設の画面 ----------
const imgCache = new Map();
async function loadImgs(fac) {
  const out = [];
  for (let i = 0; i < fac.frames.length; i++) {
    const key = fac.id + '|' + i;
    if (!imgCache.has(key)) imgCache.set(key, await getOne('img', key) || '');
    out.push(imgCache.get(key));
  }
  if (imgCache.size > 400) imgCache.clear();
  return out;
}
async function renderFac() {
  const fac = facs.find(f => f.id === view.id);
  if (!fac) return go({ name: 'home' });
  const imgs = await loadImgs(fac);
  let rec = recs.get(fac.id);
  if (!rec) { rec = newRec(fac); recs.set(fac.id, rec); }
  const nx = nextSlot(rec);
  const blk = curBlock(rec);
  const st = recStats(rec, fac);
  const camNow = blk ? blk.seq.length + 1 : 0;   // カメラで今まで撮った枚数（この施設のしおりから）

  const cards = [];
  rec.slots.forEach((s, i) => {
    const sh = shotOf(rec, s.k);
    const skip = !!rec.skip[s.k];
    const fi = s.type === 'f' ? parseInt(s.k.slice(1)) : -1;
    const img = fi >= 0 ? imgs[fi] : '';
    const cls = 'card' + (s.type === 'a' ? ' added' : '') + (sh ? ' shot' : '') + (skip ? ' skip' : '') + (nx && nx.k === s.k ? ' next' : '');
    cards.push(h('div', { class: cls, id: 'c_' + s.k },
      h('div', { class: 'ph', onclick: img ? () => showViewer(img, slotLabel(rec, s) + '　' + (s.pos || '')) : null },
        img ? h('img', { src: img, alt: '' }) : h('span', null, s.type === 'a' ? '今年の追加の写真' : '去年の写真なし'),
        img ? h('span', { class: 'tag' }, '去年') : null),
      h('div', { class: 'body' },
        h('div', { class: 'ttl' }, h('b', null, slotLabel(rec, s)), h('span', null, s.pos || (s.type === 'a' ? '（位置を入れてください）' : ''))),
        s.memo ? h('div', { class: 'muted' }, 'メモ：' + s.memo) : null,
        h('div', { class: 'cam' }, skip ? '撮らない' : sh ? '📷 カメラ ' + camText(rec, sh) : '未'),
        h('div', { class: 'acts' },
          skip ? h('button', { onclick: () => toggleSkip(rec, s) }, '撮るに戻す') : [
            h('button', { class: sh ? '' : 'ok', onclick: () => markShot(rec, s) }, sh ? '撮り直した' : '撮った'),
            s.type === 'a' ? h('button', { onclick: () => editAdd(rec, s) }, '直す') : h('button', { class: 'ghost', onclick: () => toggleSkip(rec, s) }, '撮らない'),
          ]),
        h('div', { class: 'ins' }, h('button', { onclick: () => addSlot(rec, i + 1) }, '＋ この後に追加の写真')))));
  });

  $app.replaceChildren(
    h('header', { class: 'bar' },
      h('button', { onclick: () => go({ name: 'home' }) }, '◀ 一覧'),
      h('h1', null, fac.no + '. ' + fac.name),
      h('button', { onclick: () => showQR(fac, rec) }, 'しおりQR')),
    h('main', null,
      h('div', { class: 'facinfo' },
        h('span', { class: 'badge' }, fac.route + ' ' + fac.category),
        fac.struct ? h('span', { class: 'badge' }, fac.struct) : null,
        fac.lastDate ? h('span', { class: 'badge' }, '前回 ' + fac.lastDate) : null,
        h('span', { class: 'badge ' + (st.shot >= st.total ? 'done' : st.shot ? 'part' : '') }, st.shot + '/' + st.total + ' 枚'),
        h('span', { style: 'flex:1' }),
        rec.blocks.length ? h('button', { onclick: () => undo(rec) }, '1つ戻す') : null,
        rec.blocks.length ? h('button', { onclick: () => discard(rec) }, '撮り損じ（余分に1枚）') : null),
      !blk ? h('div', { class: 'sec', style: 'border-color:#e0b400;background:#fffbe6' },
        h('h3', null, '① 最初に「しおりQR」をカメラで撮ってください'),
        h('p', { class: 'muted', style: 'margin:0 0 10px' }, 'QR が 1枚目になり、そのあとの写真がこの施設の写真になります。'),
        h('button', { class: 'main', onclick: () => showQR(fac, rec) }, 'しおりQRを出す')) : null,
      h('div', { class: 'grid' }, cards)),
    h('div', { class: 'dock' }, h('div', { class: 'in' },
      h('div', { class: 'counter' }, 'カメラ', h('b', null, camNow ? camNow + '枚' : '－')),
      h('div', { class: 'nx' },
        h('div', { class: 'l' }, blk ? (nx ? '次に撮るもの' : 'この施設は全部撮りました') : 'まずしおりQR'),
        h('div', { class: 'v' }, blk ? (nx ? slotLabel(rec, nx) + '　' + (nx.pos || '') : '一覧に戻って次の施設へ') : '右のボタンで QR を出す')),
      blk ? (nx ? h('button', { class: 'ok big', onclick: () => markShot(rec, nx) }, '撮った ✓') : h('button', { class: 'main big', onclick: () => go({ name: 'home' }) }, '一覧へ'))
        : h('button', { class: 'main big', onclick: () => showQR(fac, rec) }, 'しおりQR'))));

  if (nx && view.scrollNext) {
    const el = document.getElementById('c_' + nx.k);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  view.scrollNext = false;
}

async function markShot(rec, s) {
  let blk = curBlock(rec);
  if (!blk) {
    const ok = await confirmBox('しおりQRがまだです', '先に「しおりQR」をカメラで撮ってください。今 QR を出しますか？', 'QRを出す');
    if (ok) showQR(facs.find(f => f.id === rec.id), rec);
    return;
  }
  const sh = shotOf(rec, s.k);
  if (sh) {
    const ok = await confirmBox('撮り直しますか？', slotLabel(rec, s) + ' は「カメラ ' + camText(rec, sh) + '」で撮っています。今撮った写真を使い、前の写真は使わないことにします。', '撮り直した');
    if (!ok) return;
    for (const b of rec.blocks) for (const e of b.seq) if (e.k === s.k) e.k = null;
  }
  blk.seq.push({ k: s.k, at: new Date().toISOString() });
  await saveRec(rec);
  view.scrollNext = true;
  render();
  toast(slotLabel(rec, s) + ' → カメラ ' + (blk.seq.length + 1) + '枚目', 1400);
}
async function discard(rec) {
  const blk = curBlock(rec); if (!blk) return;
  blk.seq.push({ k: null, at: new Date().toISOString() });
  await saveRec(rec); render();
  toast('カメラ ' + (blk.seq.length + 1) + '枚目は使わない写真にしました');
}
async function undo(rec) {
  const blk = curBlock(rec); if (!blk) return;
  if (!blk.seq.length) {
    if (rec.blocks.length > 0 && await confirmBox('しおりを取り消しますか？', 'このしおり（' + blk.b + '）にはまだ写真がありません。しおりを撮っていなければ取り消します。', '取り消す')) {
      rec.blocks.pop(); await saveRec(rec); render();
    }
    return;
  }
  const e = blk.seq.pop();
  await saveRec(rec); render();
  const s = rec.slots.find(x => x.k === e.k);
  toast('戻しました：' + (s ? slotLabel(rec, s) : '撮り損じ'));
}
async function toggleSkip(rec, s) {
  if (!rec.skip[s.k]) {
    const ok = await confirmBox('この写真は撮りませんか？', slotLabel(rec, s) + '（' + (s.pos || '') + '）を今年は撮らないことにします。', '撮らない');
    if (!ok) return;
    rec.skip[s.k] = true;
  } else delete rec.skip[s.k];
  await saveRec(rec); render();
}
async function addSlot(rec, at) {
  const pos = h('input', { placeholder: '位置（例 起点L側壁 ひび割れ）' });
  const memo = h('textarea', { rows: 3, placeholder: 'メモ（損傷の様子など。なくてもよい）' });
  const ok = await modal('写真を追加', h('div', { class: 'list' }, pos, memo),
    [{ label: 'やめる', value: false }, { label: '追加する', value: true, cls: 'main' }]);
  if (!ok) return;
  let max = 0; for (const s of rec.slots) if (s.type === 'a') max = Math.max(max, parseInt(s.k.slice(1)));
  const s = { k: 'a' + (max + 1), type: 'a', pos: pos.value.trim(), memo: memo.value.trim() };
  rec.slots.splice(at, 0, s);
  await saveRec(rec); render();
  setTimeout(() => { const el = document.getElementById('c_' + s.k); if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 50);
}
async function editAdd(rec, s) {
  const pos = h('input', { value: s.pos || '', placeholder: '位置' });
  const memo = h('textarea', { rows: 3, placeholder: 'メモ' }); memo.value = s.memo || '';
  const r = await modal('追加の写真を直す', h('div', { class: 'list' }, pos, memo),
    [{ label: 'この枠を消す', value: 'del' }, { label: 'やめる', value: false }, { label: '保存', value: 'save', cls: 'main' }]);
  if (r === 'save') { s.pos = pos.value.trim(); s.memo = memo.value.trim(); }
  else if (r === 'del') {
    if (!await confirmBox('追加の枠を消しますか？', '撮った写真は「使わない写真」になります。', '消す')) return;
    for (const b of rec.blocks) for (const e of b.seq) if (e.k === s.k) e.k = null;
    rec.slots.splice(rec.slots.indexOf(s), 1);
  } else return;
  await saveRec(rec); render();
}

// ---------- しおりQR ----------
async function showQR(fac, rec) {
  let blk = curBlock(rec);
  if (!blk || blk.seq.length > 0) {
    blk = { b: rec.blocks.length + 1, at: new Date().toISOString(), seq: [] };
    rec.blocks.push(blk);
    await saveRec(rec);
  }
  const payload = [QR_PREFIX, fac.id, settings.deviceNo, blk.b].join('/');
  const q = qrcode(0, 'M'); q.addData(payload); q.make();
  const n = q.getModuleCount(), quiet = 4, px = 12;
  const cv = document.createElement('canvas');
  cv.width = cv.height = (n + quiet * 2) * px;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); g.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) g.fillRect((c + quiet) * px, (r + quiet) * px, px, px);
  const close = () => { el.remove(); render(); };
  const el = h('div', { class: 'qr' },
    h('div', { class: 't1' }, fac.no + '. ' + fac.name),
    h('div', { class: 't2' }, fac.route + '　' + fac.category + (fac.struct && fac.struct !== fac.name ? '　' + fac.struct : '')),
    cv,
    h('div', { class: 't3' }, payload),
    h('div', { class: 't2' }, 'iPad ' + settings.deviceNo + '　しおり ' + blk.b + '　' + new Date().toLocaleDateString('ja-JP')),
    h('div', { class: 'acts' },
      h('button', { onclick: async () => { if (!blk.seq.length && rec.blocks.length && curBlock(rec) === blk) { rec.blocks.pop(); await saveRec(rec); } close(); } }, '撮らずに戻る'),
      h('button', { class: 'ok', onclick: close }, 'カメラで撮った ✓')));
  document.body.append(el);
  view.scrollNext = true;
}
function showViewer(src, cap) {
  const el = h('div', { class: 'viewer', onclick: () => el.remove() }, h('img', { src }), h('div', { class: 'cap' }, cap + '　（タップで閉じる）'));
  document.body.append(el);
}

// ---------- データの読み込み ----------
function pickFiles(accept, multiple) {
  return new Promise((res) => {
    const i = h('input', { type: 'file', accept, multiple: multiple || null, style: 'display:none' });
    i.addEventListener('change', () => { res([...i.files]); i.remove(); });
    document.body.append(i); i.click();
  });
}
async function importData() {
  const files = await pickFiles('.json,application/json', true);
  if (!files.length) return;
  let nFac = 0, nImg = 0, bad = [];
  for (const file of files) {
    let d;
    try { d = JSON.parse(await file.text()); } catch (e) { bad.push(file.name); continue; }
    if (!d || d.kind !== 'junkai-data') { bad.push(file.name); continue; }
    for (const f of d.facilities) {
      const fac = { id: f.id, route: d.route, category: d.category, no: f.no, name: f.name, struct: f.struct, lastDate: f.lastDate,
        folder: f.folder, book: f.book, frames: f.frames.map(x => ({ n: x.n, pos: x.pos })), dataCreated: d.created };
      await putOne('fac', fac); nFac++;
      for (let i = 0; i < f.frames.length; i++) {
        await putOne('img', f.frames[i].img ? 'data:image/jpeg;base64,' + f.frames[i].img : '', f.id + '|' + i);
        if (f.frames[i].img) nImg++;
      }
      // 記録がまだ写真を撮っていなければ、新しい枠に合わせる
      const r = recs.get(f.id);
      if (r && !r.blocks.length && !r.slots.some(s => s.type === 'a')) { recs.delete(f.id); await reqP(tx('rec', 'readwrite').delete(f.id)); }
    }
  }
  imgCache.clear();
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
  await loadAll();
  render();
  await modal('読み込みました', h('p', null, '施設 ' + nFac + ' 件・去年の写真 ' + nImg + ' 枚' + (bad.length ? '\n読めなかったファイル：' + bad.join('、') : '')), [{ label: 'OK', value: true, cls: 'main' }]);
}

// ---------- 記録の書き出し ----------
async function exportRecords() {
  const out = { kind: 'junkai-record', version: 1, app: APP_VER, deviceNo: settings.deviceNo, deviceName: settings.deviceName, exported: new Date().toISOString(), facilities: [] };
  for (const rec of recs.values()) {
    if (!rec.blocks.some(b => b.seq.length) && !rec.slots.some(s => s.type === 'a')) continue;
    const fac = facs.find(f => f.id === rec.id); if (!fac) continue;
    out.facilities.push({ id: fac.id, route: fac.route, category: fac.category, no: fac.no, name: fac.name, folder: fac.folder, book: fac.book,
      slots: rec.slots, skip: rec.skip, blocks: rec.blocks, updated: rec.updated });
  }
  if (!out.facilities.length) return modal('書き出す記録がありません', h('p', null, 'まだ写真を撮った施設がありません。'), [{ label: 'OK', value: true }]);
  const d = new Date(), p = (x) => String(x).padStart(2, '0');
  const name = '巡回記録_iPad' + settings.deviceNo + '_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + '.json';
  const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); toast('書き出しました：' + name, 3000); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  const a = h('a', { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); a.remove();
  toast('書き出しました：' + name, 3000);
}

// ---------- 設定 ----------
function renderSettings() {
  const nFac = facs.length;
  const nRec = [...recs.values()].filter(r => r.blocks.some(b => b.seq.length)).length;
  const dev = h('select', { onchange: (e) => { settings.deviceNo = parseInt(e.target.value); saveSettings(); } },
    [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => h('option', { value: n, selected: n === settings.deviceNo || null }, 'iPad ' + n)));
  const nm = h('input', { value: settings.deviceName, placeholder: '班の名前（例 松村班）', onchange: (e) => { settings.deviceName = e.target.value.trim(); saveSettings(); } });
  $app.replaceChildren(
    h('header', { class: 'bar' }, h('button', { onclick: () => go({ name: 'home' }) }, '◀ 戻る'), h('h1', null, '設定')),
    h('main', null,
      h('div', { class: 'sec' }, h('h3', null, 'この iPad の番号'),
        h('p', { class: 'muted', style: 'margin-top:0' }, '何台かで手分けするときは、iPad ごとにちがう番号にしてください（QR に入ります）。'),
        h('div', { class: 'row' }, h('div', { style: 'width:160px' }, dev), h('div', { style: 'flex:1;min-width:200px' }, nm))),
      h('div', { class: 'sec' }, h('h3', null, '施設のデータ'),
        h('p', { class: 'muted', style: 'margin-top:0' }, '入っている施設：' + nFac + ' 件。年度が変わったら、PC で作り直したデータを読み込みます（撮影記録は消えません）。'),
        h('button', { class: 'main', onclick: importData }, 'データを読み込む')),
      h('div', { class: 'sec' }, h('h3', null, '撮影記録'),
        h('p', { class: 'muted', style: 'margin-top:0' }, '記録のある施設：' + nRec + ' 件'),
        h('div', { class: 'row' },
          h('button', { class: 'main', onclick: exportRecords }, '記録を書き出す'),
          h('button', { onclick: clearRecords }, '記録を全部消す（新しい巡回を始める）'))),
      h('div', { class: 'sec help' }, h('h3', null, '使い方'),
        h('ol', null,
          h('li', null, '施設を選び「しおりQR」を出して、カメラで QR を撮る（その施設の 1枚目）。'),
          h('li', null, '去年の写真と同じように撮り、撮るたびに下の「撮った ✓」を押す（順番がちがうときはその枠の「撮った」）。'),
          h('li', null, '損傷が増えていたら、枠の間の「＋ ここに追加」で枠を足して撮る。'),
          h('li', null, '失敗して余分に撮ったら「撮り損じ」、押しまちがえたら「1つ戻す」。'),
          h('li', null, '帰ったら「記録を書き出す」で PC へ送る（AirDrop・メール・ファイル保存）。'))),
      h('p', { class: 'muted' }, 'アプリ ' + APP_VER)));
}
async function clearRecords() {
  if (!await confirmBox('撮影記録を全部消しますか？', '先に「記録を書き出す」で PC へ送ってください。消した記録は戻せません。', '全部消す')) return;
  await reqP(tx('rec', 'readwrite').clear());
  await loadAll(); render(); toast('記録を消しました');
}

// ---------- 画面の切り替え ----------
function go(v) { view = Object.assign({}, v); history.replaceState(null, '', '#' + (v.name === 'fac' ? 'fac=' + encodeURIComponent(v.id) : v.name)); render(); window.scrollTo(0, 0); }
function render() {
  if (view.name === 'fac') return renderFac();
  if (view.name === 'settings') return renderSettings();
  return renderHome();
}

(async function start() {
  try { await openDB(); } catch (e) { $app.textContent = 'データベースを開けませんでした：' + e; return; }
  await loadAll();
  const m = location.hash.match(/^#fac=(.+)$/);
  if (m) view = { name: 'fac', id: decodeURIComponent(m[1]) };
  else if (location.hash === '#settings') view = { name: 'settings' };
  render();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
