// Servidor estático + juego multijugador con Socket.IO.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const root = __dirname;
const port = Number(process.argv[2]) || 4321;
const types = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

const COLORS = ['#ff5b3a', '#4f6bff', '#ffc93c', '#2fbf83', '#ff9fcb', '#b18cff'];
const REVEAL_MS = 15000;
const MAX_WORD = 24;
const rooms = new Map();

function randomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function cleanName(raw) {
  return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 16) || '???';
}

function cleanWord(raw) {
  return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_WORD);
}

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
    .replace(/^(el|la|los|las|lo|un|una|unos|unas)\s+/, '');
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

function canAgree(room) {
  const last = room.history[room.history.length - 1];
  return !!last && last.words.every((w) => w.word);
}

function createRoom(code, hostId, hostName, settings) {
  const room = {
    code,
    settings: {
      seconds: Number(settings?.seconds) || 30,
      max: Math.min(6, Math.max(2, Number(settings?.max) || 4)),
    },
    players: [{ id: hostId, name: cleanName(hostName), color: COLORS[0], online: true }],
    hostId,
    game: 0,
    phase: 'lobby',
    round: 0,
    endsAt: 0,
    revealEndsAt: 0,
    submitted: {},
    ready: {},
    agree: {},
    history: [],
    winWords: [],
    synonym: false,
    words: {},
  };
  rooms.set(code, room);
  return room;
}

function sendState(room) {
  if (!room) return;
  io.to(room.code).emit('state', { ...room, now: Date.now() });
}

function startGame(room) {
  room.game += 1;
  room.round = 0;
  room.history = [];
  room.winWords = [];
  room.synonym = false;
  nextRound(room);
}

function nextRound(room) {
  room.round += 1;
  room.phase = 'thinking';
  room.submitted = {};
  room.ready = {};
  room.agree = {};
  room.words = {};
  room.endsAt = Date.now() + room.settings.seconds * 1000;
  room.revealEndsAt = 0;
  sendState(room);
}

function reveal(room) {
  const words = room.players.map((p) => ({
    id: p.id,
    name: p.name,
    color: p.color,
    word: room.words[p.id] || '',
  }));
  room.history.push({ round: room.round, words });

  const keys = words.map((w) => norm(w.word));
  if (keys.length > 1 && keys.every((k) => k && k === keys[0])) {
    room.phase = 'won';
    room.winWords = [words[0].word];
    room.synonym = false;
    sendState(room);
    return;
  }

  room.phase = 'reveal';
  room.ready = {};
  room.agree = {};
  room.revealEndsAt = Date.now() + REVEAL_MS;
  sendState(room);
}

function winBySynonym(room) {
  const last = room.history[room.history.length - 1];
  const unique = new Map();
  for (const w of last.words) {
    const key = norm(w.word);
    if (key && !unique.has(key)) unique.set(key, w.word);
  }
  room.phase = 'won';
  room.synonym = true;
  room.winWords = [...unique.values()];
  sendState(room);
}

function checkProgress(room) {
  const online = room.players.filter((p) => p.online);
  if (room.phase === 'thinking' && online.every((p) => room.submitted[p.id])) {
    reveal(room);
    return true;
  }
  if (room.phase === 'reveal') {
    if (online.every((p) => room.agree[p.id])) {
      winBySynonym(room);
      return true;
    }
    if (online.every((p) => room.ready[p.id] || room.agree[p.id])) {
      nextRound(room);
      return true;
    }
  }
  return false;
}

function removePlayerFromRoom(room, playerId) {
  if (!room) return;
  room.players = room.players.filter((p) => p.id !== playerId);
  if (!room.players.length) {
    rooms.delete(room.code);
    return;
  }
  if (room.hostId === playerId) room.hostId = room.players[0].id;
  delete room.submitted[playerId];
  delete room.ready[playerId];
  delete room.agree[playerId];
  delete room.words[playerId];
  if (room.phase === 'lobby') {
    room.round = 0;
  }
  if (!room.players.some((p) => p.online !== false)) {
    room.phase = 'lobby';
    room.round = 0;
  }
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const filePath = urlPath === '/' ? '/index.html' : urlPath;
  const fullPath = path.join(root, filePath);
  if (!fullPath.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404).end('No encontrado');
      return;
    }
    res.writeHead(200, {
      'Content-Type': `${types[path.extname(fullPath)] || 'application/octet-stream'}; charset=utf-8`,
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/socket.io/')) {
    res.writeHead(404).end();
    return;
  }
  serveStatic(req, res);
});

const io = new Server(server, { cors: { origin: '*' } });

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name, settings }) => {
    const code = randomCode();
    const room = createRoom(code, socket.id, name, settings || { seconds: 30, max: 4 });
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit('state', { ...room, now: Date.now() });
  });

  socket.on('joinRoom', ({ code, name }) => {
    const roomCode = String(code || '').toUpperCase();
    const room = rooms.get(roomCode);
    if (!room) {
      socket.emit('error', { key: 'no_room' });
      return;
    }
    if (room.phase !== 'lobby') {
      socket.emit('error', { key: 'err_started' });
      return;
    }
    if (room.players.length >= room.settings.max) {
      socket.emit('error', { key: 'err_full' });
      return;
    }

    const player = { id: socket.id, name: cleanName(name), color: COLORS[room.players.length % COLORS.length], online: true };
    room.players.push(player);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    sendState(room);
  });

  socket.on('roomAction', ({ code, type, word }) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room || !room.players.some((p) => p.id === socket.id)) return;

    switch (type) {
      case 'start':
        if (socket.id !== room.hostId || room.phase !== 'lobby' || room.players.length < 2) return;
        startGame(room);
        break;
      case 'word': {
        if (room.phase !== 'thinking' || room.submitted[socket.id]) return;
        const clean = cleanWord(word);
        const err = wordError(clean, room.history);
        if (err) {
          socket.emit('reject', { err });
          return;
        }
        room.words[socket.id] = clean;
        room.submitted[socket.id] = true;
        socket.emit('accepted', { word: clean });
        checkProgress(room);
        break;
      }
      case 'next':
        if (room.phase !== 'reveal') return;
        room.ready[socket.id] = true;
        delete room.agree[socket.id];
        checkProgress(room);
        break;
      case 'agree':
        if (room.phase !== 'reveal' || !canAgree(room)) return;
        room.agree[socket.id] = true;
        delete room.ready[socket.id];
        checkProgress(room);
        break;
      case 'again':
        if (socket.id !== room.hostId || room.phase !== 'won') return;
        room.players = room.players.filter((p) => p.online !== false);
        if (room.players.length >= 2) startGame(room);
        else {
          room.phase = 'lobby';
          room.round = 0;
          room.history = [];
          room.winWords = [];
          room.synonym = false;
        }
        sendState(room);
        break;
      default:
        return;
    }

    sendState(room);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data?.roomCode || '');
    if (!room) return;
    removePlayerFromRoom(room, socket.id);
    if (rooms.has(room.code)) sendState(room);
  });
});

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.phase === 'thinking' && Date.now() >= room.endsAt) {
      reveal(room);
    } else if (room.phase === 'reveal' && Object.keys(room.agree).length === 0 && Date.now() >= room.revealEndsAt) {
      nextRound(room);
    }
  }
}, 250);

server.listen(port, () => {
  console.log(`Misma Palabra en http://localhost:${port}`);
});
