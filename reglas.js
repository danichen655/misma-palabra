/*
 * Reglas del juego compartidas por la web y el servidor de salas
 * (backend/sala.js): el servidor decide, la web las usa para avisar antes de enviar.
 */

export const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const COLORS = ['#ff5b3a', '#4f6bff', '#ffc93c', '#2fbf83', '#ff9fcb', '#b18cff'];
export const REVEAL_MS = 15000;
export const MAX_WORD = 24;
export const MAX_NAME = 16;

const ARTICLES = /^(el|la|los|las|lo|un|una|unos|unas|the|a|an)\s+/;

// Clave de comparación: sin mayúsculas, tildes, signos ni artículo inicial en español o inglés (la ñ se respeta).
export function norm(word) {
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

export function cleanWord(raw) {
  return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_WORD);
}

export function cleanName(raw) {
  return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) || '???';
}

export function isCode(code) {
  return new RegExp(`^[${ALPHABET}]{6}$`).test(code);
}

export function randomCode() {
  let out = '';
  for (const b of crypto.getRandomValues(new Uint8Array(6))) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export function usedWords(history) {
  const seen = new Map();
  for (const entry of history) {
    for (const w of entry.words) {
      const key = norm(w.word);
      if (key && !seen.has(key)) seen.set(key, w.word);
    }
  }
  return seen;
}

export function wordError(word, history) {
  if (!norm(word)) return { key: 'err_empty' };
  const used = usedWords(history);
  if (used.has(norm(word))) return { key: 'err_used', params: { word: used.get(norm(word)) } };
  return null;
}

// Solo se puede votar "es lo mismo" si todos escribieron algo en la última ronda.
export function canAgree(room) {
  const last = room.history[room.history.length - 1];
  return !!last && last.words.every((w) => w.word);
}
