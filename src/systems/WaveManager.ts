import {
  WAVES, waveActiveCap, waveComposition, waveTotalCount, type ZombieKind,
} from '../app/gameConfig';
import type { EventBus } from '../core/EventBus';
import type { GameEvents } from '../app/GameEvents';
import { pickSpawnPoint } from '../level/SpawnPoints';
import type { NavigationGrid } from '../zombies/NavigationGrid';
import type { RandomSource } from '../utils/math';

/** Minimal surface the wave director needs, so tests can pass a stub. */
export interface ZombieSpawner {
  spawn(kind: ZombieKind, x: number, z: number, yaw?: number): unknown | null;
  get count(): number;
  maxActive: number;
  /**
   * Moves zombies that are too far away to matter back into the fight, returning how many
   * moved. Optional so a stub in a test need not implement it.
   */
  recallNear?(playerX: number, playerZ: number, playerYaw: number): number;
}

/**
 * The wave director needs the navigation grid itself, not just a walkability predicate.
 *
 * Placing a zombie used to check only that its cell was walkable, which happily put them
 * in pockets sealed off from the street; the picker now also needs connectivity (and the
 * grid's cells, for the last-resort search), so the surface is the grid.
 */
export type SpawnSurface = NavigationGrid;

export interface WaveContext {
  playerX: number;
  playerZ: number;
  playerYaw: number;
  surface: SpawnSurface;
}

export type WavePhase = 'idle' | 'break' | 'spawning' | 'clearing' | 'finished';

export interface WaveStats {
  wave: number;
  total: number;
  spawned: number;
  remaining: number;
  phase: WavePhase;
  secondsUntilNextWave: number;
}

export interface WaveManagerDeps {
  events: EventBus<GameEvents>;
  spawner: ZombieSpawner;
  random: RandomSource;
  /** Hard cap from the quality preset; also clamped by WAVES/TOTAL config. */
  activeCap: number;
  /**
   * Kinds whose models loaded successfully. A kind that is missing is skipped
   * rather than spawning an entity with no mesh.
   */
  availableKinds?: readonly ZombieKind[];
}

/**
 * Wave director.
 *
 * A wave is planned up front (count + composition), then spawned gradually while
 * respecting both the active-zombie cap and the "not in front of the player"
 * spawn rule. The wave is clear only after every planned zombie spawned and the
 * live count has been zero for a short settle period, which avoids ending a wave
 * during the gap between two spawns.
 */
export class WaveManager {
  private readonly events: EventBus<GameEvents>;
  private readonly spawner: ZombieSpawner;
  private readonly random: RandomSource;
  private availableKinds: readonly ZombieKind[];
  private activeCap: number;

  private wave = 0;
  private phase: WavePhase = 'idle';
  private queue: ZombieKind[] = [];
  private spawnedThisWave = 0;
  private totalThisWave = 0;
  private spawnTimer = 0;
  private breakTimer = 0;
  private settleTimer = WAVES.clearSettleSeconds;
  /** Seconds spent in the clearing phase, and how often stragglers were already recalled. */
  private clearingSeconds = 0;
  private recalls = 0;

  constructor(deps: WaveManagerDeps) {
    this.events = deps.events;
    this.spawner = deps.spawner;
    this.random = deps.random;
    this.activeCap = deps.activeCap;
    this.availableKinds = deps.availableKinds ?? ['walker', 'runner', 'tank'];
  }

  setAvailableKinds(kinds: readonly ZombieKind[]): void {
    this.availableKinds = kinds;
  }

  get currentWave(): number {
    return this.wave;
  }

  get currentPhase(): WavePhase {
    return this.phase;
  }

  get remainingInWave(): number {
    return this.queue.length + this.spawner.count;
  }

  /** How often stragglers had to be recalled this run, for the HUD and the smoke test. */
  get stragglerRecalls(): number {
    return this.recalls;
  }

  get stats(): WaveStats {
    return {
      wave: this.wave,
      total: this.totalThisWave,
      spawned: this.spawnedThisWave,
      remaining: this.remainingInWave,
      phase: this.phase,
      secondsUntilNextWave: this.breakTimer,
    };
  }

  setActiveCap(cap: number): void {
    this.activeCap = cap;
    this.spawner.maxActive = Math.max(1, cap);
  }

  /** Starts the run: first wave arrives after the configured delay. */
  start(): void {
    this.wave = 0;
    this.phase = 'break';
    this.breakTimer = WAVES.firstWaveDelay;
    this.queue = [];
    this.spawnedThisWave = 0;
    this.totalThisWave = 0;
    this.settleTimer = WAVES.clearSettleSeconds;
    this.clearingSeconds = 0;
    this.recalls = 0;
  }

  reset(): void {
    this.wave = 0;
    this.phase = 'idle';
    this.queue = [];
    this.spawnedThisWave = 0;
    this.totalThisWave = 0;
    this.spawnTimer = 0;
    this.breakTimer = 0;
    this.settleTimer = WAVES.clearSettleSeconds;
    this.clearingSeconds = 0;
    this.recalls = 0;
  }

  /** Forces the next wave to start on the following update (debug/restart aid). */
  skipBreak(): void {
    if (this.phase === 'break') this.breakTimer = 0;
  }

  update(delta: number, context: WaveContext): void {
    if (this.phase === 'idle' || this.phase === 'finished') return;

    if (this.phase === 'break') {
      this.breakTimer -= delta;
      if (this.breakTimer <= 0) this.beginWave();
      return;
    }

    this.spawner.maxActive = Math.max(1, Math.min(this.activeCap, waveActiveCap(this.wave)));

    // --- spawning -----------------------------------------------------------
    if (this.queue.length > 0) {
      this.spawnTimer -= delta;
      const hasRoom = this.spawner.count < this.spawner.maxActive;
      if (this.spawnTimer <= 0 && hasRoom) {
        const kind = this.queue[0];
        const point = pickSpawnPoint({
          playerX: context.playerX,
          playerZ: context.playerZ,
          playerYaw: context.playerYaw,
          grid: context.surface,
          random: this.random,
        });
        if (point) {
          const spawned = this.spawner.spawn(kind, point.x, point.z, 0);
          if (spawned !== null) {
            this.queue.shift();
            this.spawnedThisWave += 1;
            this.spawnTimer = this.random.range(WAVES.spawnIntervalMin, WAVES.spawnIntervalMax);
          }
        } else {
          // No valid spawn point this tick: retry shortly instead of dropping
          // the zombie from the wave.
          this.spawnTimer = 0.5;
        }
      }
      this.emitRemaining();
      return;
    }

    // --- clearing -----------------------------------------------------------
    if (this.spawner.count > 0) {
      this.settleTimer = WAVES.clearSettleSeconds;
      this.phase = 'clearing';
      this.clearingSeconds += delta;
      if (this.clearingSeconds >= WAVES.stragglerRecallSeconds
        && this.recalls < WAVES.maxStragglerRecalls
        && this.spawner.recallNear) {
        this.recalls += 1;
        this.clearingSeconds = 0;
        const moved = this.spawner.recallNear(context.playerX, context.playerZ, context.playerYaw);
        if (moved > 0) this.events.emit('wave:stragglers-recalled', { wave: this.wave, moved });
      }
      this.emitRemaining();
      return;
    }
    this.clearingSeconds = 0;
    this.recalls = 0;

    this.settleTimer -= delta;
    if (this.settleTimer <= 0) {
      this.events.emit('wave:cleared', { wave: this.wave });
      this.phase = 'break';
      this.breakTimer = WAVES.breakSeconds;
    }
  }

  private beginWave(): void {
    this.wave += 1;
    const total = waveTotalCount(this.wave);
    const composition = waveComposition(this.wave, total);
    this.queue = [];
    const allowed = (kind: ZombieKind): boolean => this.availableKinds.includes(kind);
    const fallback: ZombieKind | null = allowed('walker')
      ? 'walker'
      : (this.availableKinds[0] ?? null);
    const push = (kind: ZombieKind, count: number): void => {
      if (count <= 0) return;
      // A variant whose model failed to load is replaced by the base kind so the
      // wave keeps its planned size instead of silently shrinking.
      const actual = allowed(kind) ? kind : fallback;
      if (!actual) return;
      for (let i = 0; i < count; i += 1) this.queue.push(actual);
    };
    push('walker', composition.walker);
    push('runner', composition.runner);
    push('tank', composition.tank);
    shuffle(this.queue, this.random);

    this.totalThisWave = this.queue.length;
    this.spawnedThisWave = 0;
    this.spawnTimer = 0.4;
    this.settleTimer = WAVES.clearSettleSeconds;
    this.phase = 'spawning';
    this.spawner.maxActive = Math.max(1, Math.min(this.activeCap, waveActiveCap(this.wave)));

    this.events.emit('wave:started', {
      wave: this.wave,
      total: this.totalThisWave,
      composition,
    });
    this.emitRemaining();
  }

  private emitRemaining(): void {
    this.events.emit('wave:remaining', {
      remaining: this.remainingInWave,
      total: this.totalThisWave,
    });
  }
}

/** Fisher-Yates with the injected generator so wave order is reproducible. */
function shuffle<T>(items: T[], random: RandomSource): void {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = random.int(0, i + 1);
    const tmp = items[i];
    items[i] = items[j];
    items[j] = tmp;
  }
}
