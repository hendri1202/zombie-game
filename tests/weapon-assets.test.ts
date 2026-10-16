import { describe, expect, it } from 'vitest';
import { WEAPONS, type WeaponId } from '../src/app/gameConfig';
import { HANDS_PLACEMENT } from '../src/player/proceduralArms';

/**
 * Every weapon the config names must have a real, loadable model behind it.
 *
 * A typo in a `modelPath` is invisible in unit tests — the runtime logs it as a load
 * failure and carries on with no view model — so the files are read here and their glTF
 * structure checked. The weapons extracted from the survivor bundle are checked for their
 * embedded atlas too: a file that lost its texture renders plain white, which is the
 * failure this catches before a frame does.
 *
 * Files are read through Vite's raw glob rather than `node:fs`, keeping the test on the
 * same `vite/client` types the rest of the suite uses.
 */
const WEAPON_FILES = import.meta.glob('/public/assets/weapons/*.gltf', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

interface Gltf {
  asset?: { version?: string };
  meshes?: Array<{ primitives?: Array<{ attributes?: Record<string, number>; material?: number }> }>;
  accessors?: Array<{ bufferView?: number; count?: number }>;
  bufferViews?: Array<{ byteLength?: number }>;
  materials?: Array<{ pbrMetallicRoughness?: { baseColorTexture?: { index?: number } } }>;
  textures?: Array<{ source?: number }>;
  images?: Array<{ bufferView?: number }>;
}

function findFile(modelPath: string): { key: string; text: string } | null {
  const name = modelPath.split('/').pop() ?? '';
  const key = Object.keys(WEAPON_FILES).find((candidate) => candidate.endsWith(`/${name}`));
  return key ? { key, text: WEAPON_FILES[key] } : null;
}

describe('weapon models', () => {
  it('ships a glTF file for every weapon in the config', () => {
    for (const id of Object.keys(WEAPONS) as WeaponId[]) {
      const modelPath = WEAPONS[id].modelPath;
      expect(modelPath, id).toMatch(/^\/assets\/weapons\/[A-Za-z0-9_]+\.gltf$/);
      const file = findFile(modelPath);
      expect(file, `${id} -> ${modelPath} is missing`).not.toBeNull();
      if (!file) continue;

      const gltf = JSON.parse(file.text) as Gltf;
      expect(gltf.asset?.version, id).toBe('2.0');
      expect(gltf.meshes?.length ?? 0, id).toBeGreaterThan(0);
      const primitive = gltf.meshes?.[0]?.primitives?.[0];
      expect(primitive?.attributes?.POSITION, id).toBeTypeOf('number');

      // Every accessor must resolve to a buffer view that actually has bytes, or the
      // loader produces an empty mesh and nothing renders.
      const position = gltf.accessors?.[primitive?.attributes?.POSITION ?? 0];
      const view = gltf.bufferViews?.[position?.bufferView ?? 0];
      expect((view?.byteLength ?? 0) > 0, id).toBe(true);
      expect(position?.count ?? 0, id).toBeGreaterThan(0);
    }
  });

  it('keeps the texture atlas with the weapons extracted from the survivor bundle', () => {
    // These came out of a character file, where the atlas is one embedded image shared by
    // every part. Extracting the mesh without it gives a white model, which is easy to
    // ship and easy to miss.
    for (const id of Object.keys(WEAPONS) as WeaponId[]) {
      const file = findFile(WEAPONS[id].modelPath);
      if (!file) continue;
      const gltf = JSON.parse(file.text) as Gltf;
      const base = gltf.materials?.[0]?.pbrMetallicRoughness?.baseColorTexture;
      if (!base) continue;
      expect(base.index, id).toBe(0);
      const texture = gltf.textures?.[0];
      expect(texture?.source, id).toBe(0);
      expect(gltf.images?.[0]?.bufferView, id).toBeTypeOf('number');
    }
  });

  it('declares the per-weapon settings the runtime reads', () => {
    for (const id of Object.keys(WEAPONS) as WeaponId[]) {
      const weapon = WEAPONS[id];
      expect(weapon.magazineSize, id).toBeGreaterThan(0);
      expect(weapon.maxReserve, id).toBeGreaterThanOrEqual(weapon.startingReserve);
      expect(weapon.tracerEvery, id).toBeGreaterThanOrEqual(1);
      expect(weapon.fireRate, id).toBeGreaterThan(0);
      expect(weapon.muzzleFlashSeconds, id).toBeGreaterThan(0);
      // The hands have a pose for each grip kind, and one must be declared.
      expect(HANDS_PLACEMENT[weapon.grip], id).toBeTruthy();
      expect([1, 2], id).toContain(weapon.slot);
    }
  });

  it('gives each weapon its own view model placement', () => {
    const placements = new Set<string>();
    for (const id of Object.keys(WEAPONS) as WeaponId[]) {
      const position = WEAPONS[id].viewModel.position;
      expect(position.every((value) => Number.isFinite(value)), id).toBe(true);
      // Two weapons sharing a placement would render inside each other when swapped.
      expect(placements.has(position.join(',')), id).toBe(false);
      placements.add(position.join(','));
    }
  });
});
