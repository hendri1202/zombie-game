import { Box3, Camera, Group, Object3D, Raycaster, Vector3 } from 'three';
import {
  HANDS_PLACEMENT, createFirstPersonHands, type GripKind,
} from './proceduralArms';
import {
  STARTING_LOADOUT, STARTING_WEAPON, WEAPON_FEEL, WEAPONS, type WeaponConfig, type WeaponId,
} from '../app/gameConfig';
import type { EventBus } from '../core/EventBus';
import type { GameEvents } from '../app/GameEvents';
import type { DamageSystem, HitscanReport } from '../combat/DamageSystem';
import { WeaponRuntime } from '../combat/WeaponRuntime';
import type { InputSnapshot } from '../input/InputManager';
import { clamp, damp } from '../utils/math';
import type { PlayerController } from './PlayerController';

export interface WeaponControllerDeps {
  camera: Camera;
  events: EventBus<GameEvents>;
  damage: DamageSystem;
  player: PlayerController;
  /** Optional external view models, keyed by weapon id. */
  viewModels?: Map<WeaponId, Object3D>;
}

export interface WeaponView {
  weaponId: WeaponId;
  name: string;
  magazine: number;
  reserve: number;
  reloading: boolean;
  reloadProgress: number;
  /** 0..1, drives the crosshair bloom. */
  spread: number;
  firing: boolean;
}

/**
 * Owns the player's weapons: firing cadence, reload, switching, recoil, the
 * first-person view model and muzzle flash.
 *
 * Only fires while the caller says the simulation is active, so shooting behind
 * the pause menu is impossible by construction rather than by convention.
 */
/**
 * Seconds the weapon takes to come back up after a switch. Lowering and raising
 * on swap is what makes a weapon change read as an action instead of a teleport.
 */
const WEAPON_EQUIP_SECONDS = 0.28;
/**
 * Relative size of the first-person weapon after normalisation.
 *
 * Measured on a captured frame: at 0.5 the weapon covered ~1.5% of the screen and
 * read as a distant prop rather than a held weapon, so it is nudged up.
 */
const WEAPON_VIEW_MODEL_SCALE = 0.62;
/** Extra pitch applied while reloading, radians. */
const WEAPON_RELOAD_TILT = -0.42;
/** How far the weapon drops while lowered, metres. */
const WEAPON_LOWERED_DROP = 0.26;

export class WeaponController {
  private readonly runtimes = new Map<WeaponId, WeaponRuntime>();
  private readonly order: WeaponId[] = [...STARTING_LOADOUT];
  private current: WeaponId = STARTING_WEAPON;
  private readonly camera: Camera;
  private readonly events: EventBus<GameEvents>;
  private readonly damage: DamageSystem;
  private readonly player: PlayerController;
  private readonly viewModelRoot = new Group();
  /**
   * Per-weapon wrapper. `applyViewModelTransform` positions and scales this
   * wrapper; the normalised model keeps its own scale inside it, so the config
   * value acts as a multiplier of the normalised size instead of replacing it.
   */
  private readonly viewModelHolder = new Group();
  private readonly viewModels = new Map<WeaponId, Object3D>();
  /**
   * First-person hands, one pair per grip pose.
   *
   * Built once and kept: a pair is a dozen small meshes, and rebuilding them on every
   * weapon switch would stutter exactly when the player is looking at them.
   */
  private readonly hands = new Map<GripKind, Group>();
  private mountedHands: Group | null = null;
  // The muzzle flash and its light used to live here, bolted to the view model. They are
  // now the MuzzleFlash system in world space: in third person a light parented to the
  // view model lit the space around the camera instead of the space around the barrel.

  private spreadCurrent = 0;
  private swayX = 0;
  private swayY = 0;
  private readonly aimDirection = new Vector3();
  private readonly origin = new Vector3();
  private readonly holdPosition = new Vector3();
  /** Muzzle and ejection port in view-model space, from WEAPON_FEEL's offsets. */
  private readonly muzzleOffset = new Vector3(
    WEAPON_FEEL.muzzleOffset[0], WEAPON_FEEL.muzzleOffset[1], WEAPON_FEEL.muzzleOffset[2],
  );
  private readonly ejectionOffset = new Vector3(
    WEAPON_FEEL.ejectionPortOffset[0], WEAPON_FEEL.ejectionPortOffset[1],
    WEAPON_FEEL.ejectionPortOffset[2],
  );
  private mountedViewModel: Object3D | null = null;
  /** Counts down after a weapon switch; drives the lower/raise offset. */
  private equipTimer = 0;
  /** Smoothed 0..1 blend for the reload tilt. */
  private reloadBlend = 0;
  /** Survivor modifiers: below 1 reloads faster, above 1 hits harder. */
  private reloadMultiplier = 1;
  private damageMultiplier = 1;
  /** 1 right after a shot, decaying to 0; drives the weapon kick. */
  private kick = 0;

  constructor(deps: WeaponControllerDeps) {
    this.camera = deps.camera;
    this.events = deps.events;
    this.damage = deps.damage;
    this.player = deps.player;

    for (const id of Object.keys(WEAPONS) as WeaponId[]) {
      this.runtimes.set(id, new WeaponRuntime(WEAPONS[id]));
    }
    for (const id of this.order) this.runtimes.get(id)?.setOwned(true);

    this.viewModelRoot.name = 'weapon-view-model';
    this.viewModelRoot.renderOrder = 10;
    this.viewModelRoot.add(this.viewModelHolder);
    this.camera.add(this.viewModelRoot);

    if (deps.viewModels) {
      for (const [id, model] of deps.viewModels) this.viewModels.set(id, model);
    }

    this.applyViewModelTransform();
  }

  get activeWeapon(): WeaponConfig {
    return WEAPONS[this.current];
  }

  get ownedWeapons(): WeaponId[] {
    return [...this.order];
  }

  get snapshot(): WeaponView {
    const runtime = this.runtimes.get(this.current);
    const state = runtime ? runtime.snapshot() : null;
    return {
      weaponId: this.current,
      name: this.activeWeapon.name,
      magazine: state?.magazine ?? 0,
      reserve: state?.reserve ?? 0,
      reloading: state?.reloading ?? false,
      reloadProgress: state?.reloadProgress ?? 0,
      spread: clamp(this.spreadCurrent / this.activeWeapon.spread, 0, 1),
      firing: false,
    };
  }

  reset(): void {
    this.order.length = 0;
    for (const id of STARTING_LOADOUT) this.order.push(id);
    for (const runtime of this.runtimes.values()) {
      runtime.reset();
      runtime.setOwned(false);
    }
    for (const id of this.order) this.runtimes.get(id)?.setOwned(true);
    this.current = STARTING_WEAPON;
    this.spreadCurrent = 0;
    this.equipTimer = 0;
    this.reloadBlend = 0;
    this.applyViewModelTransform();
  }

  /** Adds a weapon to the loadout and switches to it. */
  unlock(id: WeaponId): boolean {
    if (this.order.includes(id)) {
      // Already owned: treat a duplicate pickup as ammo instead.
      this.runtimes.get(id)?.addReserve(WEAPONS[id].magazineSize * 2);
      return false;
    }
    this.order.push(id);
    this.runtimes.get(id)?.setOwned(true);
    this.events.emit('weapon:unlocked', { weaponId: id });
    this.switchTo(id);
    return true;
  }

  addReserve(id: WeaponId, amount: number): number {
    return this.runtimes.get(id)?.addReserve(amount) ?? 0;
  }

  addMagazine(id: WeaponId, amount: number): number {
    return this.runtimes.get(id)?.addMagazine(amount) ?? 0;
  }

  switchTo(id: WeaponId): boolean {
    if (!this.order.includes(id) || id === this.current) return false;
    this.runtimes.get(this.current)?.cancelReload();
    this.current = id;
    // Lower the new weapon and let update() raise it again.
    this.equipTimer = WEAPON_EQUIP_SECONDS;
    this.applyViewModelTransform();
    this.events.emit('weapon:switched', { weaponId: id });
    return true;
  }

  /** Slot 1/2 request from the keyboard. */
  switchSlot(slot: number): boolean {
    const target = this.order.find((id) => WEAPONS[id].slot === slot);
    if (!target) return false;
    return this.switchTo(target);
  }

  /**
   * Timers advance even when paused (with delta 0) so a reload started before
   * pausing finishes exactly when the player resumes.
   */
  update(delta: number, input: InputSnapshot | null, active: boolean): void {
    for (const runtime of this.runtimes.values()) runtime.update(active ? delta : 0);

    this.spreadCurrent = damp(this.spreadCurrent, 0, 8, delta);
    if (this.equipTimer > 0) this.equipTimer = Math.max(0, this.equipTimer - delta);
    const reloading = this.runtimes.get(this.current)?.isReloading ?? false;
    this.reloadBlend = damp(this.reloadBlend, reloading ? 1 : 0, 9, delta);
    // Kick settles fast so rapid fire re-triggers the push rather than stacking it.
    this.kick = damp(this.kick, 0, WEAPON_FEEL.kickRecover, delta);

    // Idle sway follows the look delta for a bit of weapon weight.
    if (input) {
      this.swayX = damp(this.swayX, clamp(-input.lookX * 0.0006, -0.02, 0.02), 9, delta);
      this.swayY = damp(this.swayY, clamp(-input.lookY * 0.0006, -0.02, 0.02), 9, delta);
    } else {
      this.swayX = damp(this.swayX, 0, 9, delta);
      this.swayY = damp(this.swayY, 0, 9, delta);
    }
    this.applyViewModelTransform();

    if (!active || !input) return;

    if (input.weaponSlotRequested !== null) this.switchSlot(input.weaponSlotRequested);

    if (input.reloadPressed) {
      const runtime = this.runtimes.get(this.current);
      if (runtime?.startReload(this.reloadMultiplier)) {
        this.events.emit('weapon:reload-started', {
          weaponId: this.current,
          seconds: runtime.currentReloadSeconds,
        });
      }
    }

    const config = this.activeWeapon;
    // Automatic weapons fire while held; semi-automatic ones need a new press.
    const wantsFire = config.automatic ? input.firing : input.firePressed;
    if (wantsFire) this.tryFire();
  }

  /**
   * Fires once if the weapon is ready.
   *
   * Returns what the shot hit (null when the weapon could not fire), so callers
   * and the headless verification harness can distinguish a miss from a world
   * hit from a zombie hit.
   */
  /** Applies the chosen survivor's handling and damage modifiers. */
  setCharacterModifiers(reloadMultiplier: number, damageMultiplier: number): void {
    this.reloadMultiplier = reloadMultiplier;
    this.damageMultiplier = damageMultiplier;
  }

  /**
   * Shows or hides the first-person view model.
   *
   * In third person the character's own hands-on-gun animation is what the player
   * sees, so a floating weapon in front of the camera would be duplicated kit.
   */
  setViewModelVisible(visible: boolean): void {
    this.viewModelRoot.visible = visible;
  }

  get viewModelVisible(): boolean {
    return this.viewModelRoot.visible;
  }

  tryFire(): HitscanReport | null {
    const runtime = this.runtimes.get(this.current);
    if (!runtime) return null;
    const previousMagazine = runtime.roundsInMagazine;
    const result = runtime.tryFire();

    if (result === 'empty') {
      this.events.emit('weapon:empty', { weaponId: this.current });
      // Auto-reload on an empty trigger pull keeps the fight flowing.
      if (runtime.startReload(this.reloadMultiplier)) {
        this.events.emit('weapon:reload-started', {
          weaponId: this.current,
          seconds: runtime.currentReloadSeconds,
        });
      }
      return null;
    }
    if (result !== 'fired') return null;

    const config = this.activeWeapon;
    this.origin.copy(this.player.eyePosition);
    this.camera.updateMatrixWorld(true);
    this.camera.getWorldDirection(this.aimDirection);

    const report = this.damage.fire({
      origin: this.origin,
      direction: this.aimDirection,
      damage: config.damage * this.damageMultiplier,
      range: config.range,
      spread: config.spread + this.spreadCurrent,
      headshotMultiplier: config.headshotMultiplier,
      // One round of ammunition, several projectiles: a shotgun is the only weapon where
      // these differ.
      pellets: config.pellets,
    });

    this.player.addRecoil(config.recoil);
    this.spreadCurrent = Math.min(this.spreadCurrent + config.spread * 1.6, config.spread * 4);
    // The shot itself: a kick here that decays in the frame loop, and the muzzle flash
    // and tracer, which Game spawns off the weapon:fired event in world space.
    this.kick = 1;

    this.events.emit('weapon:fired', {
      weaponId: this.current,
      origin: [this.origin.x, this.origin.y, this.origin.z],
      direction: [this.aimDirection.x, this.aimDirection.y, this.aimDirection.z],
      ammo: previousMagazine - 1,
    });
    return report;
  }

  private applyViewModelTransform(): void {
    const model = this.viewModels.get(this.current);
    const config = this.activeWeapon;

    // Only re-parent when the weapon actually changed; re-adding every frame
    // would detach and reattach the same object 60 times a second.
    if (this.mountedViewModel !== model) {
      if (this.mountedViewModel) this.viewModelHolder.remove(this.mountedViewModel);
      if (model) this.viewModelHolder.add(model);
      this.mountedViewModel = model ?? null;

      // Hands come with the weapon, not with the frame: they are posed for one grip and
      // would otherwise stay behind holding a weapon that is no longer there.
      const kind = config.grip;
      const hands = this.hands.get(kind) ?? createFirstPersonHands(kind);
      this.hands.set(kind, hands);
      if (this.mountedHands && this.mountedHands !== hands) {
        this.viewModelHolder.remove(this.mountedHands);
      }
      // A nudge from the weapon model, which sits at the holder's origin: adding the
      // weapon's placement here as well would double it and throw the hands off screen.
      const placement = HANDS_PLACEMENT[kind];
      hands.position.set(placement.offset[0], placement.offset[1], placement.offset[2]);
      hands.rotation.set(placement.rotation[0], placement.rotation[1], placement.rotation[2]);
      this.viewModelHolder.add(hands);
      this.mountedHands = hands;
    }

    // Equip drop: full offset right after a switch, easing back to zero.
    const equip = this.equipTimer / WEAPON_EQUIP_SECONDS;
    // Kick: the weapon is pushed back, up and muzzle-up on a shot, then settles.
    const kick = this.kick;
    this.viewModelHolder.position.set(
      config.viewModel.position[0] + this.swayX,
      config.viewModel.position[1] + this.swayY - equip * WEAPON_LOWERED_DROP + kick * WEAPON_FEEL.kickUp,
      config.viewModel.position[2] + kick * WEAPON_FEEL.kickBack,
    );
    this.viewModelHolder.rotation.set(
      config.viewModel.rotation[0] + this.reloadBlend * WEAPON_RELOAD_TILT + equip * 0.5
        - kick * WEAPON_FEEL.kickPitch,
      config.viewModel.rotation[1],
      config.viewModel.rotation[2] + this.reloadBlend * 0.25 + kick * WEAPON_FEEL.kickRoll,
    );
    this.viewModelHolder.scale.setScalar(this.viewModelScale);
    // (the muzzle used to be drawn here as a small sphere; MuzzleFlash now draws it)

  }

  /**
   * Multiplier applied on top of the normalised weapon length.
   *
   * The model is normalised to VIEW_MODEL_LENGTH (0.42 m) by Game, so this is a
   * relative factor. It is deliberately small: a first-person weapon that is even
   * half a metre long at half a metre from the eye fills the screen.
   */
  private get viewModelScale(): number {
    return WEAPON_VIEW_MODEL_SCALE;
  }

  /**
   * What the mounted hands look like right now, for the diagnostics hook.
   *
   * Reports the mesh count and the group's local transform: a first-person weapon with
   * nothing holding it is either missing hands, hands behind the camera, or hands too
   * small to see, and this separates those three.
   */
  /**
   * Where each arm is, and whether anything is in front of it.
   *
   * "The arm is off screen" and "the arm is behind the weapon" look identical in a photo
   * and need opposite fixes — one moves the arm, the other turns it. So each arm is
   * projected to normalised device coordinates and then raycast from the camera: whatever
   * the ray hits first that is not the arm itself is what is hiding it.
   */
  get handsReport(): {
    parts: number; visible: boolean; position: [number, number, number] | null;
    screen: [number, number] | null; distance: number | null;
    arms: Array<{
      name: string; screen: [number, number]; box: [number, number, number, number];
      handScreen: [number, number]; handBox: [number, number, number, number];
      distance: number; occludedBy: string | null;
    }>;
  } {
    const hands = this.mountedHands;
    if (!hands) {
      return { parts: 0, visible: false, position: null, screen: null, distance: null, arms: [] };
    }
    let parts = 0;
    hands.traverse((child) => {
      if ((child as { isMesh?: boolean }).isMesh) parts += 1;
    });
    // Project the group into normalised device coordinates: (-1..1) is on screen, and a
    // value beyond that names exactly which edge the hands went off.
    hands.updateWorldMatrix(true, false);
    const world = hands.getWorldPosition(new Vector3());
    const ndc = world.clone().project(this.camera);
    return {
      parts,
      visible: hands.visible && this.viewModelRoot.visible,
      position: [hands.position.x, hands.position.y, hands.position.z],
      screen: [Number(ndc.x.toFixed(3)), Number(ndc.y.toFixed(3))],
      distance: Number(world.distanceTo(this.camera.getWorldPosition(new Vector3())).toFixed(3)),
      arms: this.armReports(hands),
    };
  }

  /**
   * Per-arm screen box and what, if anything, the weapon puts in front of it.
   *
   * The box rather than the group's origin: the origin sits behind the hand, well below the
   * frame, while the arm itself reaches into view — measuring the origin said every arm was
   * off screen, including the one clearly visible in a photograph. The box is the honest
   * question, and the occlusion raycast answers the other half: an arm inside the frame can
   * still be hidden behind the weapon.
   */
  private armReports(hands: Object3D): Array<{
    name: string; screen: [number, number]; box: [number, number, number, number];
    handScreen: [number, number]; handBox: [number, number, number, number];
    distance: number; occludedBy: string | null;
  }> {
    const cameraPosition = this.camera.getWorldPosition(new Vector3());
    const raycaster = new Raycaster();
    const reports: Array<{
      name: string; screen: [number, number]; box: [number, number, number, number];
      handScreen: [number, number]; handBox: [number, number, number, number];
      distance: number; occludedBy: string | null;
    }> = [];

    for (const arm of hands.children) {
      if (!arm.name.startsWith('Arm:')) continue;
      arm.updateWorldMatrix(true, false);
      const armPosition = arm.getWorldPosition(new Vector3());
      const ndc = armPosition.clone().project(this.camera);

      // Project every corner of the arm's world box: the extremes are what decide whether
      // any of it is on screen.
      const bounds = new Box3().setFromObject(arm);
      const corner = new Vector3();
      let minX = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (let corner_index = 0; corner_index < 8; corner_index += 1) {
        corner.set(
          corner_index & 1 ? bounds.max.x : bounds.min.x,
          corner_index & 2 ? bounds.max.y : bounds.min.y,
          corner_index & 4 ? bounds.max.z : bounds.min.z,
        ).project(this.camera);
        minX = Math.min(minX, corner.x);
        maxX = Math.max(maxX, corner.x);
        minY = Math.min(minY, corner.y);
        maxY = Math.max(maxY, corner.y);
      }

      // The hand, not the arm: the question is where the gloved hand is, and the arm group's
      // own box is mostly forearm, which is legitimately off the bottom of the frame.
      const hand = findByName(arm, 'GripHand') ?? arm;
      const handBox = new Box3().setFromObject(hand);
      const handCentre = handBox.getCenter(new Vector3());
      const handNdc = handCentre.clone().project(this.camera);
      const handCorner = new Vector3();
      let hMinX = Number.POSITIVE_INFINITY;
      let hMaxX = Number.NEGATIVE_INFINITY;
      let hMinY = Number.POSITIVE_INFINITY;
      let hMaxY = Number.NEGATIVE_INFINITY;
      for (let index = 0; index < 8; index += 1) {
        handCorner.set(
          index & 1 ? handBox.max.x : handBox.min.x,
          index & 2 ? handBox.max.y : handBox.min.y,
          index & 4 ? handBox.max.z : handBox.min.z,
        ).project(this.camera);
        hMinX = Math.min(hMinX, handCorner.x);
        hMaxX = Math.max(hMaxX, handCorner.x);
        hMinY = Math.min(hMinY, handCorner.y);
        hMaxY = Math.max(hMaxY, handCorner.y);
      }

      // Aim at the hand itself. A ray toward the group origin passes under the weapon and
      // reports clear while the hand sits behind the receiver.
      const direction = handCentre.clone().sub(cameraPosition).normalize();
      raycaster.set(cameraPosition, direction);
      raycaster.near = 0;
      raycaster.far = handCentre.distanceTo(cameraPosition) + 0.5;
      const hit = raycaster.intersectObject(this.viewModelRoot, true)[0] ?? null;
      const hitInsideArm = hit ? isDescendantOf(hit.object, arm) : false;

      reports.push({
        name: arm.name,
        screen: [Number(ndc.x.toFixed(3)), Number(ndc.y.toFixed(3))],
        box: [
          Number(minX.toFixed(3)), Number(minY.toFixed(3)),
          Number(maxX.toFixed(3)), Number(maxY.toFixed(3)),
        ],
        handScreen: [Number(handNdc.x.toFixed(3)), Number(handNdc.y.toFixed(3))],
        handBox: [
          Number(hMinX.toFixed(3)), Number(hMinY.toFixed(3)),
          Number(hMaxX.toFixed(3)), Number(hMaxY.toFixed(3)),
        ],
        distance: Number(armPosition.distanceTo(cameraPosition).toFixed(3)),
        occludedBy: hit && !hitInsideArm ? hit.object.name || hit.object.parent?.name || 'unnamed' : null,
      });
    }
    return reports;
  }

  /**
   * Muzzle position in world space: where the flash and the tracer start.
   *
   * The weapon is drawn with its origin at `viewModelHolder.position`, and the flash
   * used to be drawn 36 cm further along the barrel with a 3 cm rise. That offset *is*
   * the muzzle in view-model space, so the world muzzle is that point through the camera
   * rather than the camera position it used to report.
   */
  get muzzleWorldPosition(): Vector3 {
    return this.holdPosition
      .copy(this.viewModelHolder.position)
      .add(this.muzzleOffset)
      .applyMatrix4(this.camera.matrixWorld);
  }

  /**
   * Where brass leaves the weapon, in world space.
   *
   * Distinct from the muzzle on purpose: casings that fly out of the barrel read as
   * nonsense, so they come from around the receiver instead.
   */
  get ejectionPortWorldPosition(): Vector3 {
    return this.holdPosition
      .copy(this.viewModelHolder.position)
      .add(this.ejectionOffset)
      .applyMatrix4(this.camera.matrixWorld);
  }

  dispose(): void {
    this.viewModelRoot.clear();
    this.camera.remove(this.viewModelRoot);
    this.viewModelHolder.removeFromParent();
    this.runtimes.clear();
  }
}

/** Finds the named descendant of a node, for reporting a hand rather than the arm holding it. */
function findByName(root: Object3D, name: string): Object3D | null {
  if (root.name === name) return root;
  for (const child of root.children) {
    const found = findByName(child, name);
    if (found) return found;
  }
  return null;
}


function isDescendantOf(node: Object3D, root: Object3D): boolean {
  for (let current: Object3D | null = node; current; current = current.parent) {
    if (current === root) return true;
  }
  return false;
}
