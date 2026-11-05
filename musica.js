/*
 * Música de fondo generada en el navegador con Web Audio. No hay archivos de
 * audio: acordes, notas sueltas y efectos se crean al vuelo y nunca se repiten
 * igual. Hay varios estilos (STYLES); cada uno es solo una configuración.
 */

const LOOKAHEAD = 1.5;   // segundos que se programan por adelantado

export const STYLES = {
  // Acordes suaves y notas de caja de música en Do mayor.
  relajante: {
    volume: 0.36, bar: 8, reverb: 0.5, echo: 0.45,
    chords: [[48, 55, 60, 64, 71], [45, 52, 57, 60, 67], [41, 48, 57, 60, 64], [43, 50, 55, 59, 64]],
    pad: { type: 'triangle', cutoff: 900, level: 0.035, attack: 2.5, release: 3 },
    bass: 0.09,
    melody: { notes: [72, 74, 76, 79, 81, 84, 86, 88], type: 'sine', level: 0.08, decay: 2.4, chance: 0.7, gap: [0.9, 2.7] },
  },
  // Piano eléctrico cálido, ritmo muy lento y crujido de vinilo.
  lofi: {
    volume: 0.34, bar: 60 / 70 * 8, reverb: 0.3, echo: 0.3,
    chords: [[50, 57, 60, 64, 69], [43, 53, 57, 59, 64], [48, 55, 59, 62, 64], [45, 55, 60, 64, 71]],
    pad: { type: 'sine', cutoff: 1300, level: 0.05, attack: 0.04, release: 1.2, decay: true },
    bass: 0.11,
    melody: { notes: [74, 76, 77, 79, 81, 84], type: 'triangle', level: 0.05, decay: 1.2, chance: 0.45, gap: [0.43, 1.3] },
    beat: { every: 60 / 70, kick: 0.22, hat: 0.03 },
    crackle: 0.05,
  },
  // Re menor, bordón grave, reloj que avanza y notas pellizcadas.
  intriga: {
    volume: 0.48, bar: 6, reverb: 0.45, echo: 0.25,
    chords: [[38, 50, 53, 57, 64], [34, 46, 50, 53, 57], [43, 50, 55, 58, 64], [33, 45, 49, 52, 58]],
    pad: { type: 'sawtooth', cutoff: 520, level: 0.022, attack: 1.5, release: 2 },
    bass: 0.12,
    melody: { notes: [62, 64, 65, 69, 70, 73, 74, 77], type: 'triangle', level: 0.07, decay: 0.7, chance: 0.5, gap: [0.5, 1.5] },
    tick: { every: 0.5, level: 0.045 },
  },
  // Acordes luminosos (Fa lidio), destellos agudos y mucha reverberación, sin ritmo.
  espacial: {
    volume: 0.3, bar: 10, reverb: 0.8, echo: 0.5,
    chords: [[41, 53, 57, 60, 64, 71], [40, 52, 55, 59, 64, 67], [38, 50, 57, 60, 64, 69], [46, 53, 57, 62, 64, 69]],
    pad: { type: 'sine', cutoff: 2200, level: 0.03, attack: 3.5, release: 4, shimmer: true },
    bass: 0,
    melody: { notes: [84, 86, 88, 91, 93, 95, 96], type: 'sine', level: 0.045, decay: 4, chance: 0.55, gap: [1.2, 3.2] },
  },
};

const freq = (note) => 440 * 2 ** ((note - 69) / 12);
const between = ([min, max]) => min + Math.random() * (max - min);

// Respuesta de una sala grande: ruido que se apaga poco a poco.
function impulse(ctx, seconds) {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
  }
  return buffer;
}

function noise(ctx, seconds, density = 1) {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() < density ? Math.random() * 2 - 1 : 0;
  return buffer;
}

export function createMusic(styleName = 'relajante') {
  let style = STYLES[styleName] ?? STYLES.relajante;
  let ctx = null;
  let master;
  let reverb;
  let echo;
  let hiss = null;
  let timer = null;
  let playing = false;
  let chordIndex = 0;
  let nextChordAt = 0;
  let nextNoteAt = 0;
  let nextBeatAt = 0;
  let beatIndex = 0;

  function setup() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);

    const room = ctx.createConvolver();
    room.buffer = impulse(ctx, 3.5);
    reverb = ctx.createGain();
    reverb.connect(room).connect(master);

    echo = ctx.createDelay(2);
    echo.delayTime.value = 0.45;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.35;
    echo.connect(feedback).connect(echo);
    echo.connect(master);
    echo.connect(reverb);

    // Pausa al cambiar de pestaña o minimizar; vuelve al regresar.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) ctx.suspend();
      else if (playing) ctx.resume();
    });
  }

  function applyStyle() {
    reverb.gain.value = style.reverb;
    echo.delayTime.value = style.echo;
    if (hiss) { hiss.stop(); hiss = null; }
    if (style.crackle) {
      // Crujido de vinilo: chasquidos sueltos en bucle.
      hiss = ctx.createBufferSource();
      hiss.buffer = noise(ctx, 3, 0.0009);
      hiss.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 3000;
      const gain = ctx.createGain();
      gain.gain.value = style.crackle;
      hiss.connect(filter).connect(gain).connect(master);
      hiss.start();
    }
  }

  function pad(note, at, duration) {
    const p = style.pad;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = p.cutoff;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(p.level, at + p.attack);
    // Piano eléctrico: el acorde se apaga solo; colchón: se mantiene todo el compás.
    if (p.decay) gain.gain.exponentialRampToValueAtTime(p.level * 0.25, at + duration * 0.6);
    else gain.gain.setValueAtTime(p.level, at + duration);
    gain.gain.linearRampToValueAtTime(0, at + duration + p.release);
    const end = at + duration + p.release + 0.1;
    for (const detune of [-7, 7]) {
      const osc = ctx.createOscillator();
      osc.type = p.type;
      osc.frequency.value = freq(note);
      osc.detune.value = detune;
      osc.connect(filter);
      osc.start(at);
      osc.stop(end);
    }
    if (p.shimmer) {
      // Brillo que respira: el filtro se abre y se cierra despacio.
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      lfo.frequency.value = 0.12;
      depth.gain.value = p.cutoff * 0.4;
      lfo.connect(depth).connect(filter.frequency);
      lfo.start(at);
      lfo.stop(end);
    }
    filter.connect(gain);
    gain.connect(master);
    gain.connect(reverb);
  }

  function bass(note, at, duration) {
    if (!style.bass) return;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq(note);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(style.bass, at + 1.2);
    gain.gain.linearRampToValueAtTime(0, at + duration + 1);
    osc.connect(gain).connect(master);
    osc.start(at);
    osc.stop(at + duration + 1.1);
  }

  function pluck(note, at) {
    const m = style.melody;
    const osc = ctx.createOscillator();
    osc.type = m.type;
    osc.frequency.value = freq(note);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(m.level, at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + m.decay);
    osc.connect(gain);
    gain.connect(master);
    gain.connect(reverb);
    gain.connect(echo);
    osc.start(at);
    osc.stop(at + m.decay + 0.1);
  }

  function kick(at) {
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(110, at);
    osc.frequency.exponentialRampToValueAtTime(42, at + 0.25);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(style.beat.kick, at);
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.4);
    osc.connect(gain).connect(master);
    osc.start(at);
    osc.stop(at + 0.45);
  }

  function hat(at) {
    const src = ctx.createBufferSource();
    src.buffer = noise(ctx, 0.1);
    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 7000;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(style.beat.hat, at);
    gain.gain.exponentialRampToValueAtTime(0.0005, at + 0.06);
    src.connect(filter).connect(gain).connect(master);
    src.start(at);
  }

  // Tic-tac de reloj: dos tonos alternos, secos y cortos.
  function tick(at, high) {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = high ? 1900 : 1450;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = osc.frequency.value;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(style.tick.level, at);
    gain.gain.exponentialRampToValueAtTime(0.0005, at + 0.05);
    osc.connect(filter).connect(gain).connect(master);
    osc.start(at);
    osc.stop(at + 0.06);
  }

  // Programa lo que toca sonar en el próximo segundo y medio.
  function schedule() {
    const until = ctx.currentTime + LOOKAHEAD;
    while (nextChordAt < until) {
      const chord = style.chords[chordIndex % style.chords.length];
      for (const note of chord) pad(note, nextChordAt, style.bar);
      bass(chord[0] - 12, nextChordAt, style.bar);
      chordIndex += 1;
      nextChordAt += style.bar;
    }
    while (nextNoteAt < until) {
      const m = style.melody;
      if (Math.random() < m.chance) pluck(m.notes[Math.floor(Math.random() * m.notes.length)], nextNoteAt);
      nextNoteAt += between(m.gap);
    }
    const every = style.beat?.every ?? style.tick?.every;
    while (every && nextBeatAt < until) {
      if (style.beat) {
        if (beatIndex % 4 === 0 || beatIndex % 4 === 2) kick(nextBeatAt);
        hat(nextBeatAt + every / 2);
      }
      if (style.tick) tick(nextBeatAt, beatIndex % 2 === 0);
      beatIndex += 1;
      nextBeatAt += every;
    }
  }

  function fadeTo(value, seconds) {
    const now = ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(value, now + seconds);
  }

  return {
    get playing() { return playing; },
    get style() { return styleName; },

    // Tiene que llamarse desde un toque o una tecla: los navegadores no dejan sonar audio antes.
    start() {
      if (!ctx) setup();
      if (!document.hidden) ctx.resume();
      if (playing) return;
      playing = true;
      applyStyle();
      const now = ctx.currentTime;
      nextChordAt = Math.max(nextChordAt, now + 0.1);
      nextNoteAt = Math.max(nextNoteAt, now + 1);
      nextBeatAt = Math.max(nextBeatAt, now + 0.1);
      fadeTo(style.volume, 2.5);
      schedule();
      timer = setInterval(schedule, 400);
    },

    stop() {
      if (!ctx || !playing) return;
      playing = false;
      clearInterval(timer);
      fadeTo(0, 0.8);
      setTimeout(() => {
        if (playing) return;
        if (hiss) { hiss.stop(); hiss = null; }
        ctx.suspend();
      }, 900);
    },

    // Cambia de estilo: baja el volumen, empieza el nuevo desde un acorde y vuelve a subir.
    setStyle(name) {
      if (!STYLES[name] || name === styleName) return;
      styleName = name;
      style = STYLES[name];
      if (!ctx || !playing) return;
      clearInterval(timer);
      fadeTo(0, 0.4);
      setTimeout(() => {
        if (!playing) return;
        const now = ctx.currentTime;
        chordIndex = 0;
        beatIndex = 0;
        nextChordAt = nextNoteAt = nextBeatAt = now + 0.1;
        applyStyle();
        fadeTo(style.volume, 1.5);
        schedule();
        timer = setInterval(schedule, 400);
      }, 450);
    },
  };
}
