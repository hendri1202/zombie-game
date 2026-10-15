import { describe, expect, it } from 'vitest';
import { PLAYER } from '../src/app/gameConfig';
import { PlayerHealth } from '../src/player/PlayerHealth';

describe('PlayerHealth', () => {
  it('starts at full health and alive', () => {
    const health = new PlayerHealth();
    expect(health.current).toBe(PLAYER.maxHealth);
    expect(health.isAlive).toBe(true);
    expect(health.fraction).toBe(1);
  });

  it('applies damage and reports how much was actually dealt', () => {
    const health = new PlayerHealth();
    expect(health.applyDamage(30)).toBe(30);
    expect(health.current).toBe(70);
  });

  it('ignores a second hit inside the damage cooldown, so a pack cannot delete the player', () => {
    const health = new PlayerHealth();
    expect(health.applyDamage(10)).toBe(10);
    // A simultaneous second zombie in the same frame must not stack.
    expect(health.applyDamage(10)).toBe(0);
    health.update(PLAYER.damageCooldown + 0.01);
    expect(health.applyDamage(10)).toBe(10);
  });

  it('dies at zero and never goes negative', () => {
    const health = new PlayerHealth();
    health.applyDamage(PLAYER.maxHealth * 5);
    expect(health.current).toBe(0);
    expect(health.isAlive).toBe(false);
    // Damage after death is refused.
    health.update(1);
    expect(health.applyDamage(10)).toBe(0);
  });

  it('heals without exceeding the maximum and reports the real amount', () => {
    const health = new PlayerHealth();
    health.applyDamage(50);
    health.update(1);
    expect(health.heal(20)).toBe(20);
    expect(health.heal(999)).toBe(PLAYER.maxHealth - 70);
    expect(health.current).toBe(PLAYER.maxHealth);
  });

  it('refuses healing when dead', () => {
    const health = new PlayerHealth();
    health.applyDamage(PLAYER.maxHealth * 2);
    expect(health.heal(50)).toBe(0);
  });

  it('resets back to a clean state', () => {
    const health = new PlayerHealth();
    health.applyDamage(PLAYER.maxHealth * 2);
    health.reset();
    expect(health.current).toBe(PLAYER.maxHealth);
    expect(health.isAlive).toBe(true);
  });
});
