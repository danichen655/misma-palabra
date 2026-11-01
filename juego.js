'use strict';

/*
 * Misma Palabra — juego de asociación multijugador.
 * Sin servidor propio: el navegador que crea la sala hace de anfitrión y
 * los demás se conectan a él por WebRTC (PeerJS). El anfitrión guarda el
 * estado de la partida y lo reenvía a todos tras cada cambio; las palabras
 * de la ronda en curso solo las conoce él hasta el momento de revelarlas.
 * Los mensajes viajan como claves de texto, así cada jugador los ve en su idioma.
 */

const PREFIX = 'misma-palabra-v1-';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const COLORS = ['#ff5b3a', '#4f6bff', '#ffc93c', '#2fbf83', '#ff9fcb', '#b18cff'];
const REVEAL_MS = 15000;
const MAX_WORD = 24;

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function storage(kind) {
  try { return kind === 'session' ? window.sessionStorage : window.localStorage; } catch { return null; }
}
function load(kind, key) {
  try { return storage(kind)?.getItem(key) ?? null; } catch { return null; }
}
function save(kind, key, value) {
  try { storage(kind)?.setItem(key, value); } catch { /* sin almacenamiento */ }
}

function randomCode() {
  let out = '';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

// Identificador por pestaña: sobrevive a recargar, pero dos pestañas son dos jugadores.
const me = {
  id: load('session', 'mp-id') || crypto.getRandomValues(new Uint32Array(2)).join('-'),
  name: load('local', 'mp-name') || '',
};
save('session', 'mp-id', me.id);

/* ---------- Idioma ---------- */

let lang = (() => {
  // Un enlace compartido desde la versión china lleva ?lang=zh.
  const fromUrl = new URLSearchParams(location.search).get('lang');
  if (fromUrl === 'es' || fromUrl === 'zh') return fromUrl;
  const saved = load('local', 'mp-lang');
  if (saved === 'es' || saved === 'zh') return saved;
  return /^zh\b/i.test(navigator.language || '') ? 'zh' : 'es';
})();

function t(key, params = {}) {
  const value = TEXTS[lang][key] ?? TEXTS.es[key] ?? key;
  if (typeof value === 'function') return value(params);
  return value.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? ''));
}

function joinList(items) {
  try {
    return new Intl.ListFormat(lang === 'zh' ? 'zh' : 'es', { type: 'conjunction' }).format(items);
  } catch {
    return items.join(', ');
  }
}

// Textos sueltos (avisos, "conectando…") que hay que volver a traducir al cambiar de idioma.
const dynamic = new Map();

function setText(sel, key, params, ok = false) {
  dynamic.set(sel, { key, params, ok });
  paintText(sel);
}

function paintText(sel) {
  const el = $(sel);
  const entry = dynamic.get(sel);
  el.textContent = entry?.key ? t(entry.key, entry.params) : '';
  el.classList.toggle('ok', !!entry?.ok);
}

function applyLang() {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'es';
  document.title = t('doc_title');
  $('meta[name="description"]').content = t('doc_desc');
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of document.querySelectorAll('[data-i18n-ph]')) el.placeholder = t(el.dataset.i18nPh);
  for (const el of document.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const sel of dynamic.keys()) paintText(sel);
  render();
}

/* ---------- Palabras ---------- */

const ARTICLES = /^(el|la|los|las|lo|un|una|unos|unas)\s+/;

// Clave de comparación: sin mayúsculas, tildes, signos ni artículo inicial (la ñ se respeta).
function norm(word) {
  return String(word)
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/ñ/g, 'ñ')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(ARTICLES, '');
}

function cleanWord(raw) {
  return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_WORD);
}

function usedWords(history) {
  const seen = new Map();
  for (const entry of history) {
    for (const w of entry.words) {
      const key = norm(w.word);
      if (key && !seen.has(key)) seen.set(key, w.word);
    }
  }
  return seen;
}

function wordError(word, history) {
  if (!norm(word)) return { key: 'err_empty' };
  const used = usedWords(history);
  if (used.has(norm(word))) return { key: 'err_used', params: { word: used.get(norm(word)) } };
  return null;
}

/* ---------- Anfitrión ---------- */

const host = {
  room: null,
  words: {},          // palabras secretas de la ronda actual
  conns: new Map(),   // id de jugador -> conexión
};

function startHosting(settings, attempt = 0) {
  const code = randomCode();
  const peer = new Peer(PREFIX + code, { debug: 0 });

  peer.on('open', () => {
    app.role = 'host';
    app.peer = peer;
    host.room = {
      code, settings, game: 0, players: [], phase: 'lobby', round: 0,
      endsAt: 0, revealEndsAt: 0, submitted: {}, ready: {}, agree: {},
      history: [], winWords: [], synonym: false,
    };
    hostJoin(me.id, me.name, null);
    setInterval(hostTick, 250);
    window.addEventListener('beforeunload', (e) => {
      if (host.room.players.length > 1) e.preventDefault();
    });
  });

  peer.on('connection', (conn) => {
    let pid = null;
    conn.on('data', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'join') {
        if (!pid) pid = hostJoin(String(msg.id ?? '').slice(0, 40), cleanName(msg.name), conn);
        return;
      }
      if (pid) hostAction(pid, msg);
    });
    conn.on('close', () => {
      if (pid && host.conns.get(pid) === conn) hostLeave(pid);
    });
  });

  peer.on('error', (err) => {
    if (err.type === 'unavailable-id' && attempt < 4) {
      peer.destroy();
      startHosting(settings, attempt + 1);
    } else if (!host.room) {
      peer.destroy();
      backHome('create_fail');
    } else {
      console.warn('PeerJS:', err.type, err);
    }
  });

  peer.on('disconnected', () => {
    if (!peer.destroyed) peer.reconnect();
  });
}

function cleanName(raw) {
  return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 16) || '???';
}

function hostJoin(pid, name, conn) {
  const R = host.room;
  if (!pid) return null;
  let player = R.players.find((p) => p.id === pid);
  if (!player) {
    if (R.phase !== 'lobby') return hostReject(conn, 'err_started');
    if (R.players.length >= R.settings.max) return hostReject(conn, 'err_full');
    const taken = new Set(R.players.map((p) => p.color));
    const color = COLORS.find((c) => !taken.has(c)) || COLORS[R.players.length % COLORS.length];
    player = { id: pid, name, color, online: true };
    R.players.push(player);
  } else {
    player.online = true;
    player.name = name;
  }
  if (conn) host.conns.set(pid, conn);
  if (R.phase === 'lobby' && R.players.length >= R.settings.max) startGame();
  else broadcast();
  return pid;
}

function hostReject(conn, key) {
  if (conn) {
    const send = () => { conn.send({ t: 'error', key }); setTimeout(() => conn.close(), 500); };
    conn.open ? send() : conn.on('open', send);
  }
  return null;
}

function hostLeave(pid) {
  const R = host.room;
  host.conns.delete(pid);
  if (R.phase === 'lobby') {
    R.players = R.players.filter((p) => p.id !== pid);
  } else {
    const player = R.players.find((p) => p.id === pid);
    if (player) player.online = false;
  }
  if (!checkProgress()) broadcast();
}

// Solo se puede votar "es lo mismo" si todos escribieron algo en la última ronda.
function canAgree(R) {
  const last = R.history[R.history.length - 1];
  return !!last && last.words.every((w) => w.word);
}

function hostAction(pid, msg) {
  const R = host.room;
  switch (msg.t) {
    case 'word': {
      if (R.phase !== 'thinking' || R.submitted[pid]) return;
      const word = cleanWord(msg.word);
      const err = wordError(word, R.history);
      if (err) return reply(pid, { t: 'reject', err });
      host.words[pid] = word;
      R.submitted[pid] = true;
      reply(pid, { t: 'accepted', word });
      if (!checkProgress()) broadcast();
      break;
    }
    case 'next':
      if (R.phase !== 'reveal') return;
      R.ready[pid] = true;
      delete R.agree[pid];
      if (!checkProgress()) broadcast();
      break;
    case 'agree':
      if (R.phase !== 'reveal' || !canAgree(R)) return;
      R.agree[pid] = true;
      delete R.ready[pid];
      if (!checkProgress()) broadcast();
      break;
    case 'start':
      if (pid === me.id && R.phase === 'lobby' && R.players.length >= 2) startGame();
      break;
    case 'again':
      if (pid !== me.id || R.phase !== 'won') return;
      R.players = R.players.filter((p) => p.online);
      if (R.players.length >= R.settings.max) startGame();
      else { R.phase = 'lobby'; broadcast(); }
      break;
  }
}

function checkProgress() {
  const R = host.room;
  const online = R.players.filter((p) => p.online);
  if (R.phase === 'thinking' && online.every((p) => R.submitted[p.id])) { reveal(); return true; }
  if (R.phase === 'reveal') {
    if (online.every((p) => R.agree[p.id])) { winBySynonym(); return true; }
    if (online.every((p) => R.ready[p.id] || R.agree[p.id])) { nextRound(); return true; }
  }
  return false;
}

function startGame() {
  const R = host.room;
  R.game += 1;
  R.round = 0;
  R.history = [];
  R.winWords = [];
  R.synonym = false;
  nextRound();
}

function nextRound() {
  const R = host.room;
  R.round += 1;
  R.phase = 'thinking';
  R.submitted = {};
  R.ready = {};
  R.agree = {};
  host.words = {};
  R.endsAt = Date.now() + R.settings.seconds * 1000;
  broadcast();
}

function reveal() {
  const R = host.room;
  const words = R.players.map((p) => ({ id: p.id, name: p.name, color: p.color, word: host.words[p.id] || '' }));
  R.history.push({ round: R.round, words });
  const keys = words.map((w) => norm(w.word));
  if (keys.length > 1 && keys.every((k) => k && k === keys[0])) {
    R.phase = 'won';
    R.winWords = [words[0].word];
  } else {
    R.phase = 'reveal';
    R.ready = {};
    R.agree = {};
    R.revealEndsAt = Date.now() + REVEAL_MS;
  }
  broadcast();
}

function winBySynonym() {
  const R = host.room;
  const last = R.history[R.history.length - 1];
  const unique = new Map();
  for (const w of last.words) if (!unique.has(norm(w.word))) unique.set(norm(w.word), w.word);
  R.phase = 'won';
  R.synonym = true;
  R.winWords = [...unique.values()];
  broadcast();
}

function hostTick() {
  const R = host.room;
  if (R.phase === 'thinking' && Date.now() >= R.endsAt) reveal();
  // Mientras alguien proponga que es lo mismo, la cuenta atrás espera a que decidan todos.
  else if (R.phase === 'reveal' && Object.keys(R.agree).length === 0 && Date.now() >= R.revealEndsAt) nextRound();
}

function reply(pid, msg) {
  if (pid === me.id) onMessage(msg);
  else host.conns.get(pid)?.send(msg);
}

function broadcast() {
  const msg = { t: 'state', room: host.room, now: Date.now() };
  for (const conn of host.conns.values()) if (conn.open) conn.send(msg);
  onMessage(msg);
}

/* ---------- Invitado ---------- */

function joinRoom(code) {
  showView('connecting', 'joining', { code });
  const peer = new Peer({ debug: 0 });
  let opened = false;

  const giveUp = setTimeout(() => {
    if (!opened) { peer.destroy(); backHome('join_timeout', { code }); }
  }, 25000);

  peer.on('open', () => {
    const conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
    conn.on('open', () => {
      opened = true;
      clearTimeout(giveUp);
      app.role = 'guest';
      app.peer = peer;
      app.conn = conn;
      conn.send({ t: 'join', id: me.id, name: me.name });
    });
    conn.on('data', onMessage);
    conn.on('close', () => {
      if (opened && !app.closed) closeRoom();
    });
  });

  peer.on('error', (err) => {
    if (opened) { console.warn('PeerJS:', err.type, err); return; }
    clearTimeout(giveUp);
    peer.destroy();
    if (err.type === 'peer-unavailable') backHome('no_room', { code });
    else backHome('net_fail');
  });
}

function send(msg) {
  if (app.role === 'host') hostAction(me.id, msg);
  else if (app.conn?.open) app.conn.send(msg);
}

/* ---------- Estado local e interfaz ---------- */

const app = {
  role: null, peer: null, conn: null, room: null, offset: 0,
  roundKey: null, myWord: null, pending: false, closed: false, celebrated: null,
};

const VIEWS = ['home', 'connecting', 'lobby', 'think', 'reveal', 'won', 'closed'];

function showView(name, connectingKey, params) {
  for (const v of VIEWS) $('#v-' + v).hidden = v !== name;
  if (connectingKey) setText('#connecting-text', connectingKey, params);
}

function onMessage(msg) {
  switch (msg.t) {
    case 'state':
      app.offset = msg.now - Date.now();
      app.room = msg.room;
      render();
      break;
    case 'accepted':
      app.myWord = msg.word;
      app.pending = false;
      renderThinking();
      break;
    case 'reject':
      app.pending = false;
      setText('#word-msg', msg.err?.key, msg.err?.params);
      $('#word').disabled = false;
      $('#btn-word').disabled = false;
      $('#word').focus();
      break;
    case 'error':
      app.closed = true;
      app.peer?.destroy();
      backHome(msg.key);
      break;
  }
}

function hostNow() { return Date.now() + app.offset; }

function inviteLink(code) {
  return `${location.origin}${location.pathname}?sala=${code}`;
}

function render() {
  const R = app.room;
  if (!R || app.closed) return;
  $('#room-pill').hidden = false;
  $('#room-pill-code').textContent = R.code;

  const view = { lobby: 'lobby', thinking: 'think', reveal: 'reveal', won: 'won' }[R.phase];
  showView(view);
  if (R.phase === 'lobby') renderLobby();
  if (R.phase === 'thinking') renderThinking();
  if (R.phase === 'reveal') renderReveal();
  if (R.phase === 'won') renderWon();
  tick();
}

function avatar(p) {
  return `<span class="avatar" style="background:${esc(p.color)}">${esc([...p.name][0]?.toUpperCase() || '?')}</span>`;
}

function renderLobby() {
  const R = app.room;
  const missing = R.settings.max - R.players.length;
  $('#lobby-tag').textContent = t('lobby_tag', { max: R.settings.max, secs: R.settings.seconds });
  $('#lobby-text').textContent = missing > 0
    ? t('lobby_wait', { n: R.players.length, max: R.settings.max })
    : t('lobby_full');
  $('#lobby-code').innerHTML = [...R.code].map((c) => `<span>${esc(c)}</span>`).join('');

  let html = R.players.map((p) => `<li>${avatar(p)}<span>${esc(p.name)}${p.id === me.id ? ` <small>${esc(t('you'))}</small>` : ''}${p.id === R.players[0]?.id ? ` <small>${esc(t('host_tag'))}</small>` : ''}</span></li>`).join('');
  for (let i = 0; i < missing; i++) html += `<li class="empty"><span class="avatar">?</span>${esc(t('waiting_slot'))}</li>`;
  $('#lobby-players').innerHTML = html;

  const canStart = app.role === 'host' && missing > 0 && R.players.length >= 2;
  $('#btn-start-now').hidden = !canStart;
  $('#btn-start-now').textContent = t('start_now', { n: R.players.length });
}

function wordChip(w) {
  return w.word
    ? `<span class="word-chip"><i style="background:${esc(w.color)}"></i>${esc(w.word)}</span>`
    : `<span class="word-chip none"><i style="background:${esc(w.color)}"></i>${esc(t('no_word'))}</span>`;
}

function renderThinking() {
  const R = app.room;
  if (!R || R.phase !== 'thinking') return;
  const key = `${R.game}:${R.round}`;
  const input = $('#word');
  const button = $('#btn-word');

  if (app.roundKey !== key) {
    app.roundKey = key;
    app.myWord = null;
    app.pending = false;
    input.value = '';
    setText('#word-msg', null);
    setTimeout(() => input.focus(), 50);
  }

  $('#t-round').innerHTML = t('round_badge', { n: R.round });
  const last = R.history[R.history.length - 1];
  if (!last) {
    $('#t-hint-title').textContent = t('first_title');
    $('#t-hint').innerHTML = '';
    $('#t-hint-sub').textContent = t('first_sub');
  } else {
    $('#t-hint-title').textContent = t('connect_title');
    $('#t-hint').innerHTML = last.words.map(wordChip).join('');
    $('#t-hint-sub').textContent = t('connect_sub');
  }

  const mine = R.submitted[me.id];
  input.disabled = !!mine || app.pending;
  button.disabled = !!mine || app.pending;
  button.textContent = mine ? t('sent') : t('btn_send');
  button.classList.toggle('done', !!mine);
  if (mine && app.myWord) {
    input.value = app.myWord;
    setText('#word-msg', 'saved', null, true);
  }

  $('#t-players').innerHTML = R.players.map((p) => {
    const sent = R.submitted[p.id];
    const status = !p.online ? t('st_off') : sent ? t('st_sent') : t('st_thinking');
    return `<li class="${sent ? 'sent' : ''} ${p.online ? '' : 'offline'}">${avatar(p)}<span>${esc(p.name)}${p.id === me.id ? esc(t('you_paren')) : ''}<small>${esc(status)}</small></span></li>`;
  }).join('');

  const used = [...usedWords(R.history).values()];
  $('#used-box').hidden = used.length === 0;
  $('#used-title').textContent = t('used_title', { n: used.length });
  $('#used-list').innerHTML = used.map((w) => `<span class="w">${esc(w)}</span>`).join('');
}

function renderReveal() {
  const R = app.room;
  const last = R.history[R.history.length - 1];
  const keys = last.words.map((w) => norm(w.word));
  const counts = {};
  for (const k of keys) if (k) counts[k] = (counts[k] || 0) + 1;
  const best = Math.max(0, ...Object.values(counts));

  $('#r-tag').textContent = t('round_tag', { n: last.round });
  if (best >= 2) {
    $('#r-title').textContent = t('almost');
    $('#r-text').textContent = t('almost_text', { best, total: keys.length });
  } else {
    $('#r-title').textContent = keys.some((k) => !k) ? t('timeout') : t('nomatch');
    const named = last.words.filter((w) => w.word).map((w) => t('quote', { w: w.word }));
    $('#r-text').textContent = named.length > 1 ? t('next_join', { list: joinList(named) }) : t('next_generic');
  }

  const cardsKey = `${R.game}:${last.round}:${lang}`;
  if ($('#r-cards').dataset.key !== cardsKey) {
    $('#r-cards').dataset.key = cardsKey;
    $('#r-cards').innerHTML = last.words.map((w, i) => {
      const k = norm(w.word);
      const match = k && counts[k] >= 2;
      return `<article class="rcard ${match ? 'match' : ''}" style="animation-delay:${i * 180}ms">
        <header style="background:${esc(w.color)}">${avatar({ ...w, color: 'transparent' })}${esc(w.name)}</header>
        <div class="rw ${w.word ? '' : 'none'}">${esc(w.word || t('no_word'))}</div>
      </article>`;
    }).join('');
  }

  const online = R.players.filter((p) => p.online);
  const agreeing = online.filter((p) => R.agree[p.id]);
  const readyCount = online.filter((p) => R.ready[p.id]).length;
  const choice = R.agree[me.id] ? 'agree' : R.ready[me.id] ? 'next' : null;

  const agreeBtn = $('#btn-agree');
  agreeBtn.hidden = !canAgree(R);
  agreeBtn.disabled = choice === 'agree';
  agreeBtn.classList.toggle('done', choice === 'agree');
  agreeBtn.textContent = choice === 'agree' ? t('agreed', { n: agreeing.length, m: online.length }) : t('btn_agree');

  const nextBtn = $('#btn-next');
  nextBtn.disabled = choice === 'next';
  nextBtn.classList.toggle('done', choice === 'next');
  nextBtn.textContent = choice === 'next' ? t('ready', { n: readyCount, m: online.length }) : t('btn_next');

  $('#r-agree-hint').hidden = !canAgree(R);
  $('#r-agree-hint').textContent = agreeing.length
    ? t('agree_votes', { names: joinList(agreeing.map((p) => p.name)), n: agreeing.length, m: online.length })
    : t('agree_hint');
}

function renderWon() {
  const R = app.room;
  $('#w-title').innerHTML = R.synonym
    ? t('won_syn', { n: R.round })
    : R.round === 1 ? t('won_first') : t('won_round', { n: R.round });
  $('#w-word').textContent = R.winWords.join(' ≈ ');
  $('#w-history').innerHTML = R.history.map((h, i) => `
    <li class="${i === R.history.length - 1 ? 'last' : ''}">
      <span class="rn">${esc(t('round_tag', { n: h.round }))}</span>
      <span class="ws">${h.words.map(wordChip).join('')}</span>
    </li>`).join('');
  $('#btn-again').hidden = app.role !== 'host';
  $('#w-wait').hidden = app.role === 'host';

  const key = `${R.game}`;
  if (app.celebrated !== key) { app.celebrated = key; confetti(); }
}

const SHARE_ROUNDS = 8;

// Texto para pegar en un chat: cabecera, las rondas con sus palabras y el enlace al juego.
function resultText() {
  const R = app.room;
  const head = R.synonym
    ? t('share_head_syn', { n: R.round })
    : R.round === 1 ? t('share_first') : t('share_head', { n: R.round });
  const rounds = R.history.slice(-SHARE_ROUNDS).map((h, i, list) => {
    const isLast = i === list.length - 1;
    const sep = isLast ? (R.synonym ? ' ≈ ' : ' = ') : ' · ';
    return `${t('share_round', { n: h.round })}${h.words.map((w) => w.word || '—').join(sep)}${isLast ? ' ✨' : ''}`;
  });
  if (R.history.length > SHARE_ROUNDS) rounds.unshift('…');
  const url = `${location.origin}${location.pathname}${lang === 'zh' ? '?lang=zh' : ''}`;
  return [head, '', ...rounds, '', t('share_cta', { url })].join('\n');
}

async function shareResult() {
  const text = resultText();
  const btn = $('#btn-share');
  // En el móvil abre el menú de compartir del sistema (WhatsApp, Telegram…); en el ordenador, copia.
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ text });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = t('share_copied');
    btn.classList.add('done');
    setTimeout(() => { btn.textContent = t('btn_share'); btn.classList.remove('done'); }, 2500);
  } catch {
    window.prompt(t('share_prompt'), text);
  }
}

function tick() {
  const R = app.room;
  if (!R || app.closed) return;
  if (R.phase === 'thinking') {
    const total = R.settings.seconds * 1000;
    const left = Math.max(0, R.endsAt - hostNow());
    const secs = Math.ceil(left / 1000);
    $('#t-secs').textContent = secs;
    $('#t-bar').style.strokeDashoffset = String(263.9 * (1 - left / total));
    $('#t-timer').classList.toggle('low', secs <= 5);
    $('#t-timer').setAttribute('aria-label', t('timer_aria', { s: secs }));
  } else if (R.phase === 'reveal') {
    const secs = Math.max(0, Math.ceil((R.revealEndsAt - hostNow()) / 1000));
    $('#r-next-info').textContent = Object.keys(R.agree).length ? t('paused') : t('auto_next', { s: secs });
  }
}

function shake(el) {
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
}

function confetti() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const box = $('#confetti');
  const colors = ['#ff5b3a', '#2f4bff', '#ffc93c', '#2fbf83', '#ff9fcb'];
  for (let i = 0; i < 90; i++) {
    const piece = document.createElement('i');
    const dur = 2.2 + Math.random() * 2;
    piece.style.left = `${Math.random() * 100}vw`;
    piece.style.background = colors[i % colors.length];
    piece.style.setProperty('--dx', `${(Math.random() - .5) * 240}px`);
    piece.style.setProperty('--rot', `${(Math.random() - .5) * 1080}deg`);
    piece.style.animationDuration = `${dur}s`;
    piece.style.animationDelay = `${Math.random() * .6}s`;
    box.appendChild(piece);
    setTimeout(() => piece.remove(), (dur + 1) * 1000);
  }
}

function closeRoom() {
  app.closed = true;
  const label = $('#conn-label');
  label.dataset.i18n = 'conn_off';
  label.textContent = t('conn_off');
  $('.live').classList.add('off');
  showView('closed');
}

function backHome(key, params) {
  $('#room-pill').hidden = true;
  showView('home');
  setText('#home-msg', key, params);
}

/* ---------- Inicio: formulario ---------- */

function setupSeg(sel, onChange) {
  const seg = $(sel);
  seg.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-checked', String(b === btn));
    onChange?.(btn.dataset.v);
  });
}
const segValue = (sel) => $(`${sel} [aria-checked="true"]`).dataset.v;

function readName() {
  const input = $('#name');
  const name = cleanName(input.value);
  if (!input.value.trim()) {
    setText('#home-msg', 'need_name');
    shake(input);
    input.focus();
    return null;
  }
  me.name = name;
  save('local', 'mp-name', name);
  return name;
}

function readSettings() {
  let seconds = Number(segValue('#seg-time'));
  if (Number.isNaN(seconds)) {
    seconds = Math.round(Number($('#custom-time').value));
    if (!(seconds >= 10 && seconds <= 300)) {
      setText('#home-msg', 'bad_custom');
      shake($('#custom-time'));
      return null;
    }
  }
  return { seconds, max: Number(segValue('#seg-players')) };
}

function peerAvailable() {
  if (typeof Peer === 'function') return true;
  setText('#home-msg', 'no_peer');
  return false;
}

function normalizeCode(raw) {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

function init() {
  $('#name').value = me.name;
  setupSeg('#seg-time', (v) => { $('#custom-wrap').hidden = v !== 'custom'; });
  setupSeg('#seg-players');

  $('#btn-lang').addEventListener('click', () => {
    lang = lang === 'es' ? 'zh' : 'es';
    save('local', 'mp-lang', lang);
    const params = new URLSearchParams(location.search);
    if (params.has('lang')) {
      params.delete('lang');
      history.replaceState(null, '', location.pathname + (params.size ? `?${params}` : ''));
    }
    applyLang();
  });

  $('#btn-create').addEventListener('click', () => {
    if (!readName() || !peerAvailable()) return;
    const settings = readSettings();
    if (!settings) return;
    setText('#home-msg', null);
    showView('connecting', 'creating');
    startHosting(settings);
  });

  $('#join-code').addEventListener('input', (e) => { e.target.value = normalizeCode(e.target.value); });
  $('#form-join').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = normalizeCode($('#join-code').value);
    if (!readName()) return;
    if (code.length !== 6) {
      setText('#home-msg', 'bad_code');
      shake($('#join-code'));
      return;
    }
    if (peerAvailable()) joinRoom(code);
  });

  const invited = normalizeCode(new URLSearchParams(location.search).get('sala'));
  if (invited.length === 6) {
    $('#start-card').classList.add('inviting');
    $('#invite').hidden = false;
    $('#invite-code').textContent = invited;
    $('#join-code').value = invited;
    $('#btn-join-invite').addEventListener('click', () => {
      if (readName() && peerAvailable()) joinRoom(invited);
    });
    $('#name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join-invite').click(); });
    $('#btn-show-create').addEventListener('click', () => {
      $('#start-card').classList.remove('inviting');
      $('#invite').hidden = true;
      history.replaceState(null, '', location.pathname);
    });
    if (!me.name) $('#name').focus();
  }

  $('#btn-copy').addEventListener('click', async () => {
    const link = inviteLink(app.room.code);
    const btn = $('#btn-copy');
    try {
      await navigator.clipboard.writeText(link);
      btn.textContent = t('copied');
    } catch {
      window.prompt(t('copy_prompt'), link);
    }
    setTimeout(() => { btn.textContent = t('btn_copy'); }, 2000);
  });

  $('#btn-start-now').addEventListener('click', () => send({ t: 'start' }));

  $('#form-word').addEventListener('submit', (e) => {
    e.preventDefault();
    const R = app.room;
    if (!R || R.phase !== 'thinking' || R.submitted[me.id]) return;
    const word = cleanWord($('#word').value);
    const err = wordError(word, R.history);
    if (err) {
      setText('#word-msg', err.key, err.params);
      shake($('#word'));
      return;
    }
    app.pending = true;
    $('#word').disabled = true;
    $('#btn-word').disabled = true;
    setText('#word-msg', null);
    send({ t: 'word', word });
  });

  $('#btn-next').addEventListener('click', () => send({ t: 'next' }));
  $('#btn-agree').addEventListener('click', () => send({ t: 'agree' }));
  $('#btn-again').addEventListener('click', () => send({ t: 'again' }));
  $('#btn-share').addEventListener('click', shareResult);

  applyLang();
  setInterval(tick, 200);
}

init();
