import type { Unsubscribe } from './EventBus';

/**
 * Single source of truth for the game phase. Input, AI, damage, audio and the
 * HUD all read this instead of keeping private booleans that drift apart.
 */
export type GamePhase = 'loading' | 'title' | 'playing' | 'paused' | 'gameOver';

const ALLOWED: Record<GamePhase, GamePhase[]> = {
  loading: ['title', 'gameOver'],
  title: ['loading', 'playing'],
  playing: ['paused', 'gameOver', 'title'],
  paused: ['playing', 'title', 'gameOver'],
  gameOver: ['playing', 'title', 'loading'],
};

export class GameState {
  private current: GamePhase = 'loading';
  private readonly listeners = new Set<(phase: GamePhase, previous: GamePhase) => void>();

  get phase(): GamePhase {
    return this.current;
  }

  /** True only when gameplay simulation, input and damage should advance. */
  get isSimulationActive(): boolean {
    return this.current === 'playing';
  }

  /** Pointer lock and mouse look are only meaningful while playing. */
  get acceptsGameplayInput(): boolean {
    return this.current === 'playing';
  }

  set(next: GamePhase): boolean {
    if (next === this.current) return false;
    if (!ALLOWED[this.current].includes(next)) {
      console.warn(`[state] refused transition ${this.current} -> ${next}`);
      return false;
    }
    const previous = this.current;
    this.current = next;
    for (const listener of [...this.listeners]) listener(next, previous);
    return true;
  }

  onChange(listener: (phase: GamePhase, previous: GamePhase) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.listeners.clear();
  }
}
