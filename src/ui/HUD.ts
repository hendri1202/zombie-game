import { FEEDBACK, PLAYER } from '../app/gameConfig';
import type { Unsubscribe } from '../core/EventBus';
import type { EventBus } from '../core/EventBus';
import type { GameEvents } from '../app/GameEvents';
import { clamp } from '../utils/math';

export interface HudState {
  health: number;
  ammo: number;
  reserve: number;
  weaponName: string;
  kills: number;
  wave: number;
  remaining: number;
  reloading: boolean;
  spread: number;
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
  private readonly reserve = requireElement('hud-reserve');
  private readonly weapon = requireElement('hud-weapon');
  private readonly kills = requireElement('hud-kills');
  private readonly wave = requireElement('hud-wave');
  private readonly remaining = requireElement('hud-remaining');
  private readonly crosshair = requireElement('crosshair');
  private readonly toast = requireElement('hud-toast');
  private readonly reloadPrompt = requireElement('hud-reload-prompt');
  private readonly damageVignette = requireElement('damage-vignette');
  private readonly hitmarker = requireElement('hitmarker');
  private readonly debug = requireElement('debug-overlay') as HTMLDivElement;

  private toastTimer = 0;
  private vignetteTimer = 0;
  private hitmarkerTimer = 0;
  private debugVisible = false;
  private flashEffectsEnabled = true;
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
    this.ammo.textContent = String(state.ammo);
    this.reserve.textContent = String(state.reserve);
    this.weapon.textContent = state.weaponName.toUpperCase();
    this.kills.textContent = String(state.kills);
    this.wave.textContent = String(Math.max(1, state.wave));
    this.remaining.textContent = String(state.remaining);

    // Crosshair bloom communicates real spread, not a decorative animation.
    const bloom = 6 + state.spread * 22;
    this.crosshair.style.setProperty('--bloom', `${bloom}px`);
    this.crosshair.classList.toggle('reloading', state.reloading);

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
