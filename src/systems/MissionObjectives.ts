import {
  CylinderGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, OctahedronGeometry, PointLight,
  RingGeometry, Scene,
} from 'three';
import { MISSION, WORLD } from '../app/gameConfig';
import type { EventBus } from '../core/EventBus';
import type { GameEvents } from '../app/GameEvents';
import {
  compassBearing, formatObjectiveInstruction, pickObjectivePoint, relativeBearing,
  type ObjectivePoint,
} from '../level/ObjectivePoints';
import type { NavigationGrid } from '../zombies/NavigationGrid';
import type { RandomSource } from '../utils/math';

export interface MissionObjectiveDeps {
  scene: Scene;
  events: EventBus<GameEvents>;
  grid: NavigationGrid;
  random: RandomSource;
  /** Objectives needed to finish the run; defaults to MISSION.objectiveCount. */
  total?: number;
}

export interface ObjectiveContext {
  playerX: number;
  playerZ: number;
}

const MARKER_COLOR = 0xffd166;
const BEAM_COLOR = 0xffb347;

/**
 * Directional mission objectives: one lit point per wave, all of them reached to win.
 *
 * Deliberately a layer on top of the wave director and nothing more. It does not spawn,
 * count or remove zombies, and it never touches wave timing — the horde keeps arriving
 * exactly as it did, and the marked point is a second thing the player has to do at the
 * same time. A completed objective simply moves the marker somewhere new; the mission ends
 * only after the last one.
 *
 * The marker is built unlit and emissive on purpose: a MeshBasicMaterial ignores the scene
 * lights, so the point is equally visible in the dark of the block as in daylight, which is
 * the only way "follow the light" can work.
 */
export class MissionObjectives {
  private readonly events: EventBus<GameEvents>;
  private readonly grid: NavigationGrid;
  private readonly random: RandomSource;
  private readonly marker: Group;
  private readonly ring: Mesh<RingGeometry, MeshBasicMaterial>;
  private readonly beam: Mesh<CylinderGeometry, MeshBasicMaterial>;
  private readonly core: Mesh<OctahedronGeometry, MeshBasicMaterial>;
  private readonly light: PointLight;

  /** Objectives to reach for the run to be won. */
  readonly total: number;
  private completedCount = 0;
  private finished = false;
  private active: ObjectivePoint | null = null;
  /** Seconds since the run started, used only to phase the marker's pulse. */
  private elapsed = 0;

  constructor(deps: MissionObjectiveDeps) {
    this.events = deps.events;
    this.grid = deps.grid;
    this.random = deps.random;
    this.total = deps.total ?? MISSION.objectiveCount;

    this.marker = new Group();
    this.marker.visible = false;

    this.ring = new Mesh(
      new RingGeometry(0.95, 1.45, 40),
      new MeshBasicMaterial({ color: MARKER_COLOR, transparent: true, opacity: 0.85, side: DoubleSide }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.06;

    this.beam = new Mesh(
      new CylinderGeometry(0.12, 0.12, MISSION.beamHeight, 12, 1, true),
      new MeshBasicMaterial({
        color: BEAM_COLOR, transparent: true, opacity: 0.32, depthWrite: false, side: DoubleSide,
      }),
    );
    this.beam.position.y = MISSION.beamHeight / 2;

    this.core = new Mesh(
      new OctahedronGeometry(0.42),
      new MeshBasicMaterial({ color: 0xfff2c8 }),
    );
    this.core.position.y = 2.0;

    this.light = new PointLight(BEAM_COLOR, 0, 22, 2);
    this.light.position.set(0, 2.2, 0);

    this.marker.add(this.ring, this.beam, this.core);
    deps.scene.add(this.marker);
    // The glow is added straight to the scene, outside the marker group, and pinned at zero
    // intensity until a point is set. That is deliberate: three keys a compiled shader on the
    // number of lights, so a light that appears with the first objective would rebuild every
    // material in view on that one frame — the stall `warmShaderCache` exists to avoid. A
    // permanent light with a driven intensity keeps the count fixed and is compiled once with
    // the rest during loading.
    deps.scene.add(this.light);
  }

  /** Objectives completed so far. */
  get completed(): number {
    return this.completedCount;
  }

  /** Objectives still to reach. */
  get remaining(): number {
    return Math.max(0, this.total - this.completedCount);
  }

  /** True once every objective has been reached. */
  get isComplete(): boolean {
    return this.finished;
  }

  /** The current marked point, or null before the run starts and after it is won. */
  get point(): ObjectivePoint | null {
    return this.active;
  }

  /** True while the marker is drawn in the world; false before the run and once won. */
  get markerVisible(): boolean {
    return this.marker.visible;
  }

  /**
   * Clears the mission back to its pre-run state without touching the grid.
   *
   * Called on every run start, so the second run of a session begins with objective one of
   * eight rather than whatever count the previous run left behind.
   */
  reset(): void {
    this.completedCount = 0;
    this.finished = false;
    this.active = null;
    this.elapsed = 0;
    this.marker.visible = false;
    // The glow is a separate scene object, so hiding the marker does not dim it on its own.
    this.light.intensity = 0;
  }

  /**
   * Ends the mission without erasing what was reached: the marker goes, the count stays.
   *
   * Used when the run ends for another reason (the player died, or left to the title). The
   * counters are kept because "how many objectives did that run reach" is exactly what a
   * results or debug readout wants to know after a death, and zeroing them would report a
   * run that reached five points as reaching none.
   */
  stop(): void {
    this.active = null;
    this.marker.visible = false;
    this.light.intensity = 0;
  }

  /** Starts the mission, placing the first marked point relative to the player. */
  start(playerX: number, playerZ: number): void {
    this.reset();
    this.advance(playerX, playerZ);
  }

  update(delta: number, context: ObjectiveContext): void {
    if (this.marker.visible) {
      this.elapsed += delta;
      const pulse = 0.5 + 0.5 * Math.sin(this.elapsed * 2.4);
      // The core spins and bobs; the beam and ring breathe. Motion is what separates a lit
      // objective from a bit of street furniture the player walks past.
      this.core.rotation.y += delta * 1.6;
      this.core.position.y = 2.0 + Math.sin(this.elapsed * 1.8) * 0.18;
      this.beam.material.opacity = 0.22 + 0.22 * pulse;
      this.ring.material.opacity = 0.55 + 0.35 * pulse;
      this.ring.scale.setScalar(1 + pulse * 0.06);
      this.light.intensity = 4 + 3 * pulse;
    } else {
      // The light lives outside the group, so it has to be put out explicitly.
      this.light.intensity = 0;
    }
    if (this.finished || !this.active) return;

    const distance = Math.hypot(this.active.x - context.playerX, this.active.z - context.playerZ);
    if (distance <= MISSION.reachRadius) this.reach(context.playerX, context.playerZ);
  }

  /** Distance from a world position to the current objective, or null when there is none. */
  distanceTo(x: number, z: number): number | null {
    if (!this.active) return null;
    return Math.hypot(this.active.x - x, this.active.z - z);
  }

  /** True when a world position is inside the completion radius of the current objective. */
  isReached(x: number, z: number): boolean {
    const distance = this.distanceTo(x, z);
    return distance !== null && distance <= MISSION.reachRadius;
  }

  /** Bearing of the objective relative to a facing yaw, radians; 0 means straight ahead. */
  bearingFrom(x: number, z: number, yaw: number): number | null {
    if (!this.active) return null;
    return relativeBearing(yaw, this.active.x - x, this.active.z - z);
  }

  /** The HUD instruction line, or an empty string when no objective is active. */
  instructionFrom(x: number, z: number): string {
    if (!this.active) return '';
    const dx = this.active.x - x;
    const dz = this.active.z - z;
    return formatObjectiveInstruction({
      distance: Math.hypot(dx, dz),
      bearing: compassBearing(dx, dz),
    });
  }

  dispose(): void {
    this.marker.removeFromParent();
    this.ring.geometry.dispose();
    this.ring.material.dispose();
    this.beam.geometry.dispose();
    this.beam.material.dispose();
    this.core.geometry.dispose();
    this.core.material.dispose();
    this.light.removeFromParent();
    this.light.dispose();
  }

  /** Marks the current objective done, then either moves the marker or ends the mission. */
  private reach(playerX: number, playerZ: number): void {
    const reached = this.active;
    if (!reached) return;
    this.completedCount += 1;
    this.events.emit('objective:reached', {
      completed: this.completedCount,
      total: this.total,
      x: reached.x,
      z: reached.z,
    });

    if (this.completedCount >= this.total) {
      this.finished = true;
      this.active = null;
      this.marker.visible = false;
      this.light.intensity = 0;
      this.events.emit('mission:complete', { objectives: this.completedCount });
      return;
    }
    // Straight to the next point: the horde does not pause just because the player arrived,
    // so neither does the mission.
    this.advance(playerX, playerZ);
  }

  /**
   * Chooses and places the next marked point.
   *
   * A null here means the map offered no walkable cell at all, which cannot happen on the
   * built level; the mission then simply holds its current (none) point rather than
   * throwing. See ObjectivePoints for why the point is always inside the player's region.
   */
  private advance(playerX: number, playerZ: number): void {
    const next = pickObjectivePoint({
      playerX,
      playerZ,
      grid: this.grid,
      random: this.random,
    });
    if (!next) {
      this.active = null;
      this.marker.visible = false;
      this.light.intensity = 0;
      return;
    }
    this.active = next;
    this.placeMarker(next);
    this.events.emit('objective:updated', {
      index: this.completedCount + 1,
      total: this.total,
      x: next.x,
      z: next.z,
    });
  }

  private placeMarker(point: ObjectivePoint): void {
    this.marker.position.set(point.x, WORLD.groundLevel, point.z);
    this.marker.visible = true;
    // The glow is a sibling of the marker, not a child, so it is moved by hand.
    this.light.position.set(point.x, 2.2, point.z);
  }
}
