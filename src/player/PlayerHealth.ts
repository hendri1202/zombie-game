import { PLAYER } from '../app/gameConfig';
import { clamp } from '../utils/math';

export interface PlayerHealthState {
  health: number;
  maxHealth: number;
  alive: boolean;
  /** Seconds since the last accepted hit; gates the damage cooldown. */
  timeSinceDamage: number;
}

/**
 * Player health, damage gating and death.
 *
 * A short cooldown after each hit prevents two zombies landing on the same frame
 * from deleting the player, and prevents a single attacker from stacking damage
 * while the player is inside its attack volume.
 */
export class PlayerHealth {
  private health = PLAYER.maxHealth;
  /** Per-character ceiling; the base value comes from PLAYER. */
  private maxHealth = PLAYER.maxHealth;
  private alive = true;
  private timeSinceDamage = Number.POSITIVE_INFINITY;
  private readonly regenPerSecond = PLAYER.healthRegenPerSecond;

  get current(): number {
    return this.health;
  }

  get max(): number {
    return this.maxHealth;
  }

  /**
   * Sets the ceiling for the chosen survivor and refills, so picking a character
   * on the title screen never drops the player in already hurt.
   */
  setMaxHealth(max: number): void {
    this.maxHealth = Math.max(1, max);
    this.health = this.maxHealth;
  }

  get isAlive(): boolean {
    return this.alive;
  }

  get fraction(): number {
    return this.maxHealth > 0 ? this.health / this.maxHealth : 0;
  }

  reset(): void {
    this.health = this.maxHealth;
    this.alive = true;
    this.timeSinceDamage = Number.POSITIVE_INFINITY;
  }

  update(delta: number): void {
    this.timeSinceDamage += delta;
    if (this.alive && this.regenPerSecond > 0 && this.health < this.maxHealth) {
      this.health = clamp(this.health + this.regenPerSecond * delta, 0, this.maxHealth);
    }
  }

  /** Returns the damage actually applied (0 when ignored or already dead). */
  applyDamage(amount: number): number {
    if (!this.alive || amount <= 0) return 0;
    if (this.timeSinceDamage < PLAYER.damageCooldown) return 0;
    this.timeSinceDamage = 0;
    const applied = Math.min(amount, this.health);
    this.health = clamp(this.health - amount, 0, this.maxHealth);
    if (this.health <= 0) this.alive = false;
    return applied;
  }

  heal(amount: number): number {
    if (!this.alive || amount <= 0) return 0;
    const before = this.health;
    this.health = clamp(this.health + amount, 0, this.maxHealth);
    return this.health - before;
  }
}
