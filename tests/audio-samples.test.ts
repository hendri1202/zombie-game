import { describe, expect, it } from 'vitest';
import {
  SHOT_SAMPLES, TAIL_SECONDS, allSampleFiles, createImpulseResponse, impulsePeakNear,
  samplePath, shotGain, shotPlaybackRate, shotRoleFor,
} from '../src/systems/audioSamples';
import { SeededRandom } from '../src/utils/math';
import { WEAPONS, type WeaponId } from '../src/app/gameConfig';

describe('shot sample mapping', () => {
  it('sends each weapon to the recording it should fire', () => {
    expect(shotRoleFor('pistol')).toBe('pistol');
    expect(shotRoleFor('rifle')).toBe('rifle');
    expect(shotRoleFor('shotgun')).toBe('shotgun');
    // Not in the game yet, mapped by intent so adding them needs no change here.
    expect(shotRoleFor('smg' as WeaponId)).toBe('rifle');
    expect(shotRoleFor('lmg' as WeaponId)).toBe('heavy');
    expect(shotRoleFor('something-unknown')).toBe('pistol');
  });

  it('fires a recording the game actually ships for every weapon in the config', () => {
    const shipped = new Set(allSampleFiles());
    for (const id of Object.keys(WEAPONS) as WeaponId[]) {
      const role = shotRoleFor(id);
      expect(SHOT_SAMPLES[role].length, id).toBeGreaterThan(0);
      for (const file of SHOT_SAMPLES[role]) {
        expect(shipped.has(file), `${id} -> ${file}`).toBe(true);
      }
    }
  });

  it('lists each sample once, and builds paths under the audio folder', () => {
    const files = allSampleFiles();
    expect(new Set(files).size).toBe(files.length);
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const file of files) expect(file.endsWith('.wav')).toBe(true);
    expect(samplePath('pistol-1.wav')).toBe('/assets/audio/pistol-1.wav');
  });

  it('varies pitch and gain per shot but keeps them in range', () => {
    const low = shotPlaybackRate(() => 0);
    const high = shotPlaybackRate(() => 1);
    expect(low).toBeCloseTo(0.96, 5);
    expect(high).toBeCloseTo(1.04, 5);
    // A burst of fire must not be the identical waveform pasted end to end.
    expect(high - low).toBeGreaterThan(0.05);
    expect(shotGain(() => 0)).toBeCloseTo(0.88, 5);
    expect(shotGain(() => 1)).toBeCloseTo(1.08, 5);
  });
});

describe('reverb impulse response', () => {
  it('is noise that starts loud and decays away', () => {
    const rate = 48000;
    const rng = new SeededRandom(7);
    const impulse = createImpulseResponse(rate, TAIL_SECONDS, 3.2, () => rng.next());
    expect(impulse.length).toBe(Math.floor(rate * TAIL_SECONDS));
    const start = impulsePeakNear(impulse, 0.01);
    const middle = impulsePeakNear(impulse, 0.5);
    const end = impulsePeakNear(impulse, 0.98);
    expect(start).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(end);
    expect(end).toBeLessThan(start * 0.05);
    for (const value of impulse) expect(Number.isFinite(value)).toBe(true);
  });

  it('is deterministic for a given random source', () => {
    const first = new SeededRandom(3);
    const second = new SeededRandom(3);
    const a = createImpulseResponse(8000, 0.2, 2, () => first.next());
    const b = createImpulseResponse(8000, 0.2, 2, () => second.next());
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('survives a degenerate length instead of producing nothing', () => {
    const impulse = createImpulseResponse(1, 0.0001);
    expect(impulse.length).toBeGreaterThanOrEqual(1);
  });
});
