import type { AlertSoundName } from "../context/PreferencesContext";

/**
 * The feed's alert chimes.
 *
 * Synthesised with Web Audio rather than shipped as audio files. Three sounds as .mp3s would be
 * ~60-100KB of assets that every visitor downloads and almost none of them ever hear, they would
 * need a `media-src` entry in the site's CSP, and the service worker would have to decide whether
 * to cache them. A few dozen lines of oscillator scheduling costs nothing on either count and is
 * exact at any volume.
 */

let context: AudioContext | null = null;

type AudioContextCtor = typeof AudioContext;

function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  // Safari still only has the prefixed constructor on older versions.
  const Ctor: AudioContextCtor | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
  if (!Ctor) return null;
  if (!context) {
    try {
      context = new Ctor();
    } catch {
      return null;
    }
  }
  return context;
}

/**
 * Bring the audio context out of the suspended state browsers start it in.
 *
 * Autoplay policy: a context created without a user gesture behind it stays suspended, and
 * everything scheduled on it plays to nobody. Call this from a real click - Settings does, both
 * when the chime is switched on and when a sound is previewed - so that by the time an alert
 * actually arrives (which is *not* a gesture) the context is already running.
 */
export async function unlockAudio(): Promise<void> {
  const ctx = getContext();
  if (!ctx || ctx.state !== "suspended") return;
  try {
    await ctx.resume();
  } catch {
    // Nothing to do without a gesture the browser accepts; the next one will try again.
  }
}

/*
 * The three builders below take `BaseAudioContext`, not `AudioContext`: scheduling needs nothing
 * from the live-output subclass, and the wider type lets the exact same code be rendered through
 * an OfflineAudioContext - which is how these sounds can be measured rather than taken on trust.
 */

/** A short burst of noise, for the transient at the front of a sound. */
function noiseBurst(ctx: BaseAudioContext, destination: AudioNode, at: number, duration: number, gain: number): void {
  const frames = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i += 1) {
    // Faded across the burst so it reads as a click rather than a rip of static.
    data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  }
  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const bandpass = ctx.createBiquadFilter();
  bandpass.type = "bandpass";
  bandpass.frequency.value = 1600;
  bandpass.Q.value = 0.8;

  const envelope = ctx.createGain();
  envelope.gain.value = gain;

  source.connect(bandpass).connect(envelope).connect(destination);
  source.start(at);
  source.stop(at + duration);
}

/**
 * One decaying partial. `exponentialRampToValueAtTime` cannot reach zero, hence the floor -
 * ramping to an actual 0 throws, and a linear ramp sounds like the note is switched off rather
 * than dying away.
 */
function partial(
  ctx: BaseAudioContext,
  destination: AudioNode,
  options: {
    type: OscillatorType;
    freq: number;
    /** Optional second frequency to glide to, for sounds that bend in pitch. */
    endFreq?: number;
    at: number;
    attack: number;
    decay: number;
    gain: number;
  },
): void {
  const osc = ctx.createOscillator();
  osc.type = options.type;
  osc.frequency.setValueAtTime(options.freq, options.at);
  if (options.endFreq !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(options.endFreq, options.at + options.decay);
  }

  const envelope = ctx.createGain();
  envelope.gain.setValueAtTime(0.0001, options.at);
  envelope.gain.exponentialRampToValueAtTime(options.gain, options.at + options.attack);
  envelope.gain.exponentialRampToValueAtTime(0.0001, options.at + options.attack + options.decay);

  osc.connect(envelope).connect(destination);
  osc.start(options.at);
  osc.stop(options.at + options.attack + options.decay + 0.02);
}

/** Wall-clock length of each sound, so callers know when it has finished. */
export const DURATION_MS: Record<AlertSoundName, number> = { cork: 260, ring: 420, bell: 1600 };

export function scheduleAlertSound(ctx: BaseAudioContext, out: AudioNode, name: AlertSoundName): void {
  const t = ctx.currentTime + 0.01;

  if (name === "cork") {
    // A bottle pop: a thick body that drops fast in pitch, with a click on the front. The
    // downward glide is what makes it read as "pop" instead of "beep".
    noiseBurst(ctx, out, t, 0.02, 0.35);
    partial(ctx, out, { type: "sine", freq: 880, endFreq: 190, at: t, attack: 0.004, decay: 0.13, gain: 0.9 });
    partial(ctx, out, { type: "triangle", freq: 320, endFreq: 110, at: t, attack: 0.004, decay: 0.09, gain: 0.35 });
    return;
  }

  if (name === "ring") {
    // Two bright pulses a fifth apart, the second a shade quieter - the shape of a notification
    // ring rather than a single tone.
    for (const [index, start] of [t, t + 0.16].entries()) {
      const level = index === 0 ? 0.5 : 0.4;
      partial(ctx, out, { type: "sine", freq: 880, at: start, attack: 0.006, decay: 0.12, gain: level });
      partial(ctx, out, { type: "sine", freq: 1320, at: start, attack: 0.006, decay: 0.1, gain: level * 0.55 });
    }
    return;
  }

  // Bell. The partials of a struck bell are not whole-number multiples of the fundamental -
  // 2.76x and 5.40x are the classic inharmonic ratios - and the high ones die away first. Both
  // details are what separate this from an organ note.
  const base = 587.33; // D5
  const partials: { ratio: number; gain: number; decay: number }[] = [
    { ratio: 0.5, gain: 0.32, decay: 1.5 },
    { ratio: 1, gain: 0.5, decay: 1.35 },
    { ratio: 2, gain: 0.22, decay: 0.85 },
    { ratio: 2.76, gain: 0.16, decay: 0.6 },
    { ratio: 5.4, gain: 0.07, decay: 0.32 },
  ];
  for (const p of partials) {
    partial(ctx, out, {
      type: "sine",
      freq: base * p.ratio,
      at: t,
      attack: 0.004,
      decay: p.decay,
      gain: p.gain,
    });
  }
}

/**
 * Play one alert chime. Resolves when it has finished sounding.
 *
 * Never rejects: a chime that fails is not worth taking a render or an event handler down for.
 */
export async function playAlertSound(name: AlertSoundName, volume: number): Promise<void> {
  const level = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 0));
  if (level === 0) return;

  const ctx = getContext();
  if (!ctx) return;
  if (ctx.state === "suspended") {
    await unlockAudio();
    // Still blocked - the browser has had no gesture it accepts. Drop the chime rather than
    // scheduling into a context that will play it at some arbitrary later moment.
    if (ctx.state === "suspended") return;
  }

  try {
    const master = ctx.createGain();
    // Scaled well below unity: these are pure tones, and a full-scale sine is painfully loud
    // next to the rest of the web. The slider's top end should be "clearly audible", not "peak".
    master.gain.value = level * 0.55;
    master.connect(ctx.destination);
    scheduleAlertSound(ctx, master, name);
    // Let the master node go once the tail has finished.
    window.setTimeout(() => master.disconnect(), DURATION_MS[name] + 400);
  } catch {
    return;
  }

  await new Promise<void>((resolve) => window.setTimeout(resolve, DURATION_MS[name]));
}
