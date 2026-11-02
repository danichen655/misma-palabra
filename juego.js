/*
 * Misma Palabra — interfaz del juego.
 * Las salas viven en el servidor (backend/sala.js, Cloudflare Durable Objects):
 * cada jugador se conecta por WebSocket, recibe el estado completo tras cada
 * cambio y envía sus acciones. Si se corta la conexión (cobertura, cambiar de
 * app en el móvil, recargar), la web vuelve a conectarse sola a la misma sala.
 */

import { TEXTS } from './textos.js';
import { canAgree, cleanName, cleanWord, isCode, norm, randomCode, usedWords, wordError } from './reglas.js';

const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const SERVER = LOCAL ? `ws://${location.hostname}:8787` : 'wss://misma-palabra.misma-palabra.workers.dev';
const STATS_URL = `${SERVER.replace(/^ws/, 'http')}/estadisticas`;
const STATS_REFRESH_MS = 60000;
const PING_MS = 25000;
const STALE_MS = 60000;
const SHARE_ROUNDS = 8;

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function load(key) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function save(key, value) {
  try { window.localStorage.setItem(key, value); } catch { /* sin almacenamiento */ }
}

const me = { id: null, name: load('mp-name') || '' };

function newId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Recuerda con qué identidad entraste en la última sala para poder volver a ella.
function savedRoom() {
  try { return JSON.parse(load('mp-sala') || 'null'); } catch { return null; }
}

/* ---------- Idioma ---------- */

let lang = (() => {
  // Un enlace compartido desde la versión china lleva ?lang=zh.
  const fromUrl = new URLSearchParams(location.search).get('lang');
  if (fromUrl === 'es' || fromUrl === 'zh') return fromUrl;
  const saved = load('mp-lang');
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
  renderGlobalStats();
  render();
}

/* ---------- Contador global (portada) ---------- */

async function loadGlobalStats() {
  try {
    const res = await fetch(STATS_URL);
    if (!res.ok) return;
    app.globalStats = await res.json();
    renderGlobalStats();
  } catch { /* sin contador: la portada funciona igual */ }
}

function renderGlobalStats() {
  const stats = app.globalStats;
  $('#global-stats').hidden = !stats?.played;
  if (!stats?.played) return;
  const fmt = new Intl.NumberFormat(lang === 'zh' ? 'zh-CN' : 'es-ES');
  $('#gs-played').textContent = fmt.format(stats.played);
  $('#gs-matched').textContent = fmt.format(stats.matched);
}

/* ---------- Conexión con el servidor de salas ---------- */

const conn = {
  ws: null, code: null, create: null, joined: false,
  retries: 0, timer: null, ping: null, lastSeen: 0,
};

function connect() {
  clearTimeout(conn.timer);
  const params = new URLSearchParams({ id: me.id, nombre: me.name });
  if (conn.create) {
    params.set('crear', '1');
    params.set('segundos', conn.create.seconds);
    params.set('max', conn.create.max);
  }
  const ws = new WebSocket(`${SERVER}/sala/${conn.code}?${params}`);
  conn.ws = ws;

  ws.onopen = () => {
    if (conn.ws !== ws) return;
    conn.retries = 0;
    conn.lastSeen = Date.now();
    // Si se cortó con una palabra en camino, el estado que llega ahora dice si el servidor la recibió.
    app.pending = false;
    clearInterval(conn.ping);
    conn.ping = setInterval(() => {
      // Si el servidor lleva mucho sin contestar, la conexión está muerta aunque no lo parezca.
      if (Date.now() - conn.lastSeen > STALE_MS) ws.close();
      else if (ws.readyState === WebSocket.OPEN) ws.send('ping');
    }, PING_MS);
  };

  ws.onmessage = (e) => {
    if (conn.ws !== ws) return;
    conn.lastSeen = Date.now();
    if (e.data === 'pong') return;
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    onMessage(msg);
  };

  ws.onclose = (e) => {
    if (conn.ws !== ws) return;
    clearInterval(conn.ping);
    conn.ws = null;
    if (e.code === 4001) {
      // La sala ha rechazado la entrada.
      if (e.reason === 'code_taken' && conn.create) { conn.code = randomCode(); connect(); return; }
      leave(e.reason || 'net_fail', { code: conn.code });
      return;
    }
    if (e.code === 4000) { pauseHere(); return; }
    conn.retries += 1;
    if (!conn.joined && conn.retries > 4) {
      leave(conn.create ? 'create_fail' : 'join_timeout', { code: conn.code });
      return;
    }
    setOnline(false);
    conn.timer = setTimeout(connect, Math.min(10000, 500 * 2 ** conn.retries));
  };
}

// Al volver a la pestaña (p. ej. después de mandar el enlace por WhatsApp) se reconecta enseguida.
function wakeUp() {
  if (!conn.code || app.closed) return;
  if (!conn.ws) {
    conn.retries = 0;
    connect();
  } else if (conn.ws.readyState === WebSocket.OPEN && Date.now() - conn.lastSeen > PING_MS) {
    const ws = conn.ws;
    const before = conn.lastSeen;
    ws.send('ping');
    setTimeout(() => { if (conn.ws === ws && conn.lastSeen === before) ws.close(); }, 3000);
  }
}

function send(msg) {
  if (conn.ws?.readyState !== WebSocket.OPEN) return false;
  conn.ws.send(JSON.stringify(msg));
  return true;
}

function startCreate(settings) {
  me.id = newId();
  Object.assign(conn, { code: randomCode(), create: settings, joined: false, retries: 0 });
  showView('connecting', 'creating');
  connect();
}

function startJoin(code) {
  const saved = savedRoom();
  me.id = saved?.code === code && saved.id ? saved.id : newId();
  Object.assign(conn, { code, create: null, joined: false, retries: 0 });
  showView('connecting', 'joining', { code });
  connect();
}

function leave(key, params) {
  clearTimeout(conn.timer);
  Object.assign(conn, { code: null, create: null, joined: false });
  if (key === 'no_room' && savedRoom()?.code === params?.code) save('mp-sala', 'null');
  app.room = null;
  backHome(key, params);
}

/* ---------- Estado local e interfaz ---------- */

const app = {
  room: null, globalStats: null, offset: 0, roundKey: null, myWord: null, pending: false, closed: false, celebrated: null,
};

const VIEWS = ['home', 'connecting', 'lobby', 'think', 'reveal', 'won', 'closed'];

function showView(name, connectingKey, params) {
  for (const v of VIEWS) $('#v-' + v).hidden = v !== name;
  if (connectingKey) setText('#connecting-text', connectingKey, params);
}

function onMessage(msg) {
  switch (msg.t) {
    case 'state':
      if (!conn.joined) {
        conn.joined = true;
        conn.create = null;
        save('mp-sala', JSON.stringify({ code: msg.room.code, id: me.id }));
        // La URL de la sala permite volver a ella al recargar.
        const params = new URLSearchParams(location.search);
        params.set('sala', msg.room.code);
        history.replaceState(null, '', `${location.pathname}?${params}`);
      }
      setOnline(true);
      app.offset = msg.now - Date.now();
      app.room = msg.room;
      app.myWord = msg.mine ?? null;
      if (msg.mine) app.pending = false;
      render();
      break;
    case 'reject':
      app.pending = false;
      setText('#word-msg', msg.err?.key, msg.err?.params);
      $('#word').disabled = false;
      $('#btn-word').disabled = false;
      $('#word').focus();
      break;
  }
}

function hostNow() { return Date.now() + app.offset; }

const isHost = () => app.room?.hostId === me.id;

function setOnline(on) {
  const label = $('#conn-label');
  label.dataset.i18n = on ? 'conn_online' : 'conn_reconnecting';
  label.textContent = t(label.dataset.i18n);
  $('.live').classList.toggle('off', !on);
}

// Quien juega en chino comparte la entrada /zh/, así la vista previa del enlace sale en chino.
function shareBase() {
  const base = location.origin + location.pathname.replace(/[^/]*$/, '');
  return lang === 'zh' ? `${base}zh/` : base;
}

function inviteLink(code) {
  return `${shareBase()}?sala=${code}`;
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
  const online = R.players.filter((p) => p.online).length;
  $('#lobby-tag').textContent = t('lobby_tag', { max: R.settings.max, secs: R.settings.seconds });
  $('#lobby-text').textContent = missing > 0
    ? t('lobby_wait', { n: R.players.length, max: R.settings.max })
    : t('lobby_full');
  $('#lobby-code').innerHTML = [...R.code].map((c) => `<span>${esc(c)}</span>`).join('');

  let html = R.players.map((p) => {
    const tags = [p.id === me.id && t('you'), p.id === R.hostId && t('host_tag'), !p.online && t('st_off')].filter(Boolean);
    return `<li class="${p.online ? '' : 'offline'}">${avatar(p)}<span>${esc(p.name)}${tags.map((x) => ` <small>${esc(x)}</small>`).join('')}</span></li>`;
  }).join('');
  for (let i = 0; i < missing; i++) html += `<li class="empty"><span class="avatar">?</span>${esc(t('waiting_slot'))}</li>`;
  $('#lobby-players').innerHTML = html;

  $('#lobby-score').hidden = !R.stats?.played;
  if (R.stats?.played) $('#lobby-score').textContent = t('room_score', R.stats);

  const canStart = isHost() && online >= 2 && online < R.settings.max;
  $('#btn-start-now').hidden = !canStart;
  $('#btn-start-now').textContent = t('start_now', { n: online });
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
  $('#w-score').hidden = !R.stats;
  if (R.stats) $('#w-score').textContent = t('room_score', R.stats);
  $('#btn-again').hidden = !isHost();
  $('#w-wait').hidden = isHost();

  const key = `${R.code}:${R.game}`;
  if (app.celebrated !== key) { app.celebrated = key; confetti(); }
}

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
  return [head, '', ...rounds, '', t('share_cta', { url: shareBase() })].join('\n');
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

// La misma sala se ha abierto en otra pestaña o dispositivo: esta se queda en pausa.
function pauseHere() {
  app.closed = true;
  setOnline(false);
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
  if (!input.value.trim()) {
    setText('#home-msg', 'need_name');
    shake(input);
    input.focus();
    return null;
  }
  me.name = cleanName(input.value);
  save('mp-name', me.name);
  return me.name;
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

function normalizeCode(raw) {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

function init() {
  $('#name').value = me.name;
  setupSeg('#seg-time', (v) => { $('#custom-wrap').hidden = v !== 'custom'; });
  setupSeg('#seg-players');

  $('#btn-lang').addEventListener('click', () => {
    lang = lang === 'es' ? 'zh' : 'es';
    save('mp-lang', lang);
    const params = new URLSearchParams(location.search);
    if (params.has('lang')) {
      params.delete('lang');
      history.replaceState(null, '', location.pathname + (params.size ? `?${params}` : ''));
    }
    applyLang();
  });

  $('#btn-create').addEventListener('click', () => {
    if (!readName()) return;
    const settings = readSettings();
    if (!settings) return;
    setText('#home-msg', null);
    startCreate(settings);
  });

  $('#join-code').addEventListener('input', (e) => { e.target.value = normalizeCode(e.target.value); });
  $('#form-join').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = normalizeCode($('#join-code').value);
    if (!readName()) return;
    if (!isCode(code)) {
      setText('#home-msg', 'bad_code');
      shake($('#join-code'));
      return;
    }
    startJoin(code);
  });

  const invited = normalizeCode(new URLSearchParams(location.search).get('sala'));
  if (isCode(invited)) {
    if (savedRoom()?.code === invited && me.name) {
      // Ya estabas en esta sala (has recargado o el móvil cerró la pestaña): vuelves directamente.
      startJoin(invited);
    } else {
      $('#start-card').classList.add('inviting');
      $('#invite').hidden = false;
      $('#invite-code').textContent = invited;
      $('#join-code').value = invited;
      if (!me.name) $('#name').focus();
    }
    $('#btn-join-invite').addEventListener('click', () => {
      if (readName()) startJoin(invited);
    });
    $('#name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join-invite').click(); });
    $('#btn-show-create').addEventListener('click', () => {
      $('#start-card').classList.remove('inviting');
      $('#invite').hidden = true;
      history.replaceState(null, '', location.pathname);
    });
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
    if (!send({ t: 'word', word })) {
      setText('#word-msg', 'offline_msg');
      return;
    }
    app.pending = true;
    $('#word').disabled = true;
    $('#btn-word').disabled = true;
    setText('#word-msg', null);
  });

  $('#btn-next').addEventListener('click', () => send({ t: 'next' }));
  $('#btn-agree').addEventListener('click', () => send({ t: 'agree' }));
  $('#btn-again').addEventListener('click', () => send({ t: 'again' }));
  $('#btn-share').addEventListener('click', shareResult);
  $('#btn-reclaim').addEventListener('click', () => {
    app.closed = false;
    conn.retries = 0;
    connect();
  });

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wakeUp(); });
  window.addEventListener('online', wakeUp);
  window.addEventListener('pageshow', (e) => { if (e.persisted) wakeUp(); });

  applyLang();
  setInterval(tick, 200);
  loadGlobalStats();
  setInterval(() => { if (!$('#v-home').hidden && document.visibilityState === 'visible') loadGlobalStats(); }, STATS_REFRESH_MS);
}

init();
