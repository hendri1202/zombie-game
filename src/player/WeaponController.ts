import { Box3, Camera, Group, Object3D, PerspectiveCamera, PointLight, Raycaster, Vector3 } from 'three';
import {
  HANDS_PLACEMENT, alignSupportHand, createFirstPersonHands, resetSupportHand, type GripKind,
} from './proceduralArms';
import {
  ADS, DEFAULT_GRENADE, GRENADES, STARTING_LOADOUT, STARTING_WEAPON, WEAPON_FEEL, WEAPONS,
  type GrenadeConfig, type GrenadeId, type WeaponConfig, type WeaponId,
} from '../app/gameConfig';
import { RECOIL_PATTERN_LENGTH, recoilOffset } from './recoilPattern';
import { DEFAULT_MELEE, MELEE, type MeleeConfig, type MeleeId } from '../app/meleeConfig';
import type { EventBus } from '../core/EventBus';
import type { GameEvents } from '../app/GameEvents';
import type { DamageSystem, HitscanReport } from '../combat/DamageSystem';
import { meleeSwingCurve, type MeleeSystem } from '../combat/MeleeSystem';
import type { GrenadeSystem } from '../combat/GrenadeSystem';
import { WeaponRuntime } from '../combat/WeaponRuntime';
import type { InputSnapshot } from '../input/InputManager';
import { WeaponMechanism, WEAPON_MECHANISMS } from './weaponMechanism';
import {
  SUPPORT_GRIP_STATION, measureWeaponFit, muzzleOffsetInPlacement, supportGripInHands,
  type WeaponFit,
} from './weaponFit';
import { disposeOptic, mountOptic, opticParts, type MountedOptic } from './opticMeshes';
import { clamp, damp } from '../utils/math';
import type { PlayerController } from './PlayerController';

export interface WeaponControllerDeps {
  camera: Camera;
  events: EventBus<GameEvents>;
  damage: DamageSystem;
  player: PlayerController;
  /** Melee resolution: the swing cone, its damage and its wall check. */
  melee: MeleeSystem;
  /** Optional external view models, keyed by weapon id. */
  viewModels?: Map<WeaponId, Object3D>;
  /** Optional melee view models, keyed by melee id. */
  meleeViewModels?: Map<MeleeId, Object3D>;
  /**
   * The ordnance pool. When present, slot 4 selects the grenade and the trigger throws one.
   * Optional so the many controller harnesses in the test suite that only exercise firearms
   * and melee keep constructing without one.
   */
  grenades?: GrenadeSystem;
  /** The grenade's first-person mesh. Optional; without it slot 4 still works, invisibly. */
  grenadeViewModel?: Object3D | null;
  /**
   * Whether the weapons' moving parts (the pistol's slide, the rifle's bolt, the shotgun's
   * pump) are animated. Taken from the quality preset, which is where anything that costs a
   * draw call is switched off; default on, because the part is one mesh and one matrix write
   * a frame — less than the muzzle flash quads, which are never gated.
   */
  weaponMechanisms?: boolean;
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
export const WEAPON_VIEW_MODEL_SCALE = 0.62;
/** Extra pitch applied while reloading, radians. */
const WEAPON_RELOAD_TILT = -0.42;
/** How far the weapon drops while lowered, metres. */
const WEAPON_LOWERED_DROP = 0.26;
/**
 * Fraction of a swing, from its start, at which the blow lands.
 *
 * Not on the first frame: a hit that lands the instant the button goes down reads as
 * teleporting damage, and it is the moment the arm is still being raised.
 */
const MELEE_HIT_FRACTION = 0.35;
/**
 * First-person swing pose: how far the view model travels through the frame.
 *
 * The whole holder moves, so the hands go with the weapon — a swing where the weapon
 * leaves the hand is worse than no swing at all.
 */
const MELEE_SWING_YAW = 0.9;
const MELEE_SWING_PITCH = -0.5;
const MELEE_SWING_SWEEP = 0.2;
const MELEE_SWING_PUSH = 0.16;
/**
 * Seconds of not shooting after which the recoil pattern restarts.
 *
 * Long enough that an automatic weapon's own cadence always walks the pattern forward
 * (the rifle's interval is ~0.11 s, the pattern resets after 0.35), short enough that a
 * player who taps the trigger twice a second is at the start of the climb again rather
 * than half way up a pattern they never began.
 */
const RECOIL_RESET_SECONDS = 0.35;

export class WeaponController {
  private readonly runtimes = new Map<WeaponId, WeaponRuntime>();
  private readonly order: WeaponId[] = [...STARTING_LOADOUT];
  private current: WeaponId = STARTING_WEAPON;
  private readonly camera: Camera;
  private readonly events: EventBus<GameEvents>;
  private readonly damage: DamageSystem;
  private readonly player: PlayerController;
  private readonly melee: MeleeSystem;
  private readonly viewModelRoot = new Group();
  /**
   * Per-weapon wrapper. `applyViewModelTransform` positions and scales this
   * wrapper; the normalised model keeps its own scale inside it, so the config
   * value acts as a multiplier of the normalised size instead of replacing it.
   */
  private readonly viewModelHolder = new Group();
  /** The gun's own fill light; see `WEAPON_FEEL.viewModelLight` for why it exists. */
  private readonly fillLight: PointLight;
  private readonly viewModels = new Map<WeaponId, Object3D>();
  private readonly meleeViewModels = new Map<MeleeId, Object3D>();
  /**
   * Each firearm's moving part, built onto its own view model (F2).
   *
   * Keyed by weapon and created in the constructor, when the models arrive: the part is
   * parented to the mesh, so it has to exist before the mesh is first drawn. Melee weapons
   * and the grenade have no entry — `WEAPON_MECHANISMS` is keyed by `WeaponId`, and neither
   * is one, so a melee model is never given a part and nothing has to guard against it.
   */
  private readonly mechanisms = new Map<WeaponId, WeaponMechanism>();
  private readonly mechanismsEnabled: boolean;
  /**
   * The code-built optic body on each weapon that has one, keyed by weapon.
   *
   * Built *after* the mechanisms, and the order is load-bearing: a mechanism measures the
   * weapon's own geometry to place its moving part, so a sight mounted first would be measured
   * as part of the receiver and the bolt would be drawn on top of it. Mounted second, every
   * part is already at rest where the mechanism put it and this only adds a mesh beside them.
   *
   * Which weapons get one is the reticle table's decision (`opticsConfig.OPTICS[].housing`),
   * not this controller's: a weapon with no sight of its own and a dot or a cross to draw gets
   * a housing, a bead (an iron sight) and the pistol (no sight at all) get none, and so does a
   * weapon whose own mesh already ships a scope (the AUG) or an integrated optic (the P90).
   */
  private readonly optics = new Map<WeaponId, MountedOptic>();
  // --- melee state ---------------------------------------------------------
  /** Melee weapon that is drawn when the player reaches for it. */
  private meleeId: MeleeId = DEFAULT_MELEE;
  /**
   * Melee weapons the player owns, in acquisition order.
   *
   * The list slot 3 rotates through. Kept beside the firearms' `order` rather than merged into
   * it because the two hold different id types, and the rotation rule is the same for both:
   * the key walks the owned weapons of its category and wraps, so an unowned one can never be
   * selected and owning nothing in the category makes the key do nothing.
   */
  private readonly meleeOrder: MeleeId[] = [DEFAULT_MELEE];
  /**
   * True while the melee weapon is in hand instead of a firearm.
   *
   * A separate flag rather than a third slot: the firearm keeps its magazine, its reserve
   * and its position in `order`, so drawing a bat and putting it away costs nothing and
   * cannot corrupt the loadout.
   */
  private meleeDrawn = false;
  private meleeCooldown = 0;
  /** Length of the swing in flight, seconds; 0 when idle. */
  private meleeSwingSeconds = 0;
  private meleeSwingTimer = 0;
  private meleeHitLanded = true;
  private lastMeleeTargetId: number | null = null;
  private lastMeleeDamage = 0;
  // --- ordnance state (slot 4) ---------------------------------------------
  /** Ordnance item slot 4 selects. One today; the field exists so a second is a table change. */
  private grenadeId: GrenadeId = DEFAULT_GRENADE;
  /**
   * True while the grenade is in hand instead of a firearm or melee weapon.
   *
   * The same shape as `meleeDrawn` and for the same reason: selecting the grenade must not
   * touch the firearm's magazine or its place in `order`, so putting the grenade away is free
   * and cannot corrupt the loadout.
   */
  private ordnanceSelected = false;
  /** The grenade pool, when the game supplied one. Without it slot 4 has nothing to select. */
  private readonly grenades: GrenadeSystem | null;
  /** The grenade's first-person mesh, mounted while the grenade is in hand. */
  private readonly grenadeViewModel: Object3D | null;
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
  /** Scratch for the measured support-hand target; written once per mount. */
  private readonly supportTarget = new Vector3();
  /**
   * Muzzle and ejection port in view-model space, from WEAPON_FEEL's offsets.
   *
   * The muzzle offset is written per mount: `WEAPON_FEEL.muzzleOffset` is the value the
   * original roster's frames were signed off against, and a weapon with `muzzleFromMesh`
   * replaces it with the offset measured from its own barrel tip (see `weaponFit.ts`).
   */
  private readonly muzzleOffset = new Vector3(
    WEAPON_FEEL.muzzleOffset[0], WEAPON_FEEL.muzzleOffset[1], WEAPON_FEEL.muzzleOffset[2],
  );
  private readonly ejectionOffset = new Vector3(
    WEAPON_FEEL.ejectionPortOffset[0], WEAPON_FEEL.ejectionPortOffset[1],
    WEAPON_FEEL.ejectionPortOffset[2],
  );
  private mountedViewModel: Object3D | null = null;
  /**
   * Measured extent of each weapon's mesh, kept per id.
   *
   * A fit scans every vertex of the model, and a player swaps weapons far more often than a
   * mesh changes, so it is measured once per weapon rather than once per mount.
   */
  private readonly fits = new Map<WeaponId, WeaponFit>();
  /** Set when the weapon in hand changes; the fit is taken once the holder's pose is written. */
  private fitPending = false;
  /** Counts down after a weapon switch; drives the lower/raise offset. */
  private equipTimer = 0;
  /** Smoothed 0..1 blend for the reload tilt. */
  private reloadBlend = 0;
  /** Survivor modifiers: below 1 reloads faster, above 1 hits harder. */
  private reloadMultiplier = 1;
  private damageMultiplier = 1;
  /** 1 right after a shot, decaying to 0; drives the weapon kick. */
  private kick = 0;
  /**
   * 0 at the hip, 1 with the sights up; ramped over ADS.seconds so the move reads as
   * bringing a weapon up rather than as a cut between two cameras.
   */
  private adsBlend = 0;
  /**
   * The FOV the camera rests at, read once from the camera the game built.
   *
   * Read rather than hard-coded so the two can never disagree: ADS only ever writes
   * `hipFov + (ADS.fovDegrees - hipFov) * blend`, which returns to exactly the value the
   * game set when the blend reaches 0. A release therefore cannot leave the view zoomed.
   */
  private readonly hipFov: number;
  /**
   * The camera as a perspective camera, or null when it is not one.
   *
   * The controller is handed a bare `Camera`; only a perspective one has a field of view
   * to zoom. Aiming still tightens the cone and centres the weapon without it — only the
   * zoom is skipped — so a harness with a camera of another kind stays usable.
   */
  private readonly fovCamera: PerspectiveCamera | null;
  /** Rounds fired since the burst began: which step of the recoil pattern the next shot uses. */
  private recoilStep = 0;
  /** Seconds since the last shot; the pattern restarts once this passes RECOIL_RESET_SECONDS. */
  private sinceShot = 0;

  constructor(deps: WeaponControllerDeps) {
    this.camera = deps.camera;
    this.events = deps.events;
    this.damage = deps.damage;
    this.player = deps.player;
    this.melee = deps.melee;
    this.grenades = deps.grenades ?? null;
    this.grenadeViewModel = deps.grenadeViewModel ?? null;
    this.mechanismsEnabled = deps.weaponMechanisms ?? true;
    this.fovCamera = (deps.camera as PerspectiveCamera).isPerspectiveCamera === true
      ? deps.camera as PerspectiveCamera
      : null;
    this.hipFov = this.fovCamera?.fov ?? 0;

    for (const id of Object.keys(WEAPONS) as WeaponId[]) {
      this.runtimes.set(id, new WeaponRuntime(WEAPONS[id]));
    }
    for (const id of this.order) this.runtimes.get(id)?.setOwned(true);

    this.viewModelRoot.name = 'weapon-view-model';
    this.viewModelRoot.renderOrder = 10;
    this.viewModelRoot.add(this.viewModelHolder);
    this.camera.add(this.viewModelRoot);

    // The gun's own fill light, inside the holder so it swings with the weapon. It is a child
    // of the view-model root, so third person (which hides that root) takes it out of the
    // scene with the weapon it was lighting.
    const fill = WEAPON_FEEL.viewModelLight;
    this.fillLight = new PointLight(fill.colour, fill.intensity, fill.distance, 2);
    this.fillLight.name = 'view-model-fill';
    this.fillLight.position.set(fill.position[0], fill.position[1], fill.position[2]);
    this.fillLight.castShadow = false;
    this.viewModelHolder.add(this.fillLight);

    if (deps.viewModels) {
      for (const [id, model] of deps.viewModels) {
        this.viewModels.set(id, model);
        // The mechanism part is built here, once per mesh, in the weapon's own units: the
        // controller is the only thing that mounts and fires the view model, so it is also
        // the only place that can be sure the part is built against the mesh that is drawn.
        this.mechanisms.set(id, new WeaponMechanism(model, WEAPON_MECHANISMS[id], this.mechanismsEnabled));
      }
    }
    if (deps.meleeViewModels) {
      for (const [id, model] of deps.meleeViewModels) this.meleeViewModels.set(id, model);
    }

    // The sights, mounted on the loaded meshes and after the moving parts (see `optics`).
    for (const [id, model] of this.viewModels) {
      const optic = mountOptic(model, id);
      if (optic) this.optics.set(id, optic);
    }

    this.applyViewModelTransform();
  }

  get activeWeapon(): WeaponConfig {
    return WEAPONS[this.current];
  }

  /** Melee weapon currently carried, drawn or not. */
  get activeMelee(): MeleeConfig {
    return MELEE[this.meleeId];
  }

  /** True while the melee weapon, not a firearm, is in the player's hands. */
  get isMeleeDrawn(): boolean {
    return this.meleeDrawn;
  }

  /** Ordnance item slot 4 selects. */
  get activeGrenade(): GrenadeConfig {
    return GRENADES[this.grenadeId];
  }

  /** True while the grenade, not a firearm or melee weapon, is in the player's hands. */
  get isOrdnanceSelected(): boolean {
    return this.ordnanceSelected;
  }

  /** Melee weapons owned, in acquisition order: what slot 3 rotates through. */
  get ownedMelee(): MeleeId[] {
    return [...this.meleeOrder];
  }

  /**
   * What the melee weapon is doing right now, for the diagnostics hook.
   *
   * `equipped` is null while a firearm is in hand on purpose: "which melee is carried" and
   * "is a melee actually out" are different questions, and a report that answered both
   * with one string would let a swing that can never fire look like one that did.
   */
  get meleeReport(): {
    equipped: MeleeId | null;
    swinging: boolean;
    cooldown: number;
    lastTarget: number | null;
    damage: number;
  } {
    return {
      equipped: this.meleeDrawn ? this.meleeId : null,
      swinging: this.meleeSwingSeconds > 0,
      cooldown: Number(this.meleeCooldown.toFixed(3)),
      lastTarget: this.lastMeleeTargetId,
      damage: Number(this.lastMeleeDamage.toFixed(1)),
    };
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

  /** 0 at the hip, 1 with the sights fully up. */
  get aimBlend(): number {
    return this.adsBlend;
  }

  /** True once the sights have finished coming up. */
  get aiming(): boolean {
    return this.adsBlend >= 1;
  }

  /**
   * The cone the next shot would fire with, ADS tightening included.
   *
   * This is the number `tryFire` hands to the damage system, and it is a getter rather
   * than a bare field so a test can read the value the shot *would* use without having to
   * fire one: a cone that never reaches the ballistics is a feature that only looks
   * implemented.
   */
  get aimCone(): number {
    return this.activeWeapon.spread * this.spreadScale + this.spreadCurrent;
  }

  /** Where the view model holder is held right now, in camera space. */
  get viewModelHold(): Vector3 {
    return this.viewModelHolder.position.clone();
  }

  /** 1 at the hip scaling the weapon's own cone, ADS.spreadMultiplier with the sights up. */
  private get spreadScale(): number {
    return 1 + (ADS.spreadMultiplier - 1) * this.adsBlend;
  }

  reset(): void {
    this.order.length = 0;
    for (const id of STARTING_LOADOUT) this.order.push(id);
    // The melee rotation starts at the default weapon again, for the same reason the firearms
    // do: `Game.applyProfileLoadout` re-grants what the profile owns right after this, so a
    // run never begins with a melee weapon the player does not have.
    this.meleeOrder.length = 0;
    this.meleeOrder.push(DEFAULT_MELEE);
    this.meleeId = DEFAULT_MELEE;
    for (const runtime of this.runtimes.values()) {
      runtime.reset();
      runtime.setOwned(false);
    }
    for (const id of this.order) this.runtimes.get(id)?.setOwned(true);
    this.current = STARTING_WEAPON;
    this.spreadCurrent = 0;
    this.equipTimer = 0;
    this.reloadBlend = 0;
    // A run restart puts the sights down and the pattern back to its first round, so a
    // fresh run does not start zoomed or half way up a burst from the last one.
    this.adsBlend = 0;
    this.recoilStep = 0;
    this.sinceShot = 0;
    this.applyZoom();
    this.resetMelee();
    this.parkMechanisms();
    this.applyViewModelTransform();
  }

  /** Back to a firearm in hand with no swing in flight, used by every run restart. */
  private resetMelee(): void {
    this.meleeDrawn = false;
    this.ordnanceSelected = false;
    this.meleeCooldown = 0;
    this.meleeSwingSeconds = 0;
    this.meleeSwingTimer = 0;
    this.meleeHitLanded = true;
    this.lastMeleeTargetId = null;
    this.lastMeleeDamage = 0;
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

  /**
   * Puts a weapon in the loadout without switching to it or announcing it.
   *
   * Used when re-applying a saved loadout at the start of a run. `unlock` cannot serve: it
   * also draws the weapon and emits `weapon:unlocked`, which the HUD shows as "New weapon" —
   * wrong for something bought several runs ago, and it would leave whichever weapon was
   * granted last in the player's hands instead of the sidearm.
   */
  grantWeapon(id: WeaponId): boolean {
    if (this.order.includes(id)) return false;
    this.order.push(id);
    this.runtimes.get(id)?.setOwned(true);
    return true;
  }

  addMagazine(id: WeaponId, amount: number): number {
    return this.runtimes.get(id)?.addMagazine(amount) ?? 0;
  }

  switchTo(id: WeaponId): boolean {
    if (!this.order.includes(id)) return false;
    if (id === this.current) {
      // The slot already holds this weapon: a slot key pressed while the melee weapon or a
      // grenade is out is the way back to the gun, so the draw state is what changes.
      if (this.meleeDrawn || this.ordnanceSelected) {
        this.holsterHeld();
        return true;
      }
      return false;
    }
    this.runtimes.get(this.current)?.cancelReload();
    this.current = id;
    // A firearm in hand means the melee weapon and the grenade are away, wherever they were drawn from.
    this.meleeDrawn = false;
    this.ordnanceSelected = false;
    this.stopMeleeSwing();
    this.parkMechanisms();
    this.restartRecoilPattern();
    // Lower the new weapon and let update() raise it again.
    this.equipTimer = WEAPON_EQUIP_SECONDS;
    this.applyViewModelTransform();
    this.events.emit('weapon:switched', { weaponId: id });
    return true;
  }

  /**
   * Draws a melee weapon, holstering whatever firearm was in hand.
   *
   * Not a weapon slot: the firearm keeps its magazine, its reserve and its place in the
   * loadout, so 1/2 brings it straight back (see switchTo) and nothing about the firearm
   * path has to know melee exists.
   */
  equipMelee(id: MeleeId = this.meleeId): boolean {
    if (this.meleeDrawn && id === this.meleeId) return false;
    this.runtimes.get(this.current)?.cancelReload();
    this.meleeId = id;
    this.meleeDrawn = true;
    this.ordnanceSelected = false;
    this.meleeCooldown = 0;
    this.stopMeleeSwing();
    this.parkMechanisms();
    this.restartRecoilPattern();
    this.equipTimer = WEAPON_EQUIP_SECONDS;
    this.applyViewModelTransform();
    this.events.emit('melee:equipped', { meleeId: id });
    return true;
  }

  /** Puts the firearm back in hand. Returns false when it was already there. */
  holsterMelee(): boolean {
    if (!this.meleeDrawn) return false;
    this.meleeDrawn = false;
    this.stopMeleeSwing();
    this.restartRecoilPattern();
    this.equipTimer = WEAPON_EQUIP_SECONDS;
    this.applyViewModelTransform();
    return true;
  }

  /**
   * Selects the grenade (slot 4), holstering whatever was in hand.
   *
   * The grenade is then the thing the trigger acts on: left click throws one. Returns false
   * when the grenade is already in hand, so a slot key that has nothing new to draw reads the
   * same way as a single-weapon firearm slot.
   */
  equipOrdnance(): boolean {
    if (this.ordnanceSelected) return false;
    this.runtimes.get(this.current)?.cancelReload();
    this.meleeDrawn = false;
    this.stopMeleeSwing();
    this.parkMechanisms();
    this.ordnanceSelected = true;
    this.restartRecoilPattern();
    this.equipTimer = WEAPON_EQUIP_SECONDS;
    this.applyViewModelTransform();
    return true;
  }

  /** Puts the grenade away and returns the firearm to the hand. False when it was already away. */
  holsterOrdnance(): boolean {
    if (!this.ordnanceSelected) return false;
    this.ordnanceSelected = false;
    this.restartRecoilPattern();
    this.equipTimer = WEAPON_EQUIP_SECONDS;
    this.applyViewModelTransform();
    return true;
  }

  /**
   * Throws one grenade along the player's aim.
   *
   * The origin is the eye and the direction the camera forward: what the crosshair is on is
   * where the grenade is sent, and the system's lift turns that into an arc. Refused (and the
   * count untouched) when the pouch is empty or the grenade is not the item in hand.
   */
  tryThrowGrenade(): boolean {
    if (!this.grenades || !this.ordnanceSelected) return false;
    this.camera.updateMatrixWorld(true);
    this.camera.getWorldDirection(this.aimDirection);
    if (!this.grenades.throw(this.player.eyePosition, this.aimDirection)) return false;
    // A throw shoves the hand the way a shot shoves the weapon, so it reads as an action.
    this.kick = 1;
    return true;
  }

  /** Melee weapons the player owns: what slot 3 can rotate to. Idempotent. */
  grantMelee(id: MeleeId): boolean {
    if (this.meleeOrder.includes(id)) return false;
    this.meleeOrder.push(id);
    return true;
  }

  /**
   * Sets which melee weapon F and slot 3 draw, without drawing it, and records it as owned.
   *
   * The store needs this: a melee weapon bought mid-run should be the one F reaches for from
   * then on, and re-applying a saved loadout at the start of a run should not pop a "drawn"
   * toast before the first wave. `equipMelee` cannot be used for it because it also draws.
   * It also grants, because selecting a melee weapon the rotation does not own would leave it
   * unreachable the moment the player pressed 3.
   */
  setCarriedMelee(id: MeleeId): void {
    this.meleeId = id;
    if (!this.meleeOrder.includes(id)) this.meleeOrder.push(id);
  }

  /**
   * Starts one swing, if the melee weapon is drawn and ready.
   *
   * Damage is deliberately not applied here. The swing lasts `swingSeconds` and the blow
   * lands partway through it (see update), so a bat does not connect while it is still
   * being raised. Returns whether a swing actually started; the hit, when it comes, is
   * reported through `meleeReport` and the 'combat:hit' event.
   */
  tryMelee(): boolean {
    if (!this.meleeDrawn) return false;
    if (this.meleeCooldown > 0 || this.meleeSwingSeconds > 0) return false;
    const config = this.activeMelee;
    this.meleeSwingSeconds = config.swingSeconds;
    this.meleeSwingTimer = config.swingSeconds;
    this.meleeHitLanded = false;
    // The cooldown is spent on the swing, not on the hit: a held trigger cannot turn melee
    // into a damage-per-frame tap while the first swing is still in the air.
    this.meleeCooldown = config.cooldownSeconds;
    this.events.emit('melee:swung', {
      meleeId: config.id,
      clip: config.clip,
      swingSeconds: config.swingSeconds,
    });
    return true;
  }

  /** Clears the swing in flight without touching the cooldown. */
  private stopMeleeSwing(): void {
    this.meleeSwingSeconds = 0;
    this.meleeSwingTimer = 0;
    this.meleeHitLanded = true;
  }

  /**
   * Resolves the blow of the swing that is in the air.
   *
   * Runs once per swing, at `MELEE_HIT_FRACTION` of its length, which is what keeps a
   * single swing to a single damage application however many frames it spans.
   */
  private resolveMeleeHit(): void {
    this.meleeHitLanded = true;
    const config = this.activeMelee;
    const report = this.melee.swing({
      origin: this.player.eyePosition,
      // The facing angle, not the camera yaw: `facingAngle` is the same convention the
      // swing cone is built on, and the camera looks down -Z while the model faces +Z.
      forwardYaw: this.player.facingAngle,
      damage: config.damage,
      arc: config.arc,
      reach: config.reach,
    });
    this.lastMeleeTargetId = report.targetId;
    this.lastMeleeDamage = report.damage;
    // A blow that lands shoves the weapon, exactly as a shot does: without it a bat
    // connecting and a bat swinging through air look identical from behind the camera.
    if (report.target === 'zombie') this.kick = 1;
    else this.events.emit('melee:missed', { meleeId: config.id });
  }

  /**
   * Slot key request from the keyboard: 1 primary, 2 sidearm, 3 melee, 4 ordnance.
   *
   * One number key is one *category* (§14.1), and pressing the same key again rotates through
   * the owned weapons of that category rather than always picking the first one. With one
   * weapon in a category the two are identical; with six primaries they are not. A first-match
   * rule made every primary past the first unreachable from the keyboard — buy a gun, switch
   * away, come back, and the old one was in hand, which reads as the purchase not having
   * worked. Rotating past the weapon in hand is what lets one key reach all of them.
   *
   * Each category rotates its own owned list — `order` for the firearms, `meleeOrder` for the
   * melee weapons, the single ordnance item for slot 4 — so an unowned weapon can never be
   * selected and a category the player owns nothing in does nothing.
   *
   * While the melee weapon or a grenade is out, the firearm underneath is still its slot's
   * pick, so the matching number key holsters rather than advancing: the same key must not both
   * put the gun away and silently skip past it to another one.
   */
  switchSlot(slot: number): boolean {
    if (slot === 1 || slot === 2) return this.switchFirearmSlot(slot);
    if (slot === 3) return this.switchMeleeSlot();
    if (slot === 4) return this.switchOrdnanceSlot();
    // A number the game has no category for is refused rather than guessed at.
    return false;
  }

  /** Slot 1/2: rotate the owned firearms of that category, holstering a drawn melee/grenade. */
  private switchFirearmSlot(slot: 1 | 2): boolean {
    const candidates = this.order.filter((id) => WEAPONS[id].slot === slot);
    if (candidates.length === 0) return false;
    if ((this.meleeDrawn || this.ordnanceSelected) && this.activeWeapon.slot === slot) {
      return this.switchTo(this.current);
    }
    const index = candidates.indexOf(this.current);
    const next = index === -1 ? candidates[0] : candidates[(index + 1) % candidates.length];
    return this.switchTo(next);
  }

  /**
   * Slot 3: draw or rotate the owned melee weapons.
   *
   * Nothing of the category in hand draws the carried melee weapon (or the first owned one,
   * when the carried weapon is not in the rotation); a drawn melee weapon rotates to the next
   * owned one. A category with a single weapon returns false on the second press, exactly as a
   * single-weapon firearm slot does.
   */
  private switchMeleeSlot(): boolean {
    if (this.meleeOrder.length === 0) return false;
    const index = this.meleeOrder.indexOf(this.meleeId);
    if (!this.meleeDrawn) return this.equipMelee(index === -1 ? this.meleeOrder[0] : this.meleeId);
    const next = this.meleeOrder[(index + 1) % this.meleeOrder.length];
    if (next === this.meleeId) return false;
    return this.equipMelee(next);
  }

  /**
   * Slot 4: select the ordnance.
   *
   * One grenade today, so the second press is a no-op the way a single-weapon slot is; a second
   * ordnance item would rotate here exactly as the melee list does.
   */
  private switchOrdnanceSlot(): boolean {
    if (!this.grenades) return false;
    return this.equipOrdnance();
  }

  /** Puts whichever of melee/grenade is in hand away and hands the firearm back. */
  private holsterHeld(): void {
    this.meleeDrawn = false;
    this.ordnanceSelected = false;
    this.stopMeleeSwing();
    this.restartRecoilPattern();
    this.equipTimer = WEAPON_EQUIP_SECONDS;
    this.applyViewModelTransform();
  }

  /**
   * Parks every weapon's moving part at rest.
   *
   * Only the weapon in hand advances its mechanism, so one put away mid-cycle would freeze
   * part way back and finish the movement the moment it was drawn again: a slide that opens
   * itself when the player switches to a pistol reads as a bug, not as a mechanism. Called
   * from every path that changes what is in hand, and from a run restart.
   */
  private parkMechanisms(): void {
    for (const mechanism of this.mechanisms.values()) mechanism.reset();
  }

  /**
   * Restarts the recoil pattern at its first round.
   *
   * Called from every path that changes what is in hand: a burst fired through one weapon
   * and then the next has to begin at the start of the pattern, not carry the previous
   * weapon's climb into the new one.
   */
  private restartRecoilPattern(): void {
    this.recoilStep = 0;
    this.sinceShot = 0;
  }

  /**
   * Puts the camera's field of view where the aim blend says it should be.
   *
   * Absolute, from the hip FOV, on every call: never `fov -= something`. A relative write
   * would accumulate and the view would creep tighter every frame; an absolute one cannot
   * be left anywhere other than the hip value once the blend is back at 0.
   */
  private applyZoom(): void {
    if (!this.fovCamera) return;
    this.fovCamera.fov = this.hipFov + (ADS.fovDegrees - this.hipFov) * this.adsBlend;
  }

  /**
   * What each firearm's mechanism is doing, for the diagnostics hook.
   *
   * Per weapon and not only for the one in hand, and as numbers rather than a boolean:
   * "the part did not move" and "there is no part" are different answers, and only a report
   * that carries the part count, the travel and the travel distance side by side can tell
   * them apart. `distance` is in the model's own local units, which is why it is reported
   * with the mesh it was measured from rather than converted to metres.
   */
  get mechanismReport(): {
    enabled: boolean;
    running: WeaponId | null;
    weapons: Array<{
      weaponId: WeaponId; kind: string; parts: number;
      travel: number; offset: number; distance: number;
      /** Degrees: the weapon body's own axis, measured from its geometry. */
      yawDeg: number; bodyLength: number;
    }>;
  } {
    const weapons = [...this.mechanisms.entries()].map(([weaponId, mechanism]) => ({
      weaponId,
      kind: mechanism.kind,
      parts: mechanism.parts.length,
      travel: Number(mechanism.travel.toFixed(4)),
      offset: Number(mechanism.offset.toFixed(4)),
      distance: Number(mechanism.travelDistance.toFixed(4)),
      // What the part was placed against. A harness can check this without a second
      // implementation of the measurement, and near-zero means the weapon obeyed the
      // project's +Z convention while anything else is a mesh that did not.
      yawDeg: mechanism.measuredYawDegrees,
      bodyLength: mechanism.bodyLength,
    }));
    const running = [...this.mechanisms.entries()].find(([, mechanism]) => mechanism.active);
    return {
      enabled: this.mechanismsEnabled,
      running: running ? running[0] : null,
      weapons,
    };
  }

  /**
   * What optic each weapon is drawn with, for the diagnostics hook.
   *
   * Per weapon and in numbers, the same shape as `mechanismReport` and for the same reason:
   * "the sight is missing", "the sight is behind the barrel" and "the sight is on the gun" are
   * three different answers, and only a report that carries the part count, the station and
   * the distance to the muzzle side by side can tell them apart without a browser. Distances
   * are in the mesh's own local units, which is why `bodyLength` is reported beside them.
   */
  get opticReport(): {
    weapons: Array<{
      weaponId: WeaponId; kind: string; meshName: string; parts: number;
      station: number; forwardReach: number; bodyLength: number; muzzleClearance: number;
    }>;
  } {
    const weapons = [...this.optics.entries()].map(([weaponId, optic]) => ({
      weaponId,
      kind: optic.kind,
      meshName: optic.group.name,
      parts: opticParts(optic.group).length,
      station: Number(optic.station.toFixed(4)),
      forwardReach: Number(optic.forwardReach.toFixed(4)),
      bodyLength: Number(optic.bodyLength.toFixed(4)),
      muzzleClearance: Number(optic.muzzleClearance.toFixed(4)),
    }));
    return { weapons };
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

    // --- ADS (F3) -----------------------------------------------------------
    // The sights ride on the aim button and are suppressed whenever a melee weapon or the
    // grenade is in hand: there is no sight on a bat, and a camera zoom the player cannot
    // see a weapon through is just a zoom. Ramped rather than snapped, so bringing the
    // weapon up reads as a movement.
    if (!input) {
      // No gameplay input at all (title screen, pause menu) means no aim. Dropping the
      // blend outright is what keeps a game paused mid-aim from being left zoomed in
      // behind the menu; the next live frame ramps it back up if the button is still down.
      this.adsBlend = 0;
    } else {
      const wantsAim = !this.meleeDrawn && !this.ordnanceSelected && input.adsHeld === true;
      const ramp = delta / ADS.seconds;
      this.adsBlend = clamp(this.adsBlend + (wantsAim ? ramp : -ramp), 0, 1);
    }
    // Written out from the hip FOV every frame, so releasing the button always lands on
    // exactly the value the game set, however the blend was interrupted.
    this.applyZoom();

    // The pattern restarts after a pause between shots: a burst that has stopped for
    // RECOIL_RESET_SECONDS begins its climb again rather than resuming the last one.
    this.sinceShot += delta;
    if (this.sinceShot > RECOIL_RESET_SECONDS) this.recoilStep = 0;

    // Melee timers. They advance on the same run clock as the firearm ones, so a paused
    // game (Game passes delta 0) freezes a swing and its cooldown instead of letting the
    // damage land behind the menu.
    if (this.meleeCooldown > 0) this.meleeCooldown = Math.max(0, this.meleeCooldown - delta);
    if (this.meleeSwingSeconds > 0) {
      this.meleeSwingTimer = Math.max(0, this.meleeSwingTimer - delta);
      const elapsed = this.meleeSwingSeconds - this.meleeSwingTimer;
      if (!this.meleeHitLanded && elapsed >= this.meleeSwingSeconds * MELEE_HIT_FRACTION) {
        this.resolveMeleeHit();
      }
      if (this.meleeSwingTimer <= 0) this.stopMeleeSwing();
    }

    // Idle sway follows the look delta for a bit of weapon weight.
    if (input) {
      this.swayX = damp(this.swayX, clamp(-input.lookX * 0.0006, -0.02, 0.02), 9, delta);
      this.swayY = damp(this.swayY, clamp(-input.lookY * 0.0006, -0.02, 0.02), 9, delta);
    } else {
      this.swayX = damp(this.swayX, 0, 9, delta);
      this.swayY = damp(this.swayY, 0, 9, delta);
    }
    // F2: the shot's mechanism runs on the same run clock as everything else, and only for
    // the weapon in hand — the parts on every other weapon are parked at rest, so a weapon
    // drawn mid-cycle can never be drawn half open.
    if (!this.meleeDrawn && !this.ordnanceSelected) this.mechanisms.get(this.current)?.update(delta);
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
    if (this.ordnanceSelected) {
      // A selected grenade owns the trigger: left click throws one, and the fuse does the
      // rest. The firearm underneath is not fired as well — the player cannot aim a gun they
      // are not holding, and a free shot with every throw would make the grenade a bonus.
      if (input.firePressed) this.tryThrowGrenade();
    } else if (this.meleeDrawn) {
      // A drawn melee weapon owns the trigger. Firing the pistol underneath it as well
      // would make the swing a free extra hit, and the player has no way to aim a
      // firearm they cannot see.
      if (input.firePressed) this.tryMelee();
    } else {
      // Automatic weapons fire while held; semi-automatic ones need a new press.
      const wantsFire = config.automatic ? input.firing : input.firePressed;
      if (wantsFire) this.tryFire();
    }

    // F draws the melee weapon, and swings it once it is out: one key for a fallback
    // weapon that has no slot number of its own.
    if (input.meleePressed) {
      if (this.meleeDrawn) this.tryMelee();
      else this.equipMelee();
    }
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

    // This round's place in the burst: up on every shot, and sideways from the second one
    // on (see recoilPattern for why the pattern is a table and not a random walk). The
    // step advances here, after it has been read, so the *next* shot is the next round of
    // the pattern — and it is reset by anything that changes what is in hand.
    const offset = recoilOffset(this.recoilStep);
    this.recoilStep = Math.min(this.recoilStep + 1, RECOIL_PATTERN_LENGTH - 1);
    this.sinceShot = 0;

    const report = this.damage.fire({
      origin: this.origin,
      direction: this.aimDirection,
      damage: config.damage * this.damageMultiplier,
      range: config.range,
      // The weapon's own cone plus the bloom this burst has built up, tightened while the
      // sights are up. The ADS factor scales the *whole* cone — a weapon being aimed
      // tighter is the point — and it is the same number `aimCone` reports.
      spread: config.spread * this.spreadScale + this.spreadCurrent,
      headshotMultiplier: config.headshotMultiplier,
      // One round of ammunition, several projectiles: a shotgun is the only weapon where
      // these differ.
      pellets: config.pellets,
    });

    this.player.addRecoil(config.recoil * offset.pitch, config.recoil * offset.yaw);
    this.spreadCurrent = Math.min(this.spreadCurrent + config.spread * 1.6, config.spread * 4);
    // The shot itself: a kick here that decays in the frame loop, the muzzle flash
    // and tracer, which Game spawns off the weapon:fired event in world space, and the
    // mechanism — the same instant of the same shot, on the weapon's own cadence rather
    // than on a timer of its own. Nothing here changes what the round did: the part moves,
    // the ballistics above it did not.
    this.kick = 1;
    this.mechanisms.get(this.current)?.trigger(config);

    this.events.emit('weapon:fired', {
      weaponId: this.current,
      origin: [this.origin.x, this.origin.y, this.origin.z],
      direction: [this.aimDirection.x, this.aimDirection.y, this.aimDirection.z],
      ammo: previousMagazine - 1,
    });
    return report;
  }

  private applyViewModelTransform(): void {
    const melee = this.meleeDrawn ? this.activeMelee : null;
    const ordnance = !melee && this.ordnanceSelected ? this.activeGrenade : null;
    const model = melee
      ? this.meleeViewModels.get(melee.id) ?? null
      : ordnance
        ? this.grenadeViewModel
        : this.viewModels.get(this.current) ?? null;
    const placement = melee ? melee.viewModel : ordnance ? ordnance.viewModel : this.activeWeapon.viewModel;
    const grip = melee ? melee.grip : ordnance ? ordnance.grip : this.activeWeapon.grip;

    // Only re-parent when what is in hand actually changed; re-adding every frame
    // would detach and reattach the same object 60 times a second.
    if (this.mountedViewModel !== model) {
      if (this.mountedViewModel) this.viewModelHolder.remove(this.mountedViewModel);
      if (model) this.viewModelHolder.add(model);
      this.mountedViewModel = model ?? null;

      // Hands come with the weapon, not with the frame: they are posed for one grip and
      // would otherwise stay behind holding a weapon that is no longer there.
      const hands = this.hands.get(grip) ?? createFirstPersonHands(grip);
      this.hands.set(grip, hands);
      if (this.mountedHands && this.mountedHands !== hands) {
        this.viewModelHolder.remove(this.mountedHands);
      }
      // A nudge from the weapon model, which sits at the holder's origin: adding the
      // weapon's placement here as well would double it and throw the hands off screen.
      const handPlacement = HANDS_PLACEMENT[grip];
      hands.position.set(handPlacement.offset[0], handPlacement.offset[1], handPlacement.offset[2]);
      hands.rotation.set(handPlacement.rotation[0], handPlacement.rotation[1], handPlacement.rotation[2]);
      // Back to the pose this grip kind was tuned to before the new weapon's fit overwrites
      // it: the hands group is shared by every weapon of a grip kind, so the support arm
      // would otherwise stay on the fore-end of the weapon the player just put away.
      resetSupportHand(hands, grip);
      this.viewModelHolder.add(hands);
      this.mountedHands = hands;

      // The muzzle default is the value the original roster's frames were signed off with;
      // a weapon that measures its own barrel replaces it below, once the holder's pose for
      // this frame has been written.
      this.muzzleOffset.set(WEAPON_FEEL.muzzleOffset[0], WEAPON_FEEL.muzzleOffset[1], WEAPON_FEEL.muzzleOffset[2]);
      this.fitPending = true;
    }

    // Equip drop: full offset right after a switch, easing back to zero.
    const equip = this.equipTimer / WEAPON_EQUIP_SECONDS;
    // Kick: the weapon is pushed back, up and muzzle-up on a shot, then settles.
    const kick = this.kick;
    // Swing: a sine half-wave through the frame, so the view model starts and ends every
    // swing in the same place instead of snapping back.
    const swing = melee && this.meleeSwingSeconds > 0
      ? meleeSwingCurve(1 - this.meleeSwingTimer / this.meleeSwingSeconds)
      : 0;
    // Aiming: the hold is pulled towards the centre line. Only x and y move — the weapon's
    // own hold depth is kept, so the muzzle the flash and the tracer leave from keeps its
    // forward offset. Melee weapons and the grenade never take the aim pose: there is no
    // sight on a bat, and one being yanked to the middle of the screen reads as a glitch.
    const aim = melee || ordnance ? 0 : this.adsBlend;
    const holdX = placement.position[0] + (ADS.viewModelPosition[0] - placement.position[0]) * aim;
    const holdY = placement.position[1] + (ADS.viewModelPosition[1] - placement.position[1]) * aim;
    this.viewModelHolder.position.set(
      holdX + this.swayX - swing * MELEE_SWING_SWEEP,
      holdY + this.swayY - equip * WEAPON_LOWERED_DROP + kick * WEAPON_FEEL.kickUp,
      placement.position[2] + kick * WEAPON_FEEL.kickBack - swing * MELEE_SWING_PUSH,
    );
    this.viewModelHolder.rotation.set(
      placement.rotation[0] + this.reloadBlend * WEAPON_RELOAD_TILT + equip * 0.5
        - kick * WEAPON_FEEL.kickPitch + swing * MELEE_SWING_PITCH,
      placement.rotation[1] + swing * MELEE_SWING_YAW,
      placement.rotation[2] + this.reloadBlend * 0.25 + kick * WEAPON_FEEL.kickRoll,
    );
    // Melee weapons are not one size, and neither are firearms: the mesh is normalised by
    // its longest axis, so a spear and a knife (and a belt-fed gun and a sidearm) would be
    // drawn the same length without their own multiplier. The grenade's own placement carries
    // a scale for the same reason.
    this.viewModelHolder.scale.setScalar(this.baseViewModelScale * placement.scale);
    // (the muzzle used to be drawn here as a small sphere; MuzzleFlash now draws it)

    // Measured fit, once per mount and only after the holder's pose above has been written:
    // the barrel tip and the fore-end are read out of the mesh and carried into the frames
    // the draw code uses — the placement for the flash, the hands' own space for the support
    // hand — so both placement scales and the placement rotation are included rather than
    // assumed.
    if (this.fitPending) {
      this.fitPending = false;
      if (model && !melee && !ordnance) {
        const config = this.activeWeapon;
        this.viewModelHolder.updateMatrixWorld(true);
        const fit = this.fits.get(config.id) ?? measureWeaponFit(model);
        this.fits.set(config.id, fit);
        if (config.muzzleFromMesh) {
          muzzleOffsetInPlacement(fit, model, this.viewModelHolder.scale.x,
            config.viewModel.rotation, this.muzzleOffset);
        }
        // A pump gun's support hand holds the fore-end that slides, so the mechanism's own
        // measured station is where the hand belongs; everything else grips the middle of
        // the fore-end.
        const spec = WEAPON_MECHANISMS[config.id];
        const station = spec.kind === 'pump' ? spec.station : SUPPORT_GRIP_STATION;
        if (config.supportFromMesh && this.mountedHands) {
          supportGripInHands(fit, model, this.viewModelHolder, this.mountedHands, station,
            this.supportTarget);
          alignSupportHand(this.mountedHands, this.supportTarget);
        }
      }
    }
  }

  /**
   * Multiplier applied on top of the normalised weapon length.
   *
   * The model is normalised to VIEW_MODEL_LENGTH (0.42 m) by Game, so this is a
   * relative factor. It is deliberately small: a first-person weapon that is even
   * half a metre long at half a metre from the eye fills the screen.
   */
  private get baseViewModelScale(): number {
    return WEAPON_VIEW_MODEL_SCALE;
  }

  /**
   * The model mounted in the holder right now, or null when none is loaded.
   *
   * Exposed for the same reason `mountedViewModelScale` is: the first-person harness used to
   * ask only whether the view-model group was switched on, which is true even when the
   * weapon is drawn somewhere the camera cannot see. Measuring the mounted object — its
   * world position, its box, whether that box meets the frustum — is the question that
   * actually failed here, and it cannot be asked through a boolean.
   */
  get mountedModel(): Object3D | null {
    return this.mountedViewModel;
  }

  /**
   * The scale the mounted view model is actually drawn at, weapon multiplier included.
   *
   * The holder's scale is base × the weapon's own `viewModel.scale` (see
   * applyViewModelTransform), so this is the number that decides how big the thing in the
   * player's hands is on screen — the value a test reads to prove that the belt-fed gun is
   * drawn larger than the bullpup rather than only configured that way.
   */
  get mountedViewModelScale(): number {
    return this.viewModelHolder.scale.x;
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
    this.fillLight.dispose();
    this.runtimes.clear();
    // The parts are built per weapon and parented to the meshes, so teardown has to take
    // them back off: a geometry and a material per weapon would otherwise outlive the run.
    for (const mechanism of this.mechanisms.values()) mechanism.dispose();
    this.mechanisms.clear();
    // The optics are the same: one geometry and one material per mounted sight, parented to
    // the weapon mesh, which would otherwise be left on a mesh nobody is drawing.
    for (const optic of this.optics.values()) disposeOptic(optic);
    this.optics.clear();
    this.meleeViewModels.clear();
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
