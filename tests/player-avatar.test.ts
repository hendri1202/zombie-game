import { AnimationClip } from 'three';
import { describe, expect, it } from 'vitest';
import {
  AVATAR_IDLE_SPEED, AVATAR_RUN_SPEED, avatarStateForSpeed,
} from '../src/player/PlayerAvatar';
import { resolveByCandidates, resolveCandidateMap, shortName } from '../src/utils/clipResolve';
import { CHARACTERS } from '../src/app/characters';

/** Builds a clip with an exporter-style armature prefix. */
function clip(name: string): AnimationClip {
  return new AnimationClip(`CharacterArmature|${name}`, 1, []);
}

describe('avatar locomotion state', () => {
  it('stands still below the idle threshold and walks up to the run threshold', () => {
    expect(avatarStateForSpeed(0)).toBe('idle');
    expect(avatarStateForSpeed(AVATAR_IDLE_SPEED - 0.001)).toBe('idle');
    expect(avatarStateForSpeed(AVATAR_IDLE_SPEED)).toBe('walk');
    expect(avatarStateForSpeed(AVATAR_RUN_SPEED - 0.001)).toBe('walk');
    expect(avatarStateForSpeed(AVATAR_RUN_SPEED)).toBe('run');
    expect(avatarStateForSpeed(12)).toBe('run');
  });

  it('reaches the run state for each character at their own sprint speed', () => {
    for (const character of CHARACTERS) {
      expect(avatarStateForSpeed(character.stats.sprintSpeed), character.id).toBe('run');
      expect(avatarStateForSpeed(character.stats.walkSpeed), character.id).toBe('walk');
    }
  });
});

describe('clip resolution', () => {
  it('prefers the gun-holding variant these survivors actually ship', () => {
    const clips = [clip('Idle'), clip('Idle_Gun'), clip('Walk'), clip('Walk_Gun'), clip('Run'), clip('Run_Gun')];
    const map = resolveCandidateMap(clips, {
      idle: [['Idle_Gun', 'Idle']],
      walk: [['Walk_Gun', 'Walk']],
      run: [['Run_Gun', 'Run']],
    });
    expect(shortName(clips[1])).toBe('idle_gun');
    expect(map.idle).toBe('CharacterArmature|Idle_Gun');
    expect(map.walk).toBe('CharacterArmature|Walk_Gun');
    expect(map.run).toBe('CharacterArmature|Run_Gun');
  });

  it('falls back to the plain clip when no gun variant exists', () => {
    const clips = [clip('Idle'), clip('Walk'), clip('Run')];
    const idle = resolveByCandidates(clips, [['Idle_Gun', 'Idle']]);
    expect(idle.matchedName).toBe('CharacterArmature|Idle');
    expect(idle.usedFallback).toBe(false);
  });

  it('does not mistake a longer clip name for the state it contains', () => {
    // "Idle_Attack" contains "IDLE"; exact matching has to win or the character
    // would attack while standing still.
    const clips = [clip('Idle_Attack'), clip('Idle')];
    const resolved = resolveByCandidates(clips, [['Idle']]);
    expect(resolved.matchedName).toBe('CharacterArmature|Idle');
  });

  it('walks down the fallback groups when a whole state is missing', () => {
    const clips = [clip('Walk_Gun')];
    const resolved = resolveByCandidates(clips, [['Run_Gun', 'Run'], ['Walk_Gun', 'Walk'], ['Idle_Gun', 'Idle']]);
    expect(resolved.matchedName).toBe('CharacterArmature|Walk_Gun');
    expect(resolved.usedFallback).toBe(true);
  });

  it('reports a missing clip rather than inventing one', () => {
    const resolved = resolveByCandidates([clip('Wave')], [['Run_Gun', 'Run']]);
    expect(resolved.clip).toBeNull();
    expect(resolved.matchedName).toBeNull();
    expect(resolved.usedFallback).toBe(true);
  });

  it('handles clips with no armature prefix at all', () => {
    const plain = new AnimationClip('Run', 1, []);
    expect(shortName(plain)).toBe('run');
    expect(resolveByCandidates([plain], [['Run_Gun', 'Run']]).matchedName).toBe('Run');
  });
});
