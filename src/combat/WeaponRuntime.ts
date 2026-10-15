import type { WeaponConfig } from '../app/gameConfig';

export type FireResult = 'fired' | 'empty' | 'cooling-down' | 'reloading' | 'not-owned';

export interface WeaponSnapshot {
  magazine: number;
  reserve: number;
  reloading: boolean;
  reloadProgress: number;
  status: FireResult | 'ready';
}

/**
 * Ammo, fire-rate and reload rules for one weapon. Pure logic with an injected
 * clock so the firing cadence can be tested without a game loop.
 */
export class WeaponRuntime {
  readonly config: WeaponConfig;
  private magazine: number;
  private reserve: number;
  private cooldown = 0;
  private reloadRemaining = 0;
  /** Duration of the active reload, which the survivor's handling can shorten. */
  private reloadSeconds = 0;
  private owned = true;

  constructor(config: WeaponConfig) {
    this.config = config;
    this.magazine = config.magazineSize;
    this.reserve = config.startingReserve;
  }

  get isReloading(): boolean {
    return this.reloadRemaining > 0;
  }

  get isOwned(): boolean {
    return this.owned;
  }

  setOwned(owned: boolean): void {
    this.owned = owned;
  }

  get roundsInMagazine(): number {
    return this.magazine;
  }

  get roundsInReserve(): number {
    return this.reserve;
  }

  get isMagazineEmpty(): boolean {
    return this.magazine <= 0;
  }

  reset(): void {
    this.magazine = this.config.magazineSize;
    this.reserve = this.config.startingReserve;
    this.cooldown = 0;
    this.reloadRemaining = 0;
  }

  addReserve(amount: number): number {
    const before = this.reserve;
    this.reserve = Math.min(this.reserve + amount, this.config.maxReserve);
    return this.reserve - before;
  }

  addMagazine(amount: number): number {
    const space = this.config.magazineSize - this.magazine;
    const added = Math.min(amount, Math.max(0, space));
    this.magazine += added;
    return added;
  }

  /** Advances timers. Always called, pause included, but with delta 0 when paused. */
  update(delta: number): void {
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - delta);
    if (this.reloadRemaining > 0) {
      this.reloadRemaining -= delta;
      if (this.reloadRemaining <= 0) this.completeReload();
    }
  }

  private get fireInterval(): number {
    return 1 / this.config.fireRate;
  }

  tryFire(): FireResult {
    if (!this.owned) return 'not-owned';
    if (this.isReloading) return 'reloading';
    if (this.cooldown > 0) return 'cooling-down';
    if (this.magazine <= 0) return 'empty';
    this.magazine -= 1;
    this.cooldown = this.fireInterval;
    return 'fired';
  }

  /**
   * Starts a reload, optionally scaled by the survivor's handling stat.
   * `timeScale` below 1 is a faster reload.
   */
  startReload(timeScale = 1): boolean {
    if (!this.owned) return false;
    if (this.isReloading) return false;
    if (this.magazine >= this.config.magazineSize) return false;
    if (this.reserve <= 0) return false;
    this.reloadSeconds = this.config.reloadSeconds * Math.max(0.05, timeScale);
    this.reloadRemaining = this.reloadSeconds;
    return true;
  }

  /** Duration of the reload currently in progress, seconds. */
  get currentReloadSeconds(): number {
    return this.reloadSeconds > 0 ? this.reloadSeconds : this.config.reloadSeconds;
  }

  cancelReload(): void {
    this.reloadRemaining = 0;
  }

  private completeReload(): void {
    const needed = this.config.magazineSize - this.magazine;
    const moved = Math.min(needed, this.reserve);
    if (moved <= 0) {
      this.reloadRemaining = 0;
      return;
    }
    this.magazine += moved;
    this.reserve -= moved;
    this.reloadRemaining = 0;
  }

  snapshot(): WeaponSnapshot {
    let status: WeaponSnapshot['status'] = 'ready';
    if (this.isReloading) status = 'reloading';
    else if (this.magazine <= 0) status = 'empty';
    return {
      magazine: this.magazine,
      reserve: this.reserve,
      reloading: this.isReloading,
      reloadProgress: this.isReloading ? 1 - this.reloadRemaining / this.config.reloadSeconds : 0,
      status,
    };
  }
}
