import { describe, expect, it } from 'vitest';
import {
  CHARACTERS, DEFAULT_CHARACTER_ID, characterRatings, findCharacter,
} from '../src/app/characters';

describe('survivor roster', () => {
  it('offers four playable characters with unique ids and model files', () => {
    expect(CHARACTERS).toHaveLength(4);
    expect(new Set(CHARACTERS.map((c) => c.id)).size).toBe(4);
    expect(new Set(CHARACTERS.map((c) => c.file)).size).toBe(4);
  });

  it('builds every model path inside the survivor asset folder', () => {
    for (const character of CHARACTERS) {
      // glTF is the only runtime model format (agents.md); an FBX path here would
      // ship a format the policy forbids and the loader no longer accepts.
      expect(character.file, character.id).toMatch(/^[A-Za-z_]+\.gltf$/);
    }
  });

  it('names the bundled weapon kept visible as the one in hand', () => {
    for (const character of CHARACTERS) {
      expect(character.weaponMesh, character.id).toBeTruthy();
    }
  });

  it('keeps stats inside ranges the game can actually run', () => {
    for (const { name, stats, height } of CHARACTERS) {
      expect(stats.maxHealth, name).toBeGreaterThanOrEqual(80);
      expect(stats.maxHealth, name).toBeLessThanOrEqual(160);
      expect(stats.walkSpeed, name).toBeGreaterThan(3);
      expect(stats.walkSpeed, name).toBeLessThan(5.5);
      // A sprint slower than a walk would make the sprint key reduce speed.
      expect(stats.sprintSpeed, name).toBeGreaterThan(stats.walkSpeed);
      expect(stats.reloadMultiplier, name).toBeGreaterThan(0.5);
      expect(stats.reloadMultiplier, name).toBeLessThan(1.5);
      expect(stats.damageMultiplier, name).toBeGreaterThan(0.8);
      expect(stats.damageMultiplier, name).toBeLessThan(1.5);
      // Human scale: the model is normalised to this, so a typo is a giant or a doll.
      expect(height, name).toBeGreaterThan(1.5);
      expect(height, name).toBeLessThan(2);
    }
  });

  it('gives each character a distinct profile rather than four copies', () => {
    const healths = new Set(CHARACTERS.map((c) => c.stats.maxHealth));
    const speeds = new Set(CHARACTERS.map((c) => c.stats.sprintSpeed));
    expect(healths.size).toBeGreaterThanOrEqual(3);
    expect(speeds.size).toBeGreaterThanOrEqual(3);
  });

  it('has locomotion clip candidates for every character', () => {
    for (const character of CHARACTERS) {
      for (const state of ['idle', 'walk', 'run'] as const) {
        expect(character.clips[state].length, `${character.id}.${state}`).toBeGreaterThan(0);
      }
      // The gun-holding variants are what these models actually ship; listing them
      // first is what keeps the character aiming instead of standing idle.
      expect(character.clips.idle[0]).toBe('Idle_Gun');
      expect(character.clips.walk[0]).toBe('Walk_Gun');
      expect(character.clips.run[0]).toBe('Run_Gun');
    }
  });

  it('falls back to the default character for unknown ids', () => {
    expect(findCharacter('nobody').id).toBe(DEFAULT_CHARACTER_ID);
    expect(findCharacter(null).id).toBe(DEFAULT_CHARACTER_ID);
    expect(findCharacter(undefined).id).toBe(DEFAULT_CHARACTER_ID);
    expect(findCharacter('matt').id).toBe('matt');
  });

  it('derives rating bars that track the underlying stats', () => {
    const byHealth = [...CHARACTERS].sort((a, b) => a.stats.maxHealth - b.stats.maxHealth);
    const weakest = characterRatings(byHealth[0]);
    const toughest = characterRatings(byHealth[byHealth.length - 1]);
    expect(toughest.toughness).toBeGreaterThan(weakest.toughness);

    const bySpeed = [...CHARACTERS].sort((a, b) => a.stats.sprintSpeed - b.stats.sprintSpeed);
    expect(characterRatings(bySpeed[bySpeed.length - 1]).speed)
      .toBeGreaterThan(characterRatings(bySpeed[0]).speed);

    for (const character of CHARACTERS) {
      const ratings = characterRatings(character);
      for (const value of [ratings.speed, ratings.toughness, ratings.handling]) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('rates a faster reload as better handling', () => {
    const quick = CHARACTERS.find((c) => c.stats.reloadMultiplier === Math.min(...CHARACTERS.map((x) => x.stats.reloadMultiplier)));
    const slow = CHARACTERS.find((c) => c.stats.reloadMultiplier === Math.max(...CHARACTERS.map((x) => x.stats.reloadMultiplier)));
    expect(quick && slow).toBeTruthy();
    if (!quick || !slow) return;
    expect(characterRatings(quick).handling).toBeGreaterThan(characterRatings(slow).handling);
  });
});
