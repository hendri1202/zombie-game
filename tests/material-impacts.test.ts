import { describe, expect, it } from 'vitest';
import { Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, Vector3 } from 'three';
import { CAMERA_NUDGE, ImpactEffects } from '../src/systems/ImpactEffects';
import { MATERIAL_IMPACTS, materialForTag, type MaterialKind } from '../src/app/gameConfig';
import { SeededRandom } from '../src/utils/math';

/**
 * F5 — per-material impacts.
 *
 * The collision world already labels every box it hands back (`RaycastHit.tag`) and the
 * label already reaches the game on `combat:world-hit`. These tests hold the effect to
 * that promise: a car, a wall, a crate and a window throw measurably different sparks,
 * an unrecognised tag still throws dust, every spark is nudged off the surface towards
 * the camera, and the effect survives the `low` preset (the particle budget may cap it
 * but not switch it off).
 *
 * There is no browser here — the harness's GPU pixel-diff cannot run in this cgroup — so
 * "is it rendered" is proved by rasterising the live spark quads through the real camera
 * on the CPU (the same triangle-fill approach `view-model-framing.test.ts` uses) and
 * diffing two luminance grids: with the effect and without it. That answers "does the
 * effect reach the frame", not "did the GPU blend it", which is what the browser gate is
 * for.
 */

/** One representative existing tag per material. The city block writes exactly these shapes. */
const TAGS: Record<Exclude<MaterialKind, 'default'>, string> = {
  metal: 'prop:containerRed',
  concrete: 'building',
  wood: 'prop:pallet',
  // The block's coded glass panes carry this tag (see `CityLevel.GLASS_TAG`), so it
  // is the glass tag in play, not a placeholder the classifier merely tolerates.
  glass: 'prop:window',
};

const HIT = new Vector3(0, 1.5, -4);
const EYE = new Vector3(0, 1.6, 1);

function rig(budget = 48) {
  const scene = new Scene();
  const camera = new PerspectiveCamera(76, 16 / 9, 0.1, 200);
  camera.position.copy(EYE);
  camera.updateMatrixWorld(true);
  const system = new ImpactEffects({ scene, budget, random: new SeededRandom(7) });
  return { scene, camera, system };
}

function impactMeshes(scene: Scene): Mesh[] {
  return (scene.getObjectByName('impact-effects')?.children ?? []) as Mesh[];
}

const RASTER_WIDTH = 640;
const RASTER_HEIGHT = 360;
const GRID_CELLS = 8;

/**
 * Filament counts the live spark quads into a coarse luminance grid, exactly as the
 * camera would draw them. Triangles are filled with a bounding-box prefilter; there is no
 * depth buffer, so two overlapping sparks both count — this is a floor on what a real
 * frame shows, which is the honest direction to err for a "is anything drawn" check.
 */
function luminanceGrid(scene: Scene, camera: PerspectiveCamera): { grid: number[]; lit: number } {
  scene.updateMatrixWorld(true);
  const width = RASTER_WIDTH;
  const height = RASTER_HEIGHT;
  const luminance = new Float32Array(width * height);
  const covered = new Uint8Array(width * height);
  const vertex = new Vector3();
  const triangle = [new Vector3(), new Vector3(), new Vector3()];

  for (const mesh of impactMeshes(scene)) {
    const material = mesh.material as MeshBasicMaterial;
    const brightness = (0.299 * material.color.r + 0.587 * material.color.g + 0.114 * material.color.b) * 255;
    const position = mesh.geometry.attributes.position;
    const index = mesh.geometry.index;
    const count = index ? index.count : position.count;
    for (let i = 0; i < count; i += 3) {
      let clipped = false;
      for (let k = 0; k < 3; k += 1) {
        const at = index ? index.getX(i + k) : i + k;
        vertex.fromBufferAttribute(position, at).applyMatrix4(mesh.matrixWorld).project(camera);
        triangle[k].copy(vertex);
        if (Math.abs(vertex.z) > 1) clipped = true;
      }
      if (clipped) continue;
      const [[ax, ay], [bx, by], [cx, cy]] =
        triangle.map((p) => [(p.x + 1) / 2 * width, (1 - p.y) / 2 * height]);
      const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      if (Math.abs(area) < 1e-9) continue;
      const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
      const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
      const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
      const maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          const px = x + 0.5;
          const py = y + 0.5;
          const w0 = ((bx - ax) * (py - ay) - (px - ax) * (by - ay)) / area;
          const w1 = ((px - ax) * (cy - ay) - (cx - ax) * (py - ay)) / area;
          if (w0 < 0 || w1 < 0 || w0 + w1 > 1) continue;
          const at = y * width + x;
          covered[at] = 1;
          if (brightness > luminance[at]) luminance[at] = brightness;
        }
      }
    }
  }

  const grid = new Array<number>(GRID_CELLS * GRID_CELLS).fill(0);
  const counts = new Array<number>(GRID_CELLS * GRID_CELLS).fill(0);
  let lit = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * width + x;
      const cell = Math.min(GRID_CELLS - 1, Math.floor((y / height) * GRID_CELLS)) * GRID_CELLS
        + Math.min(GRID_CELLS - 1, Math.floor((x / width) * GRID_CELLS));
      grid[cell] += luminance[at];
      counts[cell] += 1;
      if (covered[at]) lit += 1;
    }
  }
  return { grid: grid.map((sum, i) => (counts[i] > 0 ? sum / counts[i] : 0)), lit };
}

describe('the collision tag picks the material', () => {
  it('reads the four materials off tags the level actually writes', () => {
    // Every tag here is one CityLevel writes (building / perimeter / prop:<name>), so this
    // is the mapping the shipped block exercises, not a made-up one.
    const cases: Array<[string, MaterialKind]> = [
      ['prop:containerRed', 'metal'],
      ['prop:containerGreen', 'metal'],
      ['prop:barrel', 'metal'],
      ['prop:fireHydrant', 'metal'],
      ['prop:pickup', 'metal'],
      ['prop:pickupArmored', 'metal'],
      ['prop:sports', 'metal'],
      ['prop:truckArmored', 'metal'],
      ['prop:wheelsStack', 'metal'],
      ['prop:pipes', 'metal'],
      ['prop:trafficBarrier1', 'metal'],
      ['prop:trafficLight1', 'metal'],
      ['prop:streetLights', 'metal'],
      ['prop:townSign', 'metal'],
      ['prop:waterTower', 'metal'],
      ['building', 'concrete'],
      ['perimeter', 'concrete'],
      ['prop:cinderBlock', 'concrete'],
      ['prop:couch', 'wood'],
      ['prop:chest', 'wood'],
      ['prop:pallet', 'wood'],
      ['prop:palletBroken', 'wood'],
      // The block's glass panes carry this tag; the classifier resolves it to glass.
      ['prop:window', 'glass'],
      ['glass', 'glass'],
      ['prop:windshield', 'glass'],
    ];
    for (const [tag, material] of cases) expect(materialForTag(tag), tag).toBe(material);
  });

  it('gives an unrecognised tag a defined default rather than nothing', () => {
    // Plastic, rubber, a grenade's own point and a name nobody wrote must all be safe:
    // they can never crash and they can never silently draw no effect.
    for (const tag of ['prop:trashBag1', 'prop:trafficCone1', 'prop:plasticBarrier', 'grenade', '', 'prop:teleporter']) {
      expect(materialForTag(tag), tag).toBe('default');
    }
  });

  it('gives the four materials four measurably different profiles', () => {
    const kinds: MaterialKind[] = ['metal', 'concrete', 'wood', 'glass'];
    const profiles = kinds.map((kind) => MATERIAL_IMPACTS[kind]);
    // Colour, particle count and size each have to be distinct, or two materials would
    // look the same no matter what the table says.
    expect(new Set(profiles.map((p) => p.color)).size).toBe(kinds.length);
    expect(new Set(profiles.map((p) => p.particles)).size).toBe(kinds.length);
    expect(new Set(profiles.map((p) => p.size)).size).toBe(kinds.length);
    expect(new Set(profiles.map((p) => p.spread)).size).toBe(kinds.length);
    // The default is its own thing, not a copy of one of the four.
    expect(profiles.map((p) => p.particles)).not.toContain(MATERIAL_IMPACTS.default.particles);
  });
});

describe('one hit throws that material\'s sparks', () => {
  it('spawns the profile\'s particle count, different per material', () => {
    const counts = new Map<MaterialKind, number>();
    for (const kind of ['metal', 'concrete', 'wood', 'glass'] as const) {
      const { scene, system } = rig();
      system.spawn(HIT.x, HIT.y, HIT.z, 0, TAGS[kind]);
      counts.set(kind, system.activeCount);
      // The live material must be the profile's, by colour.
      const mesh = impactMeshes(scene)[0];
      expect((mesh.material as MeshBasicMaterial).color.getHex(), kind).toBe(MATERIAL_IMPACTS[kind].color);
      system.dispose();
    }
    expect(counts.get('metal')).toBe(MATERIAL_IMPACTS.metal.particles);
    expect(counts.get('concrete')).toBe(MATERIAL_IMPACTS.concrete.particles);
    expect(counts.get('wood')).toBe(MATERIAL_IMPACTS.wood.particles);
    expect(counts.get('glass')).toBe(MATERIAL_IMPACTS.glass.particles);
    expect(new Set(counts.values()).size).toBe(4);
  });

  it('routes an unknown tag to the default dust', () => {
    const { system } = rig();
    system.spawn(HIT.x, HIT.y, HIT.z, 0, 'prop:teleporter');
    expect(system.activeCount).toBe(MATERIAL_IMPACTS.default.particles);
    system.dispose();
  });

  it('draws no blood flare for a body or head hit — that belongs to BloodEffects now', () => {
    // This system used to draw one static flare quad per body/head hit (kind 1 and 2).
    // Zombie hits now route to BloodEffects (see BloodEffects and Game.ts's `combat:hit`
    // handler), so ImpactEffects must draw nothing for those kinds. This test demands the
    // removed flare stays removed: if it ever lights a mesh here, the dead code grew back.
    const { system, scene } = rig();
    system.spawn(HIT.x, HIT.y, HIT.z, 1);
    expect(system.activeCount).toBe(0);
    system.spawn(HIT.x, HIT.y, HIT.z, 2);
    expect(system.activeCount).toBe(0);
    expect(impactMeshes(scene)).toHaveLength(0);
    system.dispose();
  });
});

describe('sparks are pulled off the surface towards the camera', () => {
  it('offsets a spark from the point it was born on by the camera nudge', () => {
    // Written against the legacy flare, which spawned exactly on the hit point. That flare
    // is gone, so the same exactness is measured on a surviving world spark: read the
    // spark's own (scattered) spawn point back, then assert the update moved it exactly
    // CAMERA_NUDGE towards the camera. Centred on the surface, half the quad is inside the
    // wall and the depth test eats it.
    const { system, scene, camera } = rig();
    system.spawn(HIT.x, HIT.y, HIT.z, 0, TAGS.metal);
    const mesh = impactMeshes(scene)[0];
    const born = mesh.position.clone();
    system.update(0.016, camera.position);
    const expected = born.clone().addScaledVector(camera.position.clone().sub(born).normalize(), CAMERA_NUDGE);
    expect(mesh.position.distanceTo(expected)).toBeLessThan(1e-6);
    // Moved towards the camera, not away from it.
    expect(mesh.position.clone().sub(born).dot(camera.position.clone().sub(born))).toBeGreaterThan(0);
    system.dispose();
  });

  it('nudges every world spark towards the camera, on average by the nudge', () => {
    // Jitter is symmetric about the hit point, so over many sparks its mean cancels and
    // what is left, measured along the surface-to-camera axis, is the nudge itself.
    const { scene, camera, system } = rig(4000);
    for (let i = 0; i < 300; i += 1) system.spawn(HIT.x, HIT.y, HIT.z, 0, TAGS.concrete);
    system.update(0.001, camera.position);
    const axis = camera.position.clone().sub(HIT).normalize();
    let total = 0;
    let count = 0;
    for (const mesh of impactMeshes(scene)) {
      total += mesh.position.clone().sub(HIT).dot(axis);
      count += 1;
    }
    expect(count).toBe(300 * MATERIAL_IMPACTS.concrete.particles);
    const mean = total / count;
    expect(mean).toBeGreaterThan(0.06);
    expect(mean).toBeLessThan(CAMERA_NUDGE + 0.02);
    system.dispose();
  });
});

describe('the effect is never gated by the particle budget', () => {
  it('still throws sparks when the preset gives a budget of zero (low)', () => {
    // The low preset sets particleBudget to 0. The escaped casing taught this project that
    // gating feedback on the budget makes the weapon look fake; a wall shot that leaves
    // nothing is the same failure, so the budget may cap the pool but never blank it.
    const { system, scene, camera } = rig(0);
    system.spawn(HIT.x, HIT.y, HIT.z, 0, TAGS.metal);
    expect(system.activeCount).toBe(MATERIAL_IMPACTS.metal.particles);
    system.update(0.001, camera.position);
    expect(luminanceGrid(scene, camera).lit).toBeGreaterThan(0);
    system.dispose();
  });

  it('caps the pool by recycling the oldest spark rather than dropping the newest', () => {
    // The budget is clamped up to a floor so it can cap the pool but never blank the
    // feedback (see the low-preset test above); 20 is above that floor on purpose.
    const { system } = rig(20);
    for (let i = 0; i < 4; i += 1) system.spawn(HIT.x, HIT.y, HIT.z, 0, TAGS.metal);
    // Four metal hits are 24 sparks against a cap of 20, so the four oldest are recycled.
    expect(system.activeCount).toBe(20);
    expect(system.enabled).toBe(true);
    system.dispose();
  });
});

describe('the sparks reach the frame, proved by a grid diff', () => {
  it('lights cells that an empty frame does not', () => {
    const { scene, camera, system } = rig();
    const before = luminanceGrid(scene, camera);
    expect(before.lit).toBe(0);

    system.spawn(HIT.x, HIT.y, HIT.z, 0, TAGS.metal);
    system.update(0.016, camera.position);
    const after = luminanceGrid(scene, camera);

    // "An object is in the scene graph" is a different claim from "it rendered": here the
    // quad is projected through the same camera the game uses, so a non-zero diff means
    // the spark genuinely lands in the frame. Mirrors the harness's two-grid diff.
    let changedCells = 0;
    let maxDiff = 0;
    for (let i = 0; i < after.grid.length; i += 1) {
      const diff = Math.abs(after.grid[i] - before.grid[i]);
      if (diff > 0) changedCells += 1;
      if (diff > maxDiff) maxDiff = diff;
    }
    expect(after.lit).toBeGreaterThan(0);
    expect(changedCells).toBeGreaterThan(0);
    expect(maxDiff).toBeGreaterThan(0);
    system.dispose();
  });

  it('covers measurably different screen area per material', () => {
    const lit = new Map<MaterialKind, number>();
    for (const kind of ['metal', 'concrete', 'wood', 'glass'] as const) {
      const { scene, camera, system } = rig();
      system.spawn(HIT.x, HIT.y, HIT.z, 0, TAGS[kind]);
      system.update(0.001, camera.position);
      lit.set(kind, luminanceGrid(scene, camera).lit);
      system.dispose();
    }
    for (const [kind, pixels] of lit) expect(pixels, kind).toBeGreaterThan(0);
    // Concrete throws fewer but far larger puffs than metal's small sparks; if that ever
    // stopped being true the "four different materials" claim would be empty.
    expect(lit.get('concrete') as number).toBeGreaterThan(lit.get('metal') as number);
    expect(new Set(lit.values()).size).toBeGreaterThan(1);
  });
});
