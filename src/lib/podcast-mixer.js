/* =============================================================================
   src/lib/podcast-mixer.js — BACKGROUND MUSIC MIXER FOR PODCASTS
   -----------------------------------------------------------------------------
   Lets a Writer layer a background music track onto their podcast voice track
   and preview the blend in real time before uploading, then renders the blend
   into a single mixed file (OfflineAudioContext) that is uploaded in place of
   the raw voice track.

   DESIGN
     - The mixer owns two decoded AudioBuffers (voice, background) and a volume
       (0..1, default 0.2). It exposes:
         setVoice(file) / setBackground(file) / clearBackground() / setVolume(v)
         play() / pause() / stop() / seek(t)
         renderMixed() -> Promise<Blob>   (mixed, looped bg, chosen volume)
     - Live preview uses a single AudioContext with two BufferSourceNodes (voice
       + bg) started together, the bg routed through a GainNode. The bg source
       is looped; both stop when the voice ends.
     - Gain changes during playback go through GainNode.gain.setTargetAtTime so
       the volume slider never clicks.
     - renderMixed() uses OfflineAudioContext at the voice's sample rate, loops
       the bg to the voice length, applies the gain, and encodes to a WAV blob
       (no encoder dependency; WAV is universally playable and accepted by the
       upload validator, which keys on extension/MIME loosely).

   State callbacks: onState(state) where state in
     { idle, decoding, ready, playing, paused, rendering, error }.
   ========================================================================== */

export const DEFAULT_BG_VOLUME = 0.2;

function decodeFile(ctx, file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the audio file.'));
    reader.onload = () => {
      const buf = reader.result;
      ctx.decodeAudioData(
        buf,
        (decoded) => resolve(decoded),
        (err) => reject(err || new Error('Could not decode the audio file.'))
      );
    };
    reader.readAsArrayBuffer(file);
  });
}

export function createPodcastMixer({ onState, onProgress } = {}) {
  const state = {
    voiceFile: null,
    bgFile: null,
    voiceBuffer: null,
    bgBuffer: null,
    volume: DEFAULT_BG_VOLUME,
    status: 'idle', // idle | decoding | ready | playing | paused | rendering | error
    error: null,
    duration: 0, // voice duration seconds
    position: 0
  };

  let ctx = null; // live AudioContext
  let voiceSource = null;
  let bgSource = null;
  let bgGain = null;
  let startedAt = 0;
  let pausedAt = 0;
  let playing = false;
  let raf = null;

  function emit(s) {
    state.status = s;
    if (onState) onState({ ...state });
  }

  function ensureCtx() {
    if (!ctx || ctx.state === 'closed') {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  async function loadVoice(file) {
    state.voiceFile = file;
    state.voiceBuffer = null;
    state.duration = 0;
    emit('decoding');
    try {
      const c = ensureCtx();
      const buf = await decodeFile(c, file);
      state.voiceBuffer = buf;
      state.duration = buf.duration;
      if (state.bgBuffer) emit('ready'); else emit('ready');
    } catch (e) {
      state.error = e?.message || 'Could not decode the voice track.';
      emit('error');
    }
  }

  async function loadBackground(file) {
    state.bgFile = file;
    state.bgBuffer = null;
    if (!file) { emit(state.voiceBuffer ? 'ready' : 'idle'); return; }
    emit('decoding');
    try {
      const c = ensureCtx();
      const buf = await decodeFile(c, file);
      state.bgBuffer = buf;
      emit(state.voiceBuffer ? 'ready' : 'idle');
    } catch (e) {
      state.error = e?.message || 'Could not decode the background track.';
      state.bgFile = null;
      emit('error');
    }
  }

  function clearBackground() {
    state.bgFile = null;
    state.bgBuffer = null;
    if (playing) stop();
    emit(state.voiceBuffer ? 'ready' : 'idle');
  }

  function setVolume(v) {
    const clamped = Math.max(0, Math.min(1, Number(v)));
    state.volume = clamped;
    if (bgGain) {
      const now = ctx.currentTime;
      bgGain.gain.cancelScheduledValues(now);
      bgGain.gain.setTargetAtTime(clamped, now, 0.02);
    }
    if (onState) onState({ ...state });
  }

  let hardStopTimer = null;

  function stopSources() {
    if (hardStopTimer) { clearTimeout(hardStopTimer); hardStopTimer = null; }
    try { voiceSource?.stop(); } catch {}
    try { bgSource?.stop(); } catch {}
    voiceSource = null;
    bgSource = null;
    bgGain = null;
  }

  function tick() {
    if (!playing) return;
    const elapsed = ctx.currentTime - startedAt + pausedAt;
    state.position = Math.min(elapsed, state.duration);
    if (onProgress) onProgress(state.position, state.duration);
    if (state.position >= state.duration) {
      stop();
      return;
    }
    raf = requestAnimationFrame(tick);
  }

  function play() {
    if (!state.voiceBuffer) return;
    if (playing) return;
    const c = ensureCtx();
    stopSources();
    voiceSource = c.createBufferSource();
    voiceSource.buffer = state.voiceBuffer;
    voiceSource.connect(c.destination);

    if (state.bgBuffer) {
      bgSource = c.createBufferSource();
      bgSource.buffer = state.bgBuffer;
      // Only loop when the bed is shorter than the voice track, per spec.
      bgSource.loop = state.bgBuffer.duration < state.voiceBuffer.duration;
      bgGain = c.createGain();
      bgGain.gain.value = state.volume;
      bgSource.connect(bgGain).connect(c.destination);
    }

    const offset = pausedAt;
    startedAt = c.currentTime;
    voiceSource.start(0, offset);
    if (bgSource) {
      // align bg start to voice offset modulo bg duration
      const bgDur = state.bgBuffer.duration;
      const bgOffset = offset % bgDur;
      bgSource.start(0, bgOffset);
    }
    voiceSource.onended = () => {
      if (playing) stop();
    };
    playing = true;
    emit('playing');
    raf = requestAnimationFrame(tick);
    // Hard stop backup in case onended does not fire in some browsers.
    hardStopTimer = setTimeout(() => {
      if (playing) stop();
    }, Math.ceil(state.duration * 1000) + 250);
  }

  function pause() {
    if (!playing) return;
    pausedAt = state.position;
    playing = false;
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    stopSources();
    emit('paused');
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    playing = false;
    pausedAt = 0;
    state.position = 0;
    stopSources();
    if (onProgress) onProgress(0, state.duration);
    emit(state.voiceBuffer ? 'ready' : 'idle');
  }

  function seek(t) {
    const wasPlaying = playing;
    if (wasPlaying) pause();
    pausedAt = Math.max(0, Math.min(state.duration, t));
    state.position = pausedAt;
    if (onProgress) onProgress(state.position, state.duration);
    if (onState) onState({ ...state });
    if (wasPlaying) play();
  }

  // Render mixed audio to a WAV Blob using OfflineAudioContext.
  async function renderMixed() {
    if (!state.voiceBuffer) throw new Error('No voice track to mix.');
    emit('rendering');
    const voice = state.voiceBuffer;
    const sampleRate = voice.sampleRate;
    const length = voice.length;
    const offline = new OfflineAudioContext(voice.numberOfChannels, length, sampleRate);
    // voice
    const vSrc = offline.createBufferSource();
    vSrc.buffer = voice;
    vSrc.connect(offline.destination);
    vSrc.start(0);
    // background (looped)
    if (state.bgBuffer && state.volume > 0) {
      const g = offline.createGain();
      g.gain.value = state.volume;
      g.connect(offline.destination);
      // loop manually by scheduling repeated starts
      const bg = state.bgBuffer;
      const bgDur = bg.duration;
      let t = 0;
      while (t < voice.duration) {
        const src = offline.createBufferSource();
        src.buffer = bg;
        src.connect(g);
        const seg = Math.min(bgDur, voice.duration - t);
        src.start(t);
        if (seg < bgDur) {
          // trim last segment via stop
          try { src.stop(t + seg); } catch {}
        }
        t += bgDur;
      }
    }
    const rendered = await offline.startRendering();
    const blob = audioBufferToWav(rendered);
    emit(state.voiceBuffer ? 'ready' : 'idle');
    return blob;
  }

  function destroy() {
    stop();
    if (ctx) { try { ctx.close(); } catch {} ctx = null; }
  }

  return {
    state,
    loadVoice,
    loadBackground,
    clearBackground,
    setVolume,
    play,
    pause,
    stop,
    seek,
    renderMixed,
    destroy,
    hasVoice: () => !!state.voiceBuffer,
    hasBackground: () => !!state.bgBuffer
  };
}

// Minimal WAV encoder for an AudioBuffer (16-bit PCM).
function audioBufferToWav(buffer) {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataLength = buffer.length * blockAlign;
  const headerLength = 44;
  const totalLength = headerLength + dataLength;
  const arrayBuffer = new ArrayBuffer(totalLength);
  const view = new DataView(arrayBuffer);

  function writeStr(offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }
  writeStr(0, 'RIFF');
  view.setUint32(4, totalLength - 8, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeStr(36, 'data');
  view.setUint32(40, dataLength, true);

  // interleave channels
  const channels = [];
  for (let c = 0; c < numChannels; c++) channels.push(buffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let c = 0; c < numChannels; c++) {
      let s = channels[c][i];
      s = Math.max(-1, Math.min(1, s));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([arrayBuffer], { type: 'audio/wav' });
}
