/*
 * Servidor de salas de Misma Palabra (Cloudflare Workers + Durable Objects).
 *
 * Cada sala es un Durable Object identificado por su código. Los jugadores se
 * conectan por WebSocket a /sala/CÓDIGO; la sala guarda el estado en su
 * almacenamiento, avanza las rondas con alarmas y reenvía el estado a todos
 * tras cada cambio. Las palabras de la ronda en curso no salen de aquí hasta
 * revelarlas. Los WebSockets usan la API de hibernación, así la sala no
 * consume nada mientras nadie hace nada.
 */

import { DurableObject } from 'cloudflare:workers';
import { COLORS, REVEAL_MS, canAgree, cleanName, cleanWord, isCode, norm, wordError } from '../reglas.js';

const EMPTY_TTL_MS = 2 * 60 * 60 * 1000;   // una sala vacía se borra a las 2 h
const IDLE_MS = 5 * 60 * 1000;             // sala de espera sin nadie nuevo, o partida en pausa: se cierra a los 5 min
const MAX_MESSAGE = 2000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/sala\/([A-Z0-9]{6})$/);
    if (match && isCode(match[1])) {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Se esperaba un WebSocket', { status: 426 });
      return env.SALAS.get(env.SALAS.idFromName(match[1])).fetch(request);
    }
    if (url.pathname === '/estadisticas') {
      const stats = await contador(env).leer();
      return Response.json(stats, { headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=30' } });
    }
    if (url.pathname === '/') return new Response('Misma Palabra · servidor de salas\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    return new Response('No encontrado\n', { status: 404 });
  },
};

const contador = (env) => env.CONTADOR.get(env.CONTADOR.idFromName('global'));

// Totales de todas las salas: partidas empezadas y partidas que acabaron en coincidencia.
export class Contador extends DurableObject {
  async sumar(campo) {
    if (campo !== 'played' && campo !== 'matched') return;
    await this.ctx.storage.put(campo, ((await this.ctx.storage.get(campo)) ?? 0) + 1);
  }

  async leer() {
    const values = await this.ctx.storage.get(['played', 'matched']);
    return { played: values.get('played') ?? 0, matched: values.get('matched') ?? 0 };
  }
}

export class Sala extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // El latido del cliente se contesta sin despertar la sala.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get('room')) ?? null;
      this.words = (await ctx.storage.get('words')) ?? {};
    });
    this.pendingStats = [];   // sumas para el contador global, se envían en commit()
    this.alarmAt = undefined; // hora de la alarma programada (desconocida tras despertar)
  }

  // En local se puede acortar para probar: wrangler dev --var IDLE_MS:10000
  idleMs() {
    return Number(this.env.IDLE_MS) || IDLE_MS;
  }

  /* ---------- Conexiones ---------- */

  async fetch(request) {
    const url = new URL(request.url);
    const code = url.pathname.slice(-6);
    const pid = String(url.searchParams.get('id') ?? '').slice(0, 40);
    const name = cleanName(url.searchParams.get('nombre'));

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    const refuse = (key) => {
      server.close(4001, key);
      return new Response(null, { status: 101, webSocket: client });
    };

    if (!/^[\w-]{6,40}$/.test(pid)) return refuse('net_fail');

    if (url.searchParams.get('crear') === '1') {
      if (this.room) return refuse('code_taken');
      const seconds = clamp(url.searchParams.get('segundos'), 10, 300, 30);
      const max = clamp(url.searchParams.get('max'), 2, 6, 2);
      this.room = {
        code, settings: { seconds, max }, game: 0, players: [], hostId: null, phase: 'lobby', round: 0,
        endsAt: 0, revealEndsAt: 0, submitted: {}, ready: {}, agree: {},
        history: [], winWords: [], synonym: false, emptySince: 0, stats: { played: 0, matched: 0 },
        paused: false, closeAt: Date.now() + this.idleMs(),
      };
      this.words = {};
    } else if (!this.room) {
      return refuse('no_room');
    }

    const R = this.room;
    let player = R.players.find((p) => p.id === pid);
    if (!player) {
      if (R.phase !== 'lobby') return refuse('err_started');
      // Los que se fueron de la sala de espera no ocupan sitio.
      if (R.players.length >= R.settings.max) R.players = R.players.filter((p) => this.isOnline(p.id));
      if (R.players.length >= R.settings.max) return refuse('err_full');
      const taken = new Set(R.players.map((p) => p.color));
      player = { id: pid, name, color: COLORS.find((c) => !taken.has(c)) ?? COLORS[0], online: true };
      R.players.push(player);
      R.closeAt = Date.now() + this.idleMs();   // alguien nuevo: la sala de espera vuelve a tener 5 min
    }
    player.name = name;

    // La misma persona abriendo la sala en otra pestaña o tras recargar: se queda la conexión nueva.
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== server && ws.deserializeAttachment()?.pid === pid) ws.close(4000, 'replaced');
    }
    server.serializeAttachment({ pid });

    if (R.phase === 'lobby' && R.players.length >= R.settings.max && R.players.every((p) => this.isOnline(p.id))) {
      this.startGame();
    }
    await this.commit();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, data) {
    if (typeof data !== 'string' || data.length > MAX_MESSAGE || !this.room) return;
    const pid = ws.deserializeAttachment()?.pid;
    if (!pid) return;
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg && typeof msg === 'object' && this.action(pid, msg, ws)) await this.commit();
  }

  async webSocketClose(ws, code) {
    try { ws.close(code >= 3000 ? code : 1000, 'adiós'); } catch { /* ya cerrado */ }
    // Tras expire() la sala ya no existe: no hay nada que guardar.
    if (this.room) await this.commit();
  }

  async webSocketError() {
    if (this.room) await this.commit();
  }

  /* ---------- Reglas ---------- */

  // Devuelve true si cambió el estado.
  action(pid, msg, ws) {
    const R = this.room;
    switch (msg.t) {
      case 'word': {
        if (R.phase !== 'thinking' || R.submitted[pid]) return false;
        const word = cleanWord(msg.word);
        const err = wordError(word, R.history);
        if (err) { ws.send(JSON.stringify({ t: 'reject', err })); return false; }
        this.words[pid] = word;
        R.submitted[pid] = true;
        return true;
      }
      case 'next':
        if (R.phase !== 'reveal') return false;
        R.ready[pid] = true;
        delete R.agree[pid];
        return true;
      case 'agree':
        if (R.phase !== 'reveal' || !canAgree(R)) return false;
        R.agree[pid] = true;
        delete R.ready[pid];
        return true;
      case 'start':
        if (pid !== R.hostId || R.phase !== 'lobby') return false;
        R.players = R.players.filter((p) => this.isOnline(p.id));
        if (R.players.length < 2) return false;
        this.startGame();
        return true;
      case 'again':
        if (pid !== R.hostId || R.phase !== 'won') return false;
        R.players = R.players.filter((p) => this.isOnline(p.id));
        if (R.players.length >= R.settings.max) this.startGame();
        else { R.phase = 'lobby'; R.closeAt = Date.now() + this.idleMs(); }
        return true;
      default:
        return false;
    }
  }

  // Avanza la partida si todos los conectados ya han hecho lo suyo.
  progress() {
    const R = this.room;
    const online = R.players.filter((p) => p.online);
    if (!online.length) return;
    if (R.phase === 'thinking' && online.every((p) => R.submitted[p.id])) this.reveal();
    else if (R.phase === 'reveal') {
      if (online.every((p) => R.agree[p.id])) this.winBySynonym();
      else if (online.every((p) => R.ready[p.id] || R.agree[p.id])) this.nextRound();
    }
  }

  // Suma al marcador de la sala y deja apuntada la misma suma para el contador global.
  count(field) {
    this.room.stats ??= { played: 0, matched: 0 };
    this.room.stats[field] += 1;
    this.pendingStats.push(field);
  }

  startGame() {
    const R = this.room;
    this.count('played');
    R.game += 1;
    R.round = 0;
    R.history = [];
    R.winWords = [];
    R.synonym = false;
    this.nextRound();
  }

  nextRound() {
    const R = this.room;
    R.round += 1;
    R.phase = 'thinking';
    R.submitted = {};
    R.ready = {};
    R.agree = {};
    R.paused = false;
    R.closeAt = 0;
    this.words = {};
    R.endsAt = Date.now() + R.settings.seconds * 1000;
  }

  reveal() {
    const R = this.room;
    const words = R.players.map((p) => ({ id: p.id, name: p.name, color: p.color, word: this.words[p.id] || '' }));
    R.history.push({ round: R.round, words });
    const keys = words.map((w) => norm(w.word));
    if (keys.length > 1 && keys.every((k) => k && k === keys[0])) {
      R.phase = 'won';
      R.winWords = [words[0].word];
      this.count('matched');
    } else {
      R.phase = 'reveal';
      R.ready = {};
      R.agree = {};
      R.revealEndsAt = Date.now() + REVEAL_MS;
      // Si nadie escribió nada, la partida está abandonada: no se avanza sola (evita
      // rondas infinitas con una pestaña olvidada) y se cierra si nadie sigue en 5 min.
      R.paused = keys.every((k) => !k);
      R.closeAt = R.paused ? Date.now() + this.idleMs() : 0;
    }
  }

  winBySynonym() {
    const R = this.room;
    const unique = new Map();
    for (const w of R.history[R.history.length - 1].words) if (!unique.has(norm(w.word))) unique.set(norm(w.word), w.word);
    R.phase = 'won';
    R.synonym = true;
    R.winWords = [...unique.values()];
    this.count('matched');
  }

  async alarm() {
    this.alarmAt = null;   // la alarma que acaba de sonar ya no está programada
    if (!this.room) return;
    const R = this.room;
    const now = Date.now();
    const empty = !this.openSockets().length;
    if ((R.closeAt && now >= R.closeAt) || (empty && R.emptySince && now >= R.emptySince + EMPTY_TTL_MS)) {
      await this.expire();
      return;
    }
    if (empty) {
      // Sin nadie conectado la partida queda congelada hasta que alguien vuelva.
    } else if (R.phase === 'thinking' && now >= R.endsAt) {
      this.reveal();
    } else if (R.phase === 'reveal' && !R.paused && !Object.keys(R.agree).length && now >= R.revealEndsAt) {
      this.nextRound();
    }
    await this.commit();
  }

  // Cierra la sala por inactividad: avisa a quien siga conectado y borra todo.
  async expire() {
    this.room = null;
    this.words = {};
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.close(4001, 'room_expired'); } catch { /* ya cerrado */ }
    }
    this.alarmAt = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /* ---------- Estado ---------- */

  openSockets() {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN && ws.deserializeAttachment()?.pid);
  }

  isOnline(pid) {
    return this.openSockets().some((ws) => ws.deserializeAttachment().pid === pid);
  }

  // Recalcula quién está conectado, avanza si toca, guarda, programa la alarma y avisa a todos.
  async commit() {
    const R = this.room;
    R.stats ??= { played: 0, matched: 0 };   // salas creadas antes de existir el marcador
    const open = this.openSockets();
    const onlineIds = new Set(open.map((ws) => ws.deserializeAttachment().pid));
    for (const p of R.players) p.online = onlineIds.has(p.id);
    R.hostId = R.players.find((p) => p.online)?.id ?? null;
    R.emptySince = open.length ? 0 : (R.emptySince || Date.now());

    this.progress();

    await this.ctx.storage.put({ room: R, words: this.words });
    await this.scheduleAlarm();

    const now = Date.now();
    for (const ws of open) {
      const pid = ws.deserializeAttachment().pid;
      const mine = R.phase === 'thinking' ? this.words[pid] ?? null : null;
      try { ws.send(JSON.stringify({ t: 'state', room: R, now, mine })); } catch { /* se está cerrando */ }
    }

    // El contador global es secundario: si falla, la partida sigue igual.
    for (const field of this.pendingStats.splice(0)) {
      try { await contador(this.env).sumar(field); } catch (err) { console.error('contador', err); }
    }
  }

  // Programa la alarma para lo primero que tenga que pasar; solo escribe si la hora cambia.
  async scheduleAlarm() {
    const R = this.room;
    const times = [];
    if (R.closeAt) times.push(R.closeAt);
    if (R.emptySince) times.push(R.emptySince + EMPTY_TTL_MS);
    else if (R.phase === 'thinking') times.push(R.endsAt);
    else if (R.phase === 'reveal' && !R.paused && !Object.keys(R.agree).length) times.push(R.revealEndsAt);
    const at = times.length ? Math.min(...times) : null;
    if (at === this.alarmAt) return;
    this.alarmAt = at;
    if (at) await this.ctx.storage.setAlarm(at);
    else await this.ctx.storage.deleteAlarm();
  }
}

function clamp(raw, min, max, fallback) {
  const n = Math.round(Number(raw));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
