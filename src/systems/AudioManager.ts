import { AUDIO } from '../app/gameConfig';
import type { Disposable } from '../core/Disposable';
import type { EventBus } from '../core/EventBus';
import type { GameEvents } from '../app/GameEvents';

type SoundName =
  | 'pistol' | 'rifle' | 'empty' | 'reload-start' | 'reload-end'
  | 'hit-flesh' | 'hit-head' | 'hit-world' | 'zombie-growl' | 'zombie-attack'
  | 'player-hurt' | 'wave-start' | 'wave-clear' | 'pickup' | 'weapon-pickup' | 'ui-click' | 'player-death';

/**
 * All sound is synthesised with the Web Audio API.
 *
 * No audio files are downloaded, so there is no sample licence to verify and the
 * bundle stays small. Every voice passes through the master gain, which is what
 * the settings slider and the mute toggle control.
 */
export class AudioManager implements Disposable {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
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
      events.on('weapon:fired', ({ weaponId }) => this.play(weaponId === 'rifle' ? 'rifle' : 'pistol')),
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
        this.burst(0.16, 2600, 0.5);
        this.tone(220 * pitchScale, 0.1, 'square', 0.18, 70);
        break;
      case 'rifle':
        this.burst(0.12, 3200, 0.42);
        this.tone(180 * pitchScale, 0.08, 'square', 0.14, 60);
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
