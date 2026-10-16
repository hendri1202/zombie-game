import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Scene, Vector3 } from 'three';
import {
  MuzzleFlash, SMOKE_LIFE, createFlashTexture, createSmokeTexture,
} from '../src/systems/MuzzleFlash';
import { Tracers, createTracerTexture, tracerBasis } from '../src/systems/Tracers';
import { SeededRandom } from '../src/utils/math';

function flashRig(budget = 8) {
  const scene = new Scene();
  const camera = new PerspectiveCamera(70, 16 / 9, 0.1, 200);
  camera.position.set(0, 1.6, 0);
  camera.updateMatrixWorld(true);
  const system = new MuzzleFlash({ scene, camera, budget, random: new SeededRandom(7) });
  return { scene, camera, system };
}

function tracerRig(budget = 8) {
  const scene = new Scene();
  const camera = new PerspectiveCamera(70, 16 / 9, 0.1, 200);
  camera.position.set(0, 1.6, 0);
  camera.updateMatrixWorld(true);
  const system = new Tracers({ scene, camera, budget });
  return { scene, camera, system };
}

const muzzle = new Vector3(0, 1.5, -0.5);
const forward = new Vector3(0, 0, -1);

describe('shot effect textures', () => {
  it('builds a flash texture with a hot core and darker corners', () => {
    const texture = createFlashTexture(32);
    expect(texture.image.width).toBe(32);
    const data = texture.image.data as Uint8Array;
    const centre = (16 * 32 + 16) * 4 + 3;
    const corner = 3;
    expect(data[centre]).toBeGreaterThan(200);
    expect(data[corner]).toBeLessThan(data[centre]);
    // Somewhere in the sheet there must be a fully transparent pixel, or the additive
    // quad would be a solid square.
    let transparent = 0;
    for (let index = 3; index < data.length; index += 4) if (data[index] === 0) transparent += 1;
    expect(transparent).toBeGreaterThan(0);
  });

  it('builds a smoke texture that fades to nothing at the edges', () => {
    const texture = createSmokeTexture(32);
    const data = texture.image.data as Uint8Array;
    expect(data[3]).toBe(0);
    const centre = (16 * 32 + 16) * 4 + 3;
    expect(data[centre]).toBeGreaterThan(120);
  });

  it('builds a tracer texture that fades at both ends and across its width', () => {
    const texture = createTracerTexture(32, 8);
    const data = texture.image.data as Uint8Array;
    const alpha = (x: number, y: number) => data[(y * 32 + x) * 4 + 3];
    const middle = alpha(16, 4);
    expect(middle).toBeGreaterThan(180);
    expect(alpha(0, 4)).toBeLessThan(middle);
    expect(alpha(31, 4)).toBeLessThan(middle);
    expect(alpha(16, 0)).toBeLessThan(middle);
  });
});

describe('muzzle flash', () => {
  it('spawns two quads, smoke and a light for one shot', () => {
    const { system, scene } = flashRig();
    system.spawn(muzzle, forward, 26, 0.055);
    expect(system.activeCount).toBe(2);
    expect(system.activeSmokeCount).toBeGreaterThanOrEqual(1);
    expect(system.spawnCount).toBe(1);
    const lights = scene.children.filter((child) => (child as { isPointLight?: boolean }).isPointLight);
    expect(lights).toHaveLength(1);
    system.dispose();
  });

  it('retires the flash before the smoke, and both before long', () => {
    const { system } = flashRig();
    system.spawn(muzzle, forward, 26, 0.055);
    system.update(0.06);
    // The flash is gone at its own life, while smoke is meant to outlive it: that
    // difference in timing is the whole point of the layer.
    expect(system.activeCount).toBe(0);
    expect(system.activeSmokeCount).toBeGreaterThan(0);
    system.update(SMOKE_LIFE[1] + 0.1);
    expect(system.activeSmokeCount).toBe(0);
    system.dispose();
  });

  it('does not leak when a thousand shots are fired', () => {
    const { system, scene } = flashRig(8);
    const group = scene.getObjectByName('muzzle-flash');
    expect(group).toBeTruthy();
    for (let shot = 0; shot < 1000; shot += 1) {
      system.spawn(muzzle, forward, 26, 0.055);
      system.update(0.02);
    }
    system.update(2);
    expect(system.activeCount).toBe(0);
    expect(system.activeSmokeCount).toBe(0);
    // Everything lives in the pool, and the scene graph holds nothing alive.
    expect(group?.children.length ?? 0).toBe(0);
    expect(system.spawnCount).toBe(1000);
    system.dispose();
  });

  it('clears back to nothing, as a run restart needs', () => {
    const { system } = flashRig();
    system.spawn(muzzle, forward, 26, 0.055);
    system.clear();
    expect(system.activeCount).toBe(0);
    expect(system.activeSmokeCount).toBe(0);
    expect(system.spawnCount).toBe(0);
    system.dispose();
  });
});

describe('tracers', () => {
  it('stretches one quad from the muzzle to where the shot landed', () => {
    const { system, scene } = tracerRig();
    const from = new Vector3(0, 1.5, 0);
    const to = new Vector3(0, 1.5, -12);
    system.spawn(from, to, 0.03, 0.07);
    expect(system.activeCount).toBe(1);
    // Read the live mesh off the scene graph rather than adding a test-only accessor.
    const mesh = scene.getObjectByName('tracers')?.children[0];
    if (mesh) {
      // Midpoint, and scaled to the shot length along its own axis.
      expect(mesh.position.z).toBeCloseTo(-6, 5);
      expect(mesh.scale.x).toBeCloseTo(12, 5);
    }
    system.update(0.08);
    expect(system.activeCount).toBe(0);
    system.dispose();
  });

  it('ignores a degenerate shot rather than drawing a zero-length quad', () => {
    const { system } = tracerRig();
    system.spawn(new Vector3(0, 1, 0), new Vector3(0, 1, 0), 0.03, 0.07);
    expect(system.activeCount).toBe(0);
    expect(system.spawnCount).toBe(0);
    system.dispose();
  });

  it('keeps its quad facing the camera even when the camera is on the shot line', () => {
    // Camera sitting exactly on the shot axis: the projected view vector is degenerate,
    // and a naive cross product would return a zero basis and an invisible tracer.
    const basis = tracerBasis([0, 1, 0], [0, 1, -10], [0, 1, 5]);
    expect(basis).not.toBeNull();
    if (basis) {
      const normalLength = Math.hypot(...basis.normal);
      expect(normalLength).toBeCloseTo(1, 5);
      expect(Math.abs(basis.normal[2])).toBeLessThan(1e-6);
    }
  });

  it('does not leak when a thousand tracers are drawn', () => {
    const { system, scene } = tracerRig(8);
    const group = scene.getObjectByName('tracers');
    for (let shot = 0; shot < 1000; shot += 1) {
      system.spawn(new Vector3(0, 1.5, 0), new Vector3(0, 1.5, -20), 0.03, 0.07);
      system.update(0.02);
    }
    system.update(1);
    expect(system.activeCount).toBe(0);
    expect(group?.children.length ?? 0).toBe(0);
    system.dispose();
  });
});
