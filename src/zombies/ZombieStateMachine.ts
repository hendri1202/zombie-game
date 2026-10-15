import { ZOMBIE_AI, type AnimationState, type ZombieStats } from '../app/gameConfig';

export type ZombieState = 'spawn' | 'wander' | 'chase' | 'attack' | 'hit' | 'death' | 'despawned';

export interface ZombieSensors {
  distanceToPlayer: number;
  hasLineOfSight: boolean;
  playerAlive: boolean;
}

export interface ZombieDecision {
  state: ZombieState;
  /** Desired forward speed in metres per second for this step. */
  desiredSpeed: number;
  shouldMoveToPlayer: boolean;
  /** True when the AI would like a fresh path (the director decides who gets one). */
  wantsPath: boolean;
  /** Non-zero only on the single step where an attack lands. */
  attackDamage: number;
  animationState: AnimationState;
  /** True when the entity is finished and may be cleaned up. */
  removable: boolean;
}

export interface DamageOutcome {
  applied: number;
  died: boolean;
}

const SPAWN_DELAY_SECONDS = 0.55;
/** Below this distance a zombie notices the player even without line of sight. */
const SENSE_RADIUS = 9;

/**
 * Explicit zombie state machine.
 *
 * It owns no three.js objects, so state transitions, damage, attack cooldowns
 * and death can be unit tested directly. Decisions are returned as data; the
 * entity applies them to its transform and animation.
 */
export class ZombieStateMachine {
  readonly stats: ZombieStats;
  private currentState: ZombieState = 'spawn';
  private health: number;
  private spawnTimer = 0;
  private hitTimer = 0;
  private deathTimer = 0;
  private attackWindup = 0;
  private timeSinceAttack = Number.POSITIVE_INFINITY;
  private attackLanded = false;
  /** State to return to when a hit reaction finishes. */
  private resumeState: ZombieState = 'chase';

  constructor(stats: ZombieStats) {
    this.stats = stats;
    this.health = stats.maxHealth;
  }

  get state(): ZombieState {
    return this.currentState;
  }

  get currentHealth(): number {
    return this.health;
  }

  get healthFraction(): number {
    return this.health / this.stats.maxHealth;
  }

  get isAlive(): boolean {
    return this.currentState !== 'death' && this.currentState !== 'despawned';
  }

  get isRemovable(): boolean {
    return this.currentState === 'despawned';
  }

  reset(): void {
    this.currentState = 'spawn';
    this.health = this.stats.maxHealth;
    this.spawnTimer = 0;
    this.hitTimer = 0;
    this.deathTimer = 0;
    this.attackWindup = 0;
    this.timeSinceAttack = Number.POSITIVE_INFINITY;
    this.attackLanded = false;
    this.resumeState = 'chase';
  }

  /**
   * Applies damage. A lethal hit moves straight to DEATH and stops any attack
   * that was winding up, so a dying zombie cannot still land its swing.
   */
  applyDamage(amount: number): DamageOutcome {
    if (!this.isAlive || amount <= 0) return { applied: 0, died: false };
    const applied = Math.min(amount, this.health);
    this.health -= applied;
    if (this.health <= 0) {
      this.health = 0;
      this.currentState = 'death';
      this.deathTimer = 0;
      this.attackWindup = 0;
      this.attackLanded = false;
      return { applied, died: true };
    }
    if (this.currentState !== 'attack') {
      this.resumeState = this.currentState === 'spawn' ? 'chase' : this.currentState;
      this.currentState = 'hit';
      this.hitTimer = ZOMBIE_AI.hitReactionSeconds;
    }
    return { applied, died: false };
  }

  /** Called when the entity could not make progress; forces a fresh path. */
  notifyStuck(): void {
    if (this.currentState === 'chase') this.repathRequested = true;
  }

  private repathRequested = false;

  update(delta: number, sensors: ZombieSensors): ZombieDecision {
    if (this.currentState === 'death') {
      this.deathTimer += delta;
      return {
        state: 'death',
        desiredSpeed: 0,
        shouldMoveToPlayer: false,
        wantsPath: false,
        attackDamage: 0,
        animationState: 'death',
        removable: this.deathTimer >= this.stats.deathSeconds,
      };
    }
    if (this.currentState === 'despawned') {
      return {
        state: 'despawned',
        desiredSpeed: 0,
        shouldMoveToPlayer: false,
        wantsPath: false,
        attackDamage: 0,
        animationState: 'death',
        removable: true,
      };
    }

    if (this.timeSinceAttack < Number.POSITIVE_INFINITY) this.timeSinceAttack += delta;

    // --- hit reaction -------------------------------------------------------
    if (this.currentState === 'hit') {
      this.hitTimer -= delta;
      if (this.hitTimer <= 0) this.currentState = this.resumeState;
    }

    // --- spawn --------------------------------------------------------------
    if (this.currentState === 'spawn') {
      this.spawnTimer += delta;
      if (this.spawnTimer >= SPAWN_DELAY_SECONDS) this.currentState = 'wander';
    }

    // --- attack windup ------------------------------------------------------
    if (this.currentState === 'attack') {
      this.attackWindup -= delta;
      if (this.attackWindup <= 0 && !this.attackLanded) {
        this.attackLanded = true;
        this.timeSinceAttack = 0;
        const damage = sensors.distanceToPlayer <= this.stats.attackRange * 1.25 ? this.stats.attackDamage : 0;
        this.currentState = 'chase';
        return {
          state: 'chase',
          desiredSpeed: this.stats.chaseSpeed,
          shouldMoveToPlayer: true,
          wantsPath: false,
          attackDamage: damage,
          animationState: 'run',
          removable: false,
        };
      }
      return {
        state: 'attack',
        desiredSpeed: 0,
        shouldMoveToPlayer: false,
        wantsPath: false,
        attackDamage: 0,
        animationState: 'attack',
        removable: false,
      };
    }

    // --- target acquisition -------------------------------------------------
    const canSense = sensors.playerAlive
      && sensors.distanceToPlayer <= ZOMBIE_AI.maxTargetRange
      && (sensors.hasLineOfSight
        || sensors.distanceToPlayer <= SENSE_RADIUS
        || sensors.distanceToPlayer <= ZOMBIE_AI.sightRange);

    if (!canSense || sensors.distanceToPlayer > ZOMBIE_AI.loseTargetRange) {
      this.currentState = 'wander';
    } else if (this.currentState === 'wander' || this.currentState === 'hit') {
      this.currentState = 'chase';
    }

    if (this.currentState === 'chase') {
      // Attack only when in range, off cooldown, and roughly facing the player.
      if (
        sensors.distanceToPlayer <= this.stats.attackRange
        && this.timeSinceAttack >= this.stats.attackCooldown
      ) {
        this.currentState = 'attack';
        this.attackWindup = this.stats.attackImpactDelay;
        this.attackLanded = false;
        return {
          state: 'attack',
          desiredSpeed: 0,
          shouldMoveToPlayer: false,
          wantsPath: false,
          attackDamage: 0,
          animationState: 'attack',
          removable: false,
        };
      }
      const wantsPath = this.repathRequested;
      this.repathRequested = false;
      return {
        state: 'chase',
        desiredSpeed: this.stats.chaseSpeed,
        shouldMoveToPlayer: true,
        wantsPath,
        attackDamage: 0,
        animationState: 'run',
        removable: false,
      };
    }

    const wantsPath = this.repathRequested;
    this.repathRequested = false;
    return {
      state: 'wander',
      desiredSpeed: this.stats.walkSpeed,
      shouldMoveToPlayer: false,
      wantsPath,
      attackDamage: 0,
      animationState: 'idle',
      removable: false,
    };
  }
}
