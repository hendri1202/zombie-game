import { Box3, Camera, Group, Object3D, Raycaster, Vector3 } from 'three';
import {
  HANDS_PLACEMENT, createFirstPersonHands, type GripKind,
} from './proceduralArms';
import {
  DEFAULT_GRENADE, GRENADES, STARTING_LOADOUT, STARTING_WEAPON, WEAPON_FEEL, WEAPONS,
  type GrenadeConfig, type GrenadeId, type WeaponConfig, type WeaponId,
} from '../app/gameConfig';
import { DEFAULT_MELEE, MELEE, type MeleeConfig, type MeleeId } from '../app/meleeConfig';
import type { EventBus } from '../core/EventBus';
import type { GameEvents } from '../app/GameEvents';
import type { DamageSystem, HitscanReport } from '../combat/DamageSystem';
import { meleeSwingCurve, type MeleeSystem } from '../combat/MeleeSystem';
import type { GrenadeSystem } from '../combat/GrenadeSystem';
import { WeaponRuntime } from '../combat/WeaponRuntime';
import type { InputSnapshot } from '../input/InputManager';
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
  private readonly viewModels = new Map<WeaponId, Object3D>();
  private readonly meleeViewModels = new Map<MeleeId, Object3D>();
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
    this.melee = deps.melee;
    this.grenades = deps.grenades ?? null;
    this.grenadeViewModel = deps.grenadeViewModel ?? null;

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
    if (deps.meleeViewModels) {
      for (const [id, model] of deps.meleeViewModels) this.meleeViewModels.set(id, model);
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
    this.resetMelee();
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
    this.ordnanceSelected = true;
    this.equipTimer = WEAPON_EQUIP_SECONDS;
    this.applyViewModelTransform();
    return true;
  }

  /** Puts the grenade away and returns the firearm to the hand. False when it was already away. */
  holsterOrdnance(): boolean {
    if (!this.ordnanceSelected) return false;
    this.ordnanceSelected = false;
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
    this.equipTimer = WEAPON_EQUIP_SECONDS;
    this.applyViewModelTransform();
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
      this.viewModelHolder.add(hands);
      this.mountedHands = hands;
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
    this.viewModelHolder.position.set(
      placement.position[0] + this.swayX - swing * MELEE_SWING_SWEEP,
      placement.position[1] + this.swayY - equip * WEAPON_LOWERED_DROP + kick * WEAPON_FEEL.kickUp,
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
    this.runtimes.clear();
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
