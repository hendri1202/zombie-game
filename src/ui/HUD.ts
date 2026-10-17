import { FEEDBACK, PLAYER } from '../app/gameConfig';
import { opticVisibleFor, reticleFor, type OpticSpec } from '../app/opticsConfig';
import type { Unsubscribe } from '../core/EventBus';
import type { EventBus } from '../core/EventBus';
import type { GameEvents } from '../app/GameEvents';
import type { GamePhase } from '../core/GameState';
import { clamp } from '../utils/math';

/**
 * Whether the HUD is up, decided by the phase alone.
 *
 * The in-run readout is the only thing this element is for, so every phase that is not play —
 * loading, title, pause and game over — must have it down. That is not a detail of the
 * death path: the won run reuses the `gameOver` phase for its own results screen, and both
 * endings hide the HUD for the same reason, that the run they were reporting is over.
 *
 * Expressed as one function and tested (tests/hud-visibility.test.ts) because the phase is
 * the single source of truth here and the two must not be able to drift: a browser gate once
 * read `#hud.hidden` and called it a regression, when the harness had simply let the run end
 * before it looked (see the comment on the check in tools/smoke.mjs).
 */
export function hudVisibleFor(phase: GamePhase): boolean {
  return phase === 'playing';
}

export interface HudState {
  health: number;
  ammo: number;
  reserve: number;
  weaponName: string;
  /**
   * Name of the melee weapon carried, shown in place of the firearm's name while the
   * melee weapon is the one in hand. The firearm keeps its own `weaponName` so switching
   * back restores the readout without the HUD having to remember anything.
   */
  meleeName: string;
  /** True while the melee weapon, not a firearm, is drawn. */
  melee: boolean;
  /** Name of the ordnance in hand, shown in place of the firearm's name while a grenade is out. */
  ordnanceName: string;
  /** True while the grenade, not a firearm or melee weapon, is drawn. */
  ordnance: boolean;
  /** Grenades left in the pouch. Always shown, whatever is in hand. */
  grenades: number;
  kills: number;
  wave: number;
  remaining: number;
  /** Spendable point balance, carried between runs (see ProfileStore). */
  points: number;
  reloading: boolean;
  spread: number;
  /**
   * One-line instruction for the current directional objective — what to do, how far and
   * which way. Empty when there is no objective to chase.
   */
  objective: string;
  /**
   * Angle of the objective relative to where the player is facing, radians; 0 is straight
   * ahead, positive turns clockwise. Rotates the arrow, which is what makes "follow the
   * marker" work without a map.
   */
  objectiveAngle: number;
  /** True while an objective is active; false once the mission is complete. */
  objectiveActive: boolean;
  /**
   * The firearm in hand, or null while the melee weapon or the grenade is out — what the
   * aiming reticle is drawn for. One field rather than a weapon id plus two flags: the two
   * cases the reticle must never appear in (a drawn melee weapon, a selected grenade) are
   * already resolved by whoever builds the state, and a second flag could only disagree.
   */
  opticWeaponId: string | null;
  /** True with the sights fully up, i.e. `WeaponController.aiming`. */
  aiming: boolean;
}

/**
 * How the bottom-right weapon row should read.
 *
 * A melee weapon has no magazine, so printing the last firearm's ammunition next to it
 * was a lie: the numbers belonged to a pistol that is not in hand. Melee therefore shows
 * its own name and a plain `MELEE` marker with the `/` and reserve cells dropped, and a
 * firearm gets exactly the readout it had before. Pure, so the rule is a unit test rather
 * than something only a running game can show.
 */
export interface HudWeaponReadout {
  /** Text for the weapon name label. */
  name: string;
  /** Text for #hud-ammo: the magazine, or the melee marker. */
  ammo: string;
  /** Text for #hud-reserve; empty when there is no magazine to show. */
  reserve: string;
  /** True when the slash separator and the reserve cell should be hidden. */
  hideReserve: boolean;
}

export function hudWeaponReadout(options: {
  weaponName: string;
  meleeName: string;
  magazine: number;
  reserve: number;
  melee: boolean;
  /** Name and count of the ordnance in hand; both optional so the firearm/melee calls are unchanged. */
  ordnanceName?: string;
  grenades?: number;
  ordnance?: boolean;
}): HudWeaponReadout {
  if (options.ordnance) {
    // The grenade has no magazine: the number shown is how many are left in the pouch, and
    // there is no reserve cell to show beside it.
    return {
      name: (options.ordnanceName ?? 'FRAG GRENADE').toUpperCase(),
      ammo: String(Math.max(0, Math.round(options.grenades ?? 0))),
      reserve: '',
      hideReserve: true,
    };
  }
  if (options.melee) {
    return { name: options.meleeName.toUpperCase(), ammo: 'MELEE', reserve: '', hideReserve: true };
  }
  return {
    name: options.weaponName.toUpperCase(),
    ammo: String(options.magazine),
    reserve: String(options.reserve),
    hideReserve: false,
  };
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`HUD element #${id} is missing from index.html`);
  return element as T;
}

/**
 * HUD overlay.
 *
 * It is plain DOM: readable text, no canvas drawing, and every value it shows is
 * passed in from the game each frame, so the HUD can never drift out of sync
 * with the simulation.
 */
export class HUD {
  private readonly root = requireElement('hud');
  private readonly health = requireElement('hud-health');
  private readonly healthBar = requireElement('hud-health-bar');
  private readonly ammo = requireElement('hud-ammo');
  private readonly ammoSeparator = requireElement('hud-ammo-sep');
  private readonly reserve = requireElement('hud-reserve');
  private readonly weapon = requireElement('hud-weapon');
  private readonly kills = requireElement('hud-kills');
  private readonly wave = requireElement('hud-wave');
  private readonly remaining = requireElement('hud-remaining');
  private readonly points = requireElement('hud-points');
  private readonly grenades = requireElement('hud-grenades');
  private readonly crosshair = requireElement('crosshair');
  private readonly optic = requireElement('optic');
  private readonly toast = requireElement('hud-toast');
  private readonly objective = requireElement('hud-objective');
  private readonly objectiveText = requireElement('objective-text');
  private readonly objectiveArrow = requireElement('objective-arrow');
  private readonly reloadPrompt = requireElement('hud-reload-prompt');
  private readonly damageVignette = requireElement('damage-vignette');
  private readonly hitmarker = requireElement('hitmarker');
  private readonly debug = requireElement('debug-overlay') as HTMLDivElement;

  private toastTimer = 0;
  private vignetteTimer = 0;
  private hitmarkerTimer = 0;
  /** Seconds left of the point-award pulse on the balance readout. */
  private pointPulseTimer = 0;
  private debugVisible = false;
  private flashEffectsEnabled = true;
  /**
   * The state currently painted into `#optic`, by identity.
   *
   * The table's rows are stable objects, so this is both "which mark is drawn" and "with which
   * numbers": two SMGs share a kind but not a size, and reusing the cached element between them
   * would leave the MP5 drawn with the compact SMG's dot. Written only when it changes, so a
   * sight that is up for a whole magazine costs one style write rather than one a frame.
   *
   * `undefined` until the first write, and deliberately not the same as `null`: "no mark" is a
   * state the element has to be written into, not one it may be assumed to start in. Starting at
   * `null` would let a first frame with nothing to draw leave whatever the element already carried.
   */
  private opticPainted: OpticSpec | null | undefined;
  private readonly unsubscribers: Unsubscribe[] = [];

  constructor(events: EventBus<GameEvents>) {
    this.unsubscribers.push(
      events.on('combat:hit', ({ zone, killed }) => this.showHitmarker(zone === 'head', killed)),
      events.on('player:damaged', () => this.showDamage()),
      events.on('toast', ({ text, tone }) => this.showToast(text, tone ?? 'info')),
      events.on('wave:started', ({ wave, total }) => this.showToast(`Wave ${wave} — ${total} incoming`, 'warn')),
      events.on('wave:cleared', ({ wave }) => this.showToast(`Wave ${wave} cleared`, 'info')),
      events.on('pickup:collected', ({ label }) => this.showToast(`Picked up ${label}`, 'info')),
      events.on('weapon:unlocked', ({ weaponId }) => this.showToast(`New weapon: ${weaponId}`, 'warn')),
      // The balance is the only HUD number that changes without the player looking at it, so
      // every award pulses it: a kill you did not notice is otherwise invisible.
      events.on('points:awarded', ({ amount }) => {
        if (amount > 0) this.pulsePoints();
      }),
    );
  }

  setFlashEffects(enabled: boolean): void {
    this.flashEffectsEnabled = enabled;
    if (!enabled) {
      this.damageVignette.classList.remove('active');
      this.hitmarker.classList.remove('active');
    }
  }

  show(): void {
    this.root.classList.remove('hidden');
    this.root.setAttribute('aria-hidden', 'false');
  }

  hide(): void {
    this.root.classList.add('hidden');
    this.root.setAttribute('aria-hidden', 'true');
  }

  update(delta: number, state: HudState): void {
    this.health.textContent = String(Math.max(0, Math.round(state.health)));
    this.healthBar.style.width = `${clamp((state.health / PLAYER.maxHealth) * 100, 0, 100)}%`;
    this.healthBar.classList.toggle('low', state.health <= PLAYER.maxHealth * 0.3);
    // The weapon row is the one place melee/ordnance differ from a firearm: no magazine to
    // count, and for a grenade the count that replaces it is the pouch, not the chamber.
    const readout = hudWeaponReadout({
      weaponName: state.weaponName,
      meleeName: state.meleeName,
      magazine: state.ammo,
      reserve: state.reserve,
      melee: state.melee,
      ordnanceName: state.ordnanceName,
      ordnance: state.ordnance,
      grenades: state.grenades,
    });
    this.weapon.textContent = readout.name;
    this.ammo.textContent = readout.ammo;
    this.reserve.textContent = readout.reserve;
    this.ammoSeparator.classList.toggle('hidden', readout.hideReserve);
    this.reserve.classList.toggle('hidden', readout.hideReserve);
    this.ammo.classList.toggle('is-melee', state.melee);
    // The grenade count has its own readout so it is visible whatever is in hand: the player
    // has to know they are out before the throw that fails, not after.
    this.grenades.textContent = String(Math.max(0, Math.round(state.grenades)));
    this.kills.textContent = String(state.kills);
    this.wave.textContent = String(Math.max(1, state.wave));
    this.remaining.textContent = String(state.remaining);
    this.points.textContent = String(Math.max(0, Math.round(state.points)));

    // Directional objective. Hidden the moment there is nothing to chase — before the run
    // starts and after the last point is reached — so it never shows a stale instruction.
    this.objective.classList.toggle('hidden', !state.objectiveActive);
    if (state.objectiveActive) {
      this.objectiveText.textContent = state.objective;
      // CSS rotation is clockwise-positive and so is the bearing, so the sign carries
      // straight through: 0 deg leaves the glyph pointing straight ahead.
      this.objectiveArrow.style.transform = `rotate(${((state.objectiveAngle * 180) / Math.PI).toFixed(1)}deg)`;
    }

    // Crosshair bloom communicates real spread, not a decorative animation.
    const bloom = 6 + state.spread * 22;
    this.crosshair.style.setProperty('--bloom', `${bloom}px`);
    this.crosshair.classList.toggle('reloading', state.reloading);

    // The aiming reticle, written again on every update rather than only when one is up.
    //
    // `opticVisibleFor` is the whole rule — the sights up *and* a weapon that has a mark — and it
    // is asked on every frame, so the pistol (no sight, by the owner's request), a drawn melee
    // weapon, a selected grenade, released ADS and a paused game all put the mark down on the
    // frame they happen, by the same line rather than by five exceptions that could drift apart.
    // The element is *written* either way: skipping the write when there is no mark is what left
    // the pistol carrying the shotgun's `data-kind="bead"` and its `--optic-*` numbers, so a
    // read-back of `#optic` answered for a weapon that was no longer in hand.
    const opticVisible = opticVisibleFor(state.opticWeaponId, state.aiming);
    this.paintOptic(opticVisible ? reticleFor(state.opticWeaponId) : null);
    this.optic.classList.toggle('visible', opticVisible);
    this.optic.setAttribute('aria-hidden', String(!opticVisible));
    // The plain crosshair steps aside in the same frame. Both marks are centred, so they
    // would be drawn exactly on top of each other — two aiming marks in the same pixel read as
    // neither one, and the base crosshair's bloom would sit under the reticle's own arms.
    // Taking the crosshair off screen is what keeps the reticle legible: one mark, in the
    // middle, with nothing behind it. The pistol never reaches this and keeps its crosshair.
    this.crosshair.classList.toggle('sighted', opticVisible);

    const needsReload = !state.reloading && state.ammo === 0;
    this.reloadPrompt.classList.toggle('hidden', !needsReload);

    if (this.toastTimer > 0) {
      this.toastTimer -= delta;
      if (this.toastTimer <= 0) this.toast.classList.add('hidden');
    }
    if (this.vignetteTimer > 0) {
      this.vignetteTimer -= delta;
      if (this.vignetteTimer <= 0) this.damageVignette.classList.remove('active');
    }
    if (this.hitmarkerTimer > 0) {
      this.hitmarkerTimer -= delta;
      if (this.hitmarkerTimer <= 0) this.hitmarker.classList.remove('active');
    }
    if (this.pointPulseTimer > 0) {
      this.pointPulseTimer -= delta;
      if (this.pointPulseTimer <= 0) this.points.classList.remove('pulse');
    }
  }

  /**
   * Writes the mark's shape and its numbers into the element — or wipes them out when there is no
   * mark to draw.
   *
   * Called on every update, `null` included, so the element always holds the state of the weapon
   * in hand rather than the state of whichever weapon was drawn last. Passing `null` writes
   * `data-kind="none"` (the value index.html ships, which no rule in the stylesheet draws) and
   * drops the four `--optic-*` custom properties, so nothing survives to be read back as the
   * previous weapon's sight: a skipped write there is what left the pistol wearing the shotgun's
   * bead, and a stale `data-kind` is exactly what a DOM probe reads.
   *
   * The *shape* comes from `data-kind` (CSS, one rule per kind) and every number — colour,
   * size, thickness, gap — from the table, so nothing about how a dot looks is a literal in a
   * stylesheet. The mark is drawn on the mark's own element rather than by swapping classes, so
   * two weapons with the same kind but different numbers (the compact SMG's 8 px dot against
   * the MP5's 7 px) cannot inherit each other's sizes.
   *
   * Guarded by identity against the last write, so a sight held up for a whole magazine costs one
   * style write rather than one a frame. `opticPainted` starts `undefined`, which is not `null`,
   * so the first update writes the element whatever it happens to carry.
   */
  private paintOptic(spec: OpticSpec | null): void {
    if (this.opticPainted === spec) return;
    this.opticPainted = spec;
    const style = this.optic.style;
    if (!spec) {
      this.optic.dataset.kind = 'none';
      style.removeProperty('--optic-color');
      style.removeProperty('--optic-size');
      style.removeProperty('--optic-thickness');
      style.removeProperty('--optic-gap');
      return;
    }
    this.optic.dataset.kind = spec.kind;
    style.setProperty('--optic-color', spec.color);
    style.setProperty('--optic-size', `${spec.size}px`);
    style.setProperty('--optic-thickness', `${spec.thickness}px`);
    style.setProperty('--optic-gap', `${spec.gap}px`);
  }

  private pulsePoints(): void {
    this.points.classList.remove('pulse');
    // Re-add on the next frame so a second kill while the pulse is running restarts it
    // instead of being swallowed by the in-flight animation.
    void this.points.offsetWidth;
    this.points.classList.add('pulse');
    this.pointPulseTimer = 0.4;
  }

  private showToast(text: string, tone: 'info' | 'warn' | 'danger'): void {
    this.toast.textContent = text;
    this.toast.className = `toast tone-${tone}`;
    this.toastTimer = FEEDBACK.toastSeconds;
  }

  private showDamage(): void {
    if (!this.flashEffectsEnabled) return;
    this.damageVignette.classList.add('active');
    this.vignetteTimer = FEEDBACK.damageVignetteSeconds;
  }

  private showHitmarker(headshot: boolean, killed: boolean): void {
    if (!this.flashEffectsEnabled) return;
    this.hitmarker.className = `hitmarker active${headshot ? ' headshot' : ''}${killed ? ' kill' : ''}`;
    this.hitmarkerTimer = FEEDBACK.hitmarkerSeconds;
  }

  get debugVisibleState(): boolean {
    return this.debugVisible;
  }

  setDebugVisible(visible: boolean): void {
    this.debugVisible = visible;
    this.debug.classList.toggle('hidden', !visible);
    if (!visible) this.debug.textContent = '';
  }

  setDebugText(text: string): void {
    if (!this.debugVisible) return;
    this.debug.textContent = text;
  }

  dispose(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
  }
}
