import { Object3D, Vector3 } from 'three';
import {
  ANIMATION, MODEL_FORWARD_YAW_OFFSET, NAV, type ZombieKind, type ZombieStats,
} from '../app/gameConfig';
import type { CollisionWorld } from '../level/CollisionWorld';
import { moveTowardsAngle, type RandomSource } from '../utils/math';
import type { NavigationGrid } from './NavigationGrid';
import { ZombieAnimator } from './ZombieAnimator';
import { ZombieStateMachine, type ZombieState } from './ZombieStateMachine';

export interface ZombieStepContext {
  delta: number;
  playerPosition: Vector3;
  playerAlive: boolean;
  collision: CollisionWorld;
  navigation: NavigationGrid;
  /** Per-step allowance for expensive A* requests, shared across all zombies. */
  pathBudget: { remaining: number };
  /** Steering offset that pushes this zombie away from its neighbours. */
  separationX: number;
  separationZ: number;
  random: RandomSource;
  /** Far zombies run their AI less often; the mixer keeps full frame rate. */
  distant: boolean;
}

export interface ZombieStepResult {
  /** Non-zero on the single step an attack lands. */
  attackDamageToPlayer: number;
  attacked: boolean;
}

/** AI ticks per second for zombies beyond WORLD.distantUpdateDistance. */
const DISTANT_AI_HZ = 12;
/** Seconds of no progress before the zombie asks for a different route. */
const STUCK_SECONDS = 1.6;

interface PathPoint {
  x: number;
  z: number;
}

/**
 * One zombie: transform, path following, animation and the state machine.
 *
 * Steering (desired direction, separation, obstacle push-out) is kept separate
 * from the render transform so AI behaviour stays readable and testable; the
 * mesh simply follows `position`/`yaw` at the end of the step.
 */
export class Zombie {
  readonly id: number;
  readonly kind: ZombieKind;
  readonly stats: ZombieStats;
  /** Root object placed in the scene; hitboxes are its children. */
  readonly root: Object3D;
  readonly position = new Vector3();
  readonly hitboxes: Object3D[] = [];
  yaw = 0;
  /** Set by the director when the entity should leave the world. */
  retired = false;

  private readonly machine: ZombieStateMachine;
  private readonly animator: ZombieAnimator;
  private readonly path: PathPoint[] = [];
  private pathIndex = 0;
  private repathTimer = 0;
  private lineOfSightTimer = 0;
  private hasLineOfSight = false;
  private stuckTimer = 0;
  private readonly lastProgressPosition = new Vector3();
  private accumulator = 0;
  private wanderTarget: PathPoint | null = null;
  private wanderPause = 0;
  private lastAnimationState = '';

  constructor(id: number, kind: ZombieKind, stats: ZombieStats, root: Object3D, animator: ZombieAnimator) {
    this.id = id;
    this.kind = kind;
    this.stats = stats;
    this.root = root;
    this.animator = animator;
    this.machine = new ZombieStateMachine(stats);
    // Stagger initial path requests so a wave does not compute every route on
    // the same frame.
    this.repathTimer = (id % 7) * NAV.pathRequestStagger;
  }

  get state(): ZombieState {
    return this.machine.state;
  }

  get isAlive(): boolean {
    return this.machine.isAlive;
  }

  get health(): number {
    return this.machine.currentHealth;
  }

  get isRemovable(): boolean {
    return this.machine.isRemovable;
  }

  /** Places the entity at a spawn point and clears any previous run state. */
  reset(x: number, z: number, yaw: number): void {
    this.position.set(x, 0, z);
    this.yaw = yaw;
    this.root.position.set(x, 0, z);
    this.root.rotation.y = yaw + MODEL_FORWARD_YAW_OFFSET;
    this.machine.reset();
    this.animator.reset();
    this.path.length = 0;
    this.pathIndex = 0;
    this.repathTimer = (this.id % 7) * NAV.pathRequestStagger;
    this.lineOfSightTimer = 0;
    this.hasLineOfSight = false;
    this.stuckTimer = 0;
    this.accumulator = 0;
    this.wanderTarget = null;
    this.wanderPause = 0;
    this.lastAnimationState = '';
    this.retired = false;
    this.lastProgressPosition.copy(this.position);
  }

  /** Routes damage through the state machine; returns true when it died. */
  applyDamage(amount: number): { applied: number; died: boolean } {
    const outcome = this.machine.applyDamage(amount);
    return { applied: outcome.applied, died: outcome.died };
  }

  get healthFraction(): number {
    return this.machine.healthFraction;
  }

  update(context: ZombieStepContext): ZombieStepResult {
    // The animation mixer always advances at full frame rate: throttled poses
    // look broken, and skinning is cheap compared to a path query.
    this.animator.update(context.delta);

    if (this.machine.isRemovable) {
      return { attackDamageToPlayer: 0, attacked: false };
    }

    if (context.distant) {
      this.accumulator += context.delta;
      const step = 1 / DISTANT_AI_HZ;
      if (this.accumulator < step) return { attackDamageToPlayer: 0, attacked: false };
      context = { ...context, delta: this.accumulator };
      this.accumulator = 0;
    }

    const delta = context.delta;
    const dx = context.playerPosition.x - this.position.x;
    const dz = context.playerPosition.z - this.position.z;
    const distance = Math.hypot(dx, dz);

    // Line of sight is the expensive sensor, so it runs a few times per second
    // rather than once per zombie per frame.
    this.lineOfSightTimer -= delta;
    if (this.lineOfSightTimer <= 0) {
      this.lineOfSightTimer = 0.22 + (this.id % 5) * 0.03;
      this.hasLineOfSight = distance < 8
        || context.collision.hasLineOfSight(this.position.x, this.position.z, context.playerPosition.x, context.playerPosition.z);
    }

    const decision = this.machine.update(delta, {
      distanceToPlayer: distance,
      hasLineOfSight: this.hasLineOfSight,
      playerAlive: context.playerAlive,
    });

    // One-shot states are unambiguous, so they are played straight away. The
    // locomotion states wait until the movement below has been applied, because
    // the choice between idle and walk depends on the distance actually covered.
    if (decision.state === 'death' || decision.state === 'despawned') {
      this.animator.setLocomotionSpeed(0);
      this.playAnimation('death', false);
      this.root.position.set(this.position.x, 0, this.position.z);
      return { attackDamageToPlayer: 0, attacked: false };
    }
    if (decision.state === 'attack' || decision.state === 'hit') {
      this.animator.setLocomotionSpeed(0);
      this.playAnimation(decision.state, false);
    }

    // --- movement -----------------------------------------------------------
    let desiredX = 0;
    let desiredZ = 0;

    if (decision.shouldMoveToPlayer) {
      this.updatePath(context, dx, dz, distance, decision.wantsPath);
      const steer = this.steerAlongPath(dx, dz, distance);
      desiredX = steer.x;
      desiredZ = steer.z;
    } else if (decision.state === 'wander') {
      const steer = this.wanderStep(context, delta);
      desiredX = steer.x;
      desiredZ = steer.z;
    }

    // Separation keeps the horde from collapsing into a single point.
    const separationLength = Math.hypot(context.separationX, context.separationZ);
    if (separationLength > 1e-4) {
      desiredX += context.separationX * NAV.separationStrength * 0.5;
      desiredZ += context.separationZ * NAV.separationStrength * 0.5;
    }

    const desiredLength = Math.hypot(desiredX, desiredZ);
    let appliedSpeed = 0;
    if (desiredLength > 1e-4 && decision.desiredSpeed > 0) {
      const speed = decision.desiredSpeed;
      const stepX = (desiredX / desiredLength) * speed * delta;
      const stepZ = (desiredZ / desiredLength) * speed * delta;
      this.position.x += stepX;
      this.position.z += stepZ;
      appliedSpeed = delta > 0 ? Math.hypot(stepX, stepZ) / delta : 0;
      this.yaw = moveTowardsAngle(
        this.yaw,
        Math.atan2(desiredX, desiredZ),
        (this.stats.turnSpeed * Math.PI / 180) * delta,
      );

      // Stuck detection: no net progress for a while means the route is bad.
      const progress = Math.hypot(this.position.x - this.lastProgressPosition.x, this.position.z - this.lastProgressPosition.z);
      if (progress < 0.02) {
        this.stuckTimer += delta;
        if (this.stuckTimer >= STUCK_SECONDS) {
          this.stuckTimer = 0;
          this.machine.notifyStuck();
          this.path.length = 0;
          this.pathIndex = 0;
          this.repathTimer = 0;
        }
      } else {
        this.stuckTimer = 0;
        this.lastProgressPosition.copy(this.position);
      }
    }

    // Push out of solid geometry so zombies never stand inside a wall.
    context.collision.resolveCircle(this.position, this.stats.radius);

    // Locomotion: the clip and its playback rate follow the measured movement,
    // so a wandering zombie walks instead of gliding along playing "idle", and
    // the stride keeps up with the ground speed instead of sliding.
    if (decision.state === 'chase' || decision.state === 'wander') {
      this.animator.setLocomotionSpeed(appliedSpeed);
      this.playAnimation(decision.state, appliedSpeed > ANIMATION.movingThreshold);
    }

    this.root.position.set(this.position.x, 0, this.position.z);
    this.root.rotation.y = this.yaw + MODEL_FORWARD_YAW_OFFSET;

    if (decision.attackDamage > 0) {
      return { attackDamageToPlayer: decision.attackDamage, attacked: true };
    }
    return { attackDamageToPlayer: 0, attacked: false };
  }

  /**
   * Selects the clip for this step.
   *
   * `moving` is measured from the movement actually applied this step, not from
   * the AI's intent: a wandering zombie used to play the idle clip while sliding
   * across the street, which reads as a bug immediately.
   */
  private playAnimation(state: string, moving: boolean): void {
    const key = `${state}:${moving ? 'move' : 'still'}`;
    if (key === this.lastAnimationState) return;
    this.lastAnimationState = key;

    switch (state) {
      case 'chase':
        this.animator.play('run', { fade: ANIMATION.fadeLocomotion });
        break;
      case 'attack':
        this.animator.play('attack', { restart: true, fade: ANIMATION.fadeOneShot });
        break;
      case 'hit':
        this.animator.play('hit', { restart: true, fade: ANIMATION.fadeOneShot });
        break;
      case 'death':
        this.animator.play('death', { restart: true, fade: ANIMATION.fadeDeath });
        break;
      default:
        if (moving) this.animator.play('walk', { fade: ANIMATION.fadeLocomotion });
        else this.animator.play('idle', { fade: ANIMATION.fadeLocomotion });
        break;
    }
  }

  /**
   * Requests a path when there is none, when the cooldown expired, or when the
   * player walked far enough away from the last planned goal. A request is only
   * honoured while the shared per-step budget lasts.
   */
  private updatePath(
    context: ZombieStepContext,
    dx: number,
    dz: number,
    distance: number,
    forced: boolean,
  ): void {
    this.repathTimer -= context.delta;
    const pathEnd = this.path.length > 0 ? this.path[this.path.length - 1] : null;
    const endDrift = pathEnd ? Math.hypot(pathEnd.x - context.playerPosition.x, pathEnd.z - context.playerPosition.z) : Number.POSITIVE_INFINITY;
    const routeEnded = this.path.length === 0 || this.pathIndex >= this.path.length;

    const needsPath = forced
      || routeEnded
      || endDrift > NAV.repathDistance
      || this.repathTimer <= 0;

    if (!needsPath) return;
    if (context.pathBudget.remaining <= 0) return;
    context.pathBudget.remaining -= 1;
    this.repathTimer = NAV.repathInterval;

    const route = context.navigation.findPathWorld(
      this.position.x,
      this.position.z,
      context.playerPosition.x,
      context.playerPosition.z,
    );

    this.path.length = 0;
    this.pathIndex = 0;
    if (!route || route.length === 0) {
      // No route (player behind geometry the grid cannot cross): fall back to
      // moving straight at the player, the collision push-out keeps it sane.
      this.path.push({ x: context.playerPosition.x, z: context.playerPosition.z });
      return;
    }
    for (const point of route) this.path.push(point);
    if (distance < 2) this.path.length = 0;
    void dx;
    void dz;
  }

  /** Direction toward the next waypoint (or straight at the player when close). */
  private steerAlongPath(dx: number, dz: number, distance: number): { x: number; z: number } {
    if (distance < 1.6 || this.path.length === 0) {
      return { x: dx, z: dz };
    }
    let point = this.path[this.pathIndex];
    while (point) {
      const toX = point.x - this.position.x;
      const toZ = point.z - this.position.z;
      if (Math.hypot(toX, toZ) > 0.55) return { x: toX, z: toZ };
      this.pathIndex += 1;
      point = this.path[this.pathIndex];
    }
    return { x: dx, z: dz };
  }

  /** Short-range idle movement so spawned zombies are not statues. */
  private wanderStep(context: ZombieStepContext, delta: number): { x: number; z: number } {
    if (this.wanderPause > 0) {
      this.wanderPause -= delta;
      return { x: 0, z: 0 };
    }
    if (!this.wanderTarget) {
      const angle = context.random.range(0, Math.PI * 2);
      const radius = context.random.range(1.5, 6);
      const targetX = this.position.x + Math.cos(angle) * radius;
      const targetZ = this.position.z + Math.sin(angle) * radius;
      const inBounds = context.navigation.isWalkableWorld(targetX, targetZ);
      this.wanderTarget = inBounds ? { x: targetX, z: targetZ } : null;
      if (!this.wanderTarget) this.wanderPause = 0.5;
      return { x: 0, z: 0 };
    }
    const toX = this.wanderTarget.x - this.position.x;
    const toZ = this.wanderTarget.z - this.position.z;
    if (Math.hypot(toX, toZ) < 0.6) {
      this.wanderTarget = null;
      this.wanderPause = context.random.range(1.2, 3.5);
      return { x: 0, z: 0 };
    }
    return { x: toX, z: toZ };
  }

  /**
   * Removes the entity from the scene but keeps it reusable.
   *
   * The director pools retired zombies, so everything the entity needs to work
   * again must survive: only the root leaves the scene (its children, the
   * hitboxes, go with it) and the mixer is stopped. Detaching the hitboxes here
   * would make a pooled zombie permanently un-hittable.
   */
  retire(): void {
    this.animator.reset();
    this.root.removeFromParent();
    this.path.length = 0;
    this.pathIndex = 0;
    this.retired = true;
  }

  /** Final teardown. The entity is not reused after this. */
  dispose(): void {
    this.animator.dispose();
    for (const hitbox of this.hitboxes) hitbox.removeFromParent();
    this.hitboxes.length = 0;
    this.root.removeFromParent();
  }
}
