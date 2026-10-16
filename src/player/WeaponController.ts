import { Box3, Camera, Group, Object3D, Raycaster, Vector3 } from 'three';
import {
  HANDS_PLACEMENT, createFirstPersonHands, type GripKind,
} from './proceduralArms';
import {
  STARTING_LOADOUT, STARTING_WEAPON, WEAPON_FEEL, WEAPONS, type WeaponConfig, type WeaponId,
} from '../app/gameConfig';
import { DEFAULT_MELEE, MELEE, type MeleeConfig, type MeleeId } from '../app/meleeConfig';
import type { EventBus } from '../core/EventBus';
import type { GameEvents } from '../app/GameEvents';
import type { DamageSystem, HitscanReport } from '../combat/DamageSystem';
import { meleeSwingCurve, type MeleeSystem } from '../combat/MeleeSystem';
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
      // The slot already holds this weapon: a slot key pressed while the melee weapon is
      // out is the way back to the gun, so the draw state is what changes.
      if (this.meleeDrawn) {
        this.holsterMelee();
        return true;
      }
      return false;
    }
    this.runtimes.get(this.current)?.cancelReload();
    this.current = id;
    // A firearm in hand means the melee weapon is away, wherever it was drawn from.
    this.meleeDrawn = false;
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
   * Sets which melee weapon F draws, without drawing it.
   *
   * The store needs this: a melee weapon bought mid-run should be the one F reaches for from
   * then on, and re-applying a saved loadout at the start of a run should not pop a "drawn"
   * toast before the first wave. `equipMelee` cannot be used for it because it also draws.
   */
  setCarriedMelee(id: MeleeId): void {
    this.meleeId = id;
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
    if (this.meleeDrawn) {
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
    const model = melee
      ? this.meleeViewModels.get(melee.id) ?? null
      : this.viewModels.get(this.current) ?? null;
    const placement = melee ? melee.viewModel : this.activeWeapon.viewModel;
    const grip = melee ? melee.grip : this.activeWeapon.grip;

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
    // Melee weapons are not one size: the mesh is normalised by its longest axis, so a
    // spear and a knife would be drawn the same length without this multiplier.
    this.viewModelHolder.scale.setScalar(this.viewModelScale * (melee ? melee.viewModel.scale : 1));
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
