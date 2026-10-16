import { AUDIO } from '../app/gameConfig';
import {
  SHOT_SAMPLES, TAIL_DECAY, TAIL_MIX, TAIL_SECONDS, TRANSIENT_MIX, TRANSIENT_SECONDS,
  createImpulseResponse, allSampleFiles, samplePath, shotGain, shotPlaybackRate,
  shotRoleFor, type ShotRole,
} from './audioSamples';
import type { Disposable } from '../core/Disposable';
import type { EventBus } from '../core/EventBus';
import type { GameEvents } from '../app/GameEvents';

type SoundName =
  | 'pistol' | 'rifle' | 'shotgun' | 'heavy' | 'empty' | 'reload-start' | 'reload-end'
  | 'hit-flesh' | 'hit-head' | 'hit-world' | 'zombie-growl' | 'zombie-attack'
  | 'player-hurt' | 'wave-start' | 'wave-clear' | 'pickup' | 'weapon-pickup' | 'ui-click' | 'player-death';

/**
 * Sound: recorded gunshots for the weapons, synthesis for everything else.
 *
 * Gunshots were synthesised with a noise burst and an oscillator, which is why they read
 * as static rather than as a gun. A real shot is three things at once — a transient crack,
 * a body, and the tail coming back off the buildings — so a shot now plays a recorded
 * sample with a synthesised crack mixed on top, sent through a convolution reverb whose
 * impulse response is generated at startup. Nothing else changed: hit, growl and UI sounds
 * are still synthesised, and every voice still passes through the master gain the settings
 * slider controls.
 *
 * Samples are decoded at startup and, until they are ready, a shot falls back to the old
 * synthesised voice: a silent first shot would be worse than a plain one.
 */
export class AudioManager implements Disposable {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  /** Decoded shot samples per role, and which files failed to decode. */
  private readonly samples = new Map<ShotRole, AudioBuffer[]>();
  private readonly sampleFailures: string[] = [];
  private samplesLoaded = 0;
  private sampleShots = 0;
  private synthShots = 0;
  /** Convolution tail: the street answering a shot back. */
  private reverb: ConvolverNode | null = null;
  private reverbGain: GainNode | null = null;
  private volume = AUDIO.masterVolumeDefault;
  private muted = false;
  private activeVoices = 0;
  private suspended = false;

  constructor() {
    if (typeof window === 'undefined') return;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      console.warn('[audio] Web Audio API unavailable; running silent');
      return;
    }
    this.context = new Ctor();
    this.master = this.context.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.context.destination);
    this.noiseBuffer = this.createNoiseBuffer();

    // The tail, built once: a convolver fed by a generated impulse response, mixed in
    // through its own gain so the amount of street is one number.
    this.reverb = this.context.createConvolver();
    this.reverb.buffer = this.createImpulse();
    this.reverbGain = this.context.createGain();
    this.reverbGain.gain.value = TAIL_MIX;
    this.reverb.connect(this.reverbGain);
    this.reverbGain.connect(this.master);

    void this.loadSamples();
  }

  /** Diagnostics for the smoke test: what loaded, and whether shots used it. */
  get statistics(): {
    loaded: number; expected: number; failures: string[]; sampleShots: number; synthShots: number;
  } {
    return {
      loaded: this.samplesLoaded,
      expected: allSampleFiles().length,
      failures: [...this.sampleFailures],
      sampleShots: this.sampleShots,
      synthShots: this.synthShots,
    };
  }

  private createImpulse(): AudioBuffer | null {
    if (!this.context) return null;
    const samples = createImpulseResponse(
      this.context.sampleRate, TAIL_SECONDS, TAIL_DECAY, Math.random,
    );
    const buffer = this.context.createBuffer(1, samples.length, this.context.sampleRate);
    // A fresh copy: copyToChannel wants a Float32Array backed by a plain ArrayBuffer, and
    // the generator's type is wider than that.
    buffer.copyToChannel(new Float32Array(samples), 0);
    return buffer;
  }

  /** Fetches and decodes every shot sample, off the critical path. */
  private async loadSamples(): Promise<void> {
    if (!this.context || typeof fetch !== 'function') return;
    for (const [role, files] of Object.entries(SHOT_SAMPLES) as Array<[ShotRole, readonly string[]]>) {
      const buffers: AudioBuffer[] = [];
      for (const file of files) {
        try {
          const response = await fetch(samplePath(file));
          if (!response.ok) {
            this.sampleFailures.push(`${file}: HTTP ${response.status}`);
            continue;
          }
          const bytes = await response.arrayBuffer();
          buffers.push(await this.context.decodeAudioData(bytes));
        } catch (error) {
          this.sampleFailures.push(`${file}: ${error instanceof Error ? error.message : 'decode failed'}`);
        }
      }
      if (buffers.length > 0) this.samples.set(role, buffers);
      this.samplesLoaded = [...this.samples.values()].reduce((sum, list) => sum + list.length, 0);
    }
  }

  /**
   * One shot: the recorded sample, a synthesised crack over it, and the tail.
   *
   * Returns false when no sample is ready, so the caller can fall back.
   */
  private playShot(role: ShotRole): boolean {
    const buffers = this.samples.get(role);
    if (!this.context || !this.master || !buffers || buffers.length === 0) return false;
    const buffer = buffers[Math.min(buffers.length - 1, Math.floor(Math.random() * buffers.length))];
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = shotPlaybackRate(Math.random);
    const gain = this.context.createGain();
    gain.gain.value = shotGain(Math.random);
    source.connect(gain);
    gain.connect(this.master);
    // A send, not a replacement: the dry shot keeps its punch and the reverb adds space.
    if (this.reverb) gain.connect(this.reverb);
    source.start(this.context.currentTime);

    // Transient layer, synthesised: at this length it is the crack the recording carries
    // but a small speaker loses.
    const transientFilter = role === 'pistol' ? 2600 : role === 'rifle' ? 3200 : 1800;
    this.burst(TRANSIENT_SECONDS, transientFilter, TRANSIENT_MIX);
    this.sampleShots += 1;
    return true;
  }

  /** Must be called from a user gesture: browsers start contexts suspended. */
  resume(): void {
    if (!this.context) return;
    if (this.context.state === 'suspended') {
      void this.context.resume().then(() => {
        this.suspended = false;
      });
    }
  }

  get isAvailable(): boolean {
    return this.context !== null;
  }

  get isSuspended(): boolean {
    return this.suspended || this.context?.state === 'suspended';
  }

  get currentVolume(): number {
    return this.volume;
  }

  setVolume(value: number): void {
    this.volume = Math.min(Math.max(value, 0), 1);
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : this.volume;
  }

  suspend(): void {
    this.suspended = true;
    if (this.context && this.context.state === 'running') void this.context.suspend();
  }

  resumeFromSuspend(): void {
    this.suspended = false;
    if (this.context && this.context.state === 'suspended') void this.context.resume();
  }

  /** Wires the game events to their sounds so systems stay decoupled. */
  bind(events: EventBus<GameEvents>): () => void {
    const unsubscribers = [
      // The weapon says which recording it fires; see shotRoleFor for the mapping.
      events.on('weapon:fired', ({ weaponId }) => this.play(shotRoleFor(weaponId))),
      events.on('weapon:empty', () => this.play('empty')),
      events.on('weapon:reload-started', () => this.play('reload-start')),
      events.on('weapon:reload-finished', () => this.play('reload-end')),
      events.on('combat:hit', ({ zone, killed }) => {
        this.play(zone === 'head' ? 'hit-head' : 'hit-flesh');
        if (killed) this.play('zombie-growl', 0.5);
      }),
      events.on('combat:world-hit', () => this.play('hit-world')),
      events.on('zombie:attacked', () => this.play('zombie-attack')),
      events.on('zombie:spawned', () => this.play('zombie-growl', 0.35)),
      events.on('player:damaged', () => this.play('player-hurt')),
      events.on('player:died', () => this.play('player-death')),
      events.on('wave:started', () => this.play('wave-start')),
      events.on('wave:cleared', () => this.play('wave-clear')),
      events.on('pickup:collected', ({ type }) => this.play(type === 'weapon' ? 'weapon-pickup' : 'pickup')),
      events.on('game:paused', () => this.suspend()),
      events.on('game:resumed', () => this.resumeFromSuspend()),
    ];
    return () => {
      for (const off of unsubscribers) off();
    };
  }

  private createNoiseBuffer(): AudioBuffer | null {
    if (!this.context) return null;
    const length = Math.floor(this.context.sampleRate * 0.6);
    const buffer = this.context.createBuffer(1, length, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  private noiseSource(): AudioBufferSourceNode | null {
    if (!this.context || !this.noiseBuffer) return null;
    const source = this.context.createBufferSource();
    source.buffer = this.noiseBuffer;
    return source;
  }

  private tone(
    frequency: number,
    duration: number,
    type: OscillatorType,
    gain: number,
    endFrequency?: number,
  ): void {
    if (!this.context || !this.master) return;
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    const envelope = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, now);
    if (endFrequency !== undefined) oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), now + duration);
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.linearRampToValueAtTime(gain, now + Math.min(0.012, duration * 0.2));
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(envelope);
    envelope.connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.02);
  }

  private burst(duration: number, filterFrequency: number, gain: number, decay = true): void {
    if (!this.context || !this.master) return;
    const source = this.noiseSource();
    if (!source) return;
    const filter = this.context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = filterFrequency;
    const envelope = this.context.createGain();
    const now = this.context.currentTime;
    envelope.gain.setValueAtTime(gain, now);
    if (decay) envelope.gain.exponentialRampToValueAtTime(0.0005, now + duration);
    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(this.master);
    source.start(now);
    source.stop(now + duration + 0.05);
  }

  play(name: SoundName, pitchScale = 1): void {
    if (!this.context || !this.master || this.muted) return;
    if (this.activeVoices >= AUDIO.maxVoices) return;
    this.activeVoices += 1;
    // Bursts and tones are short; the counter is decremented on a timer that is
    // owned by the audio context rather than the game loop.
    window.setTimeout(() => {
      this.activeVoices = Math.max(0, this.activeVoices - 1);
    }, 400);

    switch (name) {
      case 'pistol':
      case 'rifle':
      case 'shotgun':
      case 'heavy':
        // Sampled when the recording is ready; the synthesised voice below is the
        // fallback for the first shots of a session and for a failed decode.
        if (this.playShot(name)) break;
        this.synthShots += 1;
        if (name === 'shotgun' || name === 'heavy') {
          this.burst(0.2, 1500, 0.5);
          this.tone(120 * pitchScale, 0.12, 'square', 0.2, 55);
        } else {
          this.burst(name === 'pistol' ? 0.16 : 0.12, name === 'pistol' ? 2600 : 3200,
            name === 'pistol' ? 0.5 : 0.42);
          this.tone((name === 'pistol' ? 220 : 180) * pitchScale, 0.1, 'square', 0.16, 70);
        }
        break;
      case 'empty':
        this.tone(1400, 0.05, 'square', 0.12, 900);
        break;
      case 'reload-start':
        this.tone(320, 0.07, 'triangle', 0.16, 220);
        break;
      case 'reload-end':
        this.tone(520, 0.09, 'triangle', 0.2, 320);
        break;
      case 'hit-flesh':
        this.burst(0.11, 900, 0.36);
        break;
      case 'hit-head':
        this.burst(0.16, 1500, 0.44);
        this.tone(90, 0.12, 'sine', 0.2, 50);
        break;
      case 'hit-world':
        this.burst(0.07, 5200, 0.2);
        break;
      case 'zombie-growl':
        this.tone(96 * pitchScale, 0.5, 'sawtooth', 0.13, 62);
        break;
      case 'zombie-attack':
        this.tone(150 * pitchScale, 0.26, 'sawtooth', 0.2, 80);
        break;
      case 'player-hurt':
        this.tone(160, 0.22, 'sine', 0.3, 90);
        this.burst(0.2, 700, 0.24);
        break;
      case 'player-death':
        this.tone(140, 1.1, 'sine', 0.34, 45);
        break;
      case 'wave-start':
        this.tone(180, 0.7, 'triangle', 0.26, 300);
        break;
      case 'wave-clear':
        this.tone(320, 0.5, 'triangle', 0.24, 620);
        break;
      case 'pickup':
        this.tone(640, 0.1, 'triangle', 0.2, 900);
        break;
      case 'weapon-pickup':
        this.tone(420, 0.2, 'square', 0.22, 880);
        break;
      case 'ui-click':
        this.tone(520, 0.05, 'square', 0.12, 700);
        break;
      default:
        break;
    }
  }

  dispose(): void {
    if (this.context) {
      void this.context.close();
      this.context = null;
    }
    this.master = null;
    this.noiseBuffer = null;
  }
}
