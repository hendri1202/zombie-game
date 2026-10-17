import { describe, expect, it } from 'vitest';
import { Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, Vector3 } from 'three';
import {
  BLOOD_DECAL_CAP, BLOOD_DROP_CAP, BLOOD_KILL_SCALE, BLOOD_NUDGE, BLOOD_ZONES,
  BloodEffects, createDropTexture, createSplatTexture,
} from '../src/systems/BloodEffects';
import { SeededRandom } from '../src/utils/math';

/**
 * F6 — blood.
 *
 * A landed blow throws two layers: a splat glued to the wound and a burst of droplets that
 * leave it. Both are chosen from the `zone` the `combat:hit` event already carries, so these
 * tests hold the effect to four promises:
 *
 * 1. a headshot is measurably bigger and brighter than a body hit, and a killing blow is
 *    bigger than either — measured, not asserted from the table alone;
 * 2. every quad is pulled `BLOOD_NUDGE` off the wound towards the camera, so the depth test
 *    can never eat it (the lesson the sparks already learned);
 * 3. the particle budget never gates it — the `low` preset sets `particleBudget` to 0 and
 *    blood must still draw;
 * 4. the pools are bounded, recycle the *oldest*, and `dispose` frees what they own.
 *
 * There is no browser here — the harness's GPU pixel-diff cannot run in this cgroup — so "is
 * it on screen" is proved by rasterising the live blood quads through the real camera on the
 * CPU (the same triangle-fill approach material-impacts.test.ts uses) and diffing luminance
 * grids. That answers "does the effect reach the frame", not "did the GPU blend it", which is
 * what the browser gate is for.
 */

const HIT = new Vector3(0, 1.5, -4);
const EYE = new Vector3(0, 1.6, 1);

function rig(budget = 0) {
  const scene = new Scene();
  const camera = new PerspectiveCamera(76, 16 / 9, 0.1, 200);
  camera.position.copy(EYE);
  camera.updateMatrixWorld(true);
  // Budget 0 by default: that is exactly what the low preset passes, and blood must be
  // unaffected by it. See the "never gated" block.
  const system = new BloodEffects({ scene, random: new SeededRandom(11), budget });
  return { scene, camera, system };
}

function bloodMeshes(scene: Scene): Mesh[] {
  return (scene.getObjectByName('blood-effects')?.children ?? []) as Mesh[];
}

const DECAL_COLORS = new Set([BLOOD_ZONES.body.decalColor, BLOOD_ZONES.head.decalColor]);

function meshesOfColor(scene: Scene, color: number): Mesh[] {
  return bloodMeshes(scene).filter((mesh) => (mesh.material as MeshBasicMaterial).color.getHex() === color);
}

function decalsOfColor(scene: Scene, color: number): Mesh[] {
  return bloodMeshes(scene).filter(
    (mesh) => DECAL_COLORS.has((mesh.material as MeshBasicMaterial).color.getHex())
      && (mesh.material as MeshBasicMaterial).color.getHex() === color,
  );
}

/** The point the effect should be drawn at: the wound, pulled BLOOD_NUDGE towards the camera. */
function nudged(point: Vector3, camera: Vector3): Vector3 {
  return point.clone().addScaledVector(camera.clone().sub(point).normalize(), BLOOD_NUDGE);
}

const RASTER_WIDTH = 640;
const RASTER_HEIGHT = 360;
const GRID_CELLS = 8;

/**
 * Filament counts the live blood quads into a coarse luminance grid, exactly as the camera
 * would draw them. Triangles are filled with a bounding-box prefilter; there is no depth
 * buffer, so two overlapping quads both count — a floor on what a real frame shows, which is
 * the honest direction to err for a "is anything drawn" check.
 */
function luminanceGrid(scene: Scene, camera: PerspectiveCamera): { grid: number[]; lit: number } {
  scene.updateMatrixWorld(true);
  const width = RASTER_WIDTH;
  const height = RASTER_HEIGHT;
  const luminance = new Float32Array(width * height);
  const covered = new Uint8Array(width * height);
  const vertex = new Vector3();
  const triangle = [new Vector3(), new Vector3(), new Vector3()];

  for (const mesh of bloodMeshes(scene)) {
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

describe('blood textures are built from code, with no DOM', () => {
  it('builds a droplet speck that is soft at the edge and solid at the centre', () => {
    const texture = createDropTexture(32);
    expect(texture.image.width).toBe(32);
    const data = texture.image.data as Uint8Array;
    // Corner fully transparent, or the quad would be a square.
    expect(data[3]).toBe(0);
    const centre = (16 * 32 + 16) * 4 + 3;
    expect(data[centre]).toBeGreaterThan(200);
  });

  it('builds a splat whose droplets spread past its core', () => {
    const texture = createSplatTexture(32);
    const data = texture.image.data as Uint8Array;
    const centre = (15.5);
    let solidCore = 0;
    let outsideCore = 0;
    for (let y = 0; y < 32; y += 1) {
      for (let x = 0; x < 32; x += 1) {
        const alpha = data[(y * 32 + x) * 4 + 3];
        if (alpha === 0) continue;
        const radius = Math.hypot((x - centre) / centre, (y - centre) / centre);
        if (radius < 0.3) solidCore += 1;
        // Beyond the 0.52 core radius: only the satellite blobs can reach out here, so a
        // non-zero count is what separates a spreading splat from one soft disc.
        if (radius > 0.6) outsideCore += 1;
      }
    }
    expect(solidCore).toBeGreaterThan(0);
    expect(outsideCore).toBeGreaterThan(0);
  });
});

describe('the zone the hit already carries picks the blood', () => {
  it('makes head and body profiles measurably different', () => {
    const head = BLOOD_ZONES.head;
    const body = BLOOD_ZONES.body;
    // A headshot is not "a body hit but more": more droplets, each larger, brighter, in a
    // bigger and darker-splatted mark that stains for longer.
    expect(head.drops).toBeGreaterThan(body.drops);
    expect(head.dropSize).toBeGreaterThan(body.dropSize);
    expect(head.decalSize).toBeGreaterThan(body.decalSize);
    expect(head.dropSpeed).toBeGreaterThan(body.dropSpeed);
    expect(head.dropSeconds).toBeGreaterThan(body.dropSeconds);
    expect(head.decalSeconds).toBeGreaterThan(body.decalSeconds);
    expect(head.dropColor).not.toBe(body.dropColor);
    expect(head.decalColor).not.toBe(body.decalColor);
  });

  it('throws that many droplets and one splat per hit', () => {
    const { system } = rig();
    system.spawn(HIT.x, HIT.y, HIT.z, 'body');
    expect(system.activeDropCount).toBe(BLOOD_ZONES.body.drops);
    expect(system.activeDecalCount).toBe(1);
    system.spawn(HIT.x, HIT.y, HIT.z, 'head');
    expect(system.activeDropCount).toBe(BLOOD_ZONES.body.drops + BLOOD_ZONES.head.drops);
    expect(system.activeDecalCount).toBe(2);
    system.dispose();
  });

  it('paints the quads the zone\'s own colours', () => {
    const { scene, system } = rig();
    system.spawn(HIT.x, HIT.y, HIT.z, 'body');
    system.spawn(HIT.x, HIT.y, HIT.z, 'head');
    expect(meshesOfColor(scene, BLOOD_ZONES.body.dropColor)).toHaveLength(BLOOD_ZONES.body.drops);
    expect(meshesOfColor(scene, BLOOD_ZONES.head.dropColor)).toHaveLength(BLOOD_ZONES.head.drops);
    expect(meshesOfColor(scene, BLOOD_ZONES.body.decalColor)).toHaveLength(1);
    expect(meshesOfColor(scene, BLOOD_ZONES.head.decalColor)).toHaveLength(1);
    system.dispose();
  });

  it('covers measurably more screen for a headshot than for a body hit', () => {
    const bodyRig = rig();
    bodyRig.system.spawn(HIT.x, HIT.y, HIT.z, 'body');
    bodyRig.system.update(0.001, bodyRig.camera.position);
    const bodyLit = luminanceGrid(bodyRig.scene, bodyRig.camera).lit;
    bodyRig.system.dispose();

    const headRig = rig();
    headRig.system.spawn(HIT.x, HIT.y, HIT.z, 'head');
    headRig.system.update(0.001, headRig.camera.position);
    const headLit = luminanceGrid(headRig.scene, headRig.camera).lit;
    headRig.system.dispose();

    expect(bodyLit).toBeGreaterThan(0);
    expect(headLit).toBeGreaterThan(bodyLit);
  });
});

describe('a killing blow throws more blood than a wounding one', () => {
  it('throws the kill multiple of droplets and a bigger splat', () => {
    const { scene, system } = rig();
    system.spawn(HIT.x, HIT.y, HIT.z, 'body', false);
    const woundDrops = system.activeDropCount;
    system.spawn(HIT.x, HIT.y, HIT.z, 'body', true);
    const killDrops = system.activeDropCount - woundDrops;
    // Body is five droplets: the kill multiple must actually add some, and this is measured
    // rather than assumed from the constant.
    expect(killDrops).toBe(Math.round(BLOOD_ZONES.body.drops * BLOOD_KILL_SCALE));
    expect(killDrops).toBeGreaterThan(woundDrops);

    // First splat spawned is the wounding one, second the kill; the kill's is bigger.
    const splats = decalsOfColor(scene, BLOOD_ZONES.body.decalColor);
    expect(splats).toHaveLength(2);
    expect(splats[1].scale.x).toBeGreaterThan(splats[0].scale.x);
    system.dispose();
  });

  it('still respects the pool cap when a whole crowd is killed at once', () => {
    const { system } = rig();
    for (let i = 0; i < 20; i += 1) system.spawn(HIT.x, HIT.y, HIT.z, 'head', true);
    expect(system.activeDropCount).toBe(system.dropCapacity);
    expect(system.activeDecalCount).toBe(system.decalCapacity);
    system.dispose();
  });
});

describe('blood is pulled off the surface towards the camera', () => {
  it('nudges the splat off the wound by exactly BLOOD_NUDGE', () => {
    const { scene, camera, system } = rig();
    system.spawn(HIT.x, HIT.y, HIT.z, 'body');
    system.update(0.001, camera.position);
    const splat = decalsOfColor(scene, BLOOD_ZONES.body.decalColor)[0];
    // Centred on the wound, half the splat is inside the zombie and the depth test eats it.
    expect(splat.position.distanceTo(nudged(HIT, camera.position))).toBeLessThan(1e-6);
    expect(splat.position.z).toBeGreaterThan(HIT.z);
    system.dispose();
  });

  it('nudges every droplet clear of the wound too', () => {
    const { scene, camera, system } = rig();
    system.spawn(HIT.x, HIT.y, HIT.z, 'body');
    system.update(0.001, camera.position);
    const axis = camera.position.clone().sub(HIT).normalize();
    const meshes = bloodMeshes(scene);
    expect(meshes.length).toBeGreaterThan(0);
    for (const mesh of meshes) {
      // A tiny new-born burst moves at most a few millimetres in one millisecond, so a
      // positive component along the wound-to-camera axis can only be the nudge.
      expect(mesh.position.clone().sub(HIT).dot(axis)).toBeGreaterThan(BLOOD_NUDGE * 0.5);
    }
    system.dispose();
  });
});

describe('the effect is never gated by the particle budget', () => {
  it('draws full blood when the low preset gives a budget of zero', () => {
    // The low preset sets particleBudget to 0. Blood is the cue that says a blow connected,
    // so like the ejected casing it must survive: the budget may cap the pools, never blank
    // the effect. This system simply does not read it.
    const { scene, camera, system } = rig(0);
    expect(system.enabled).toBe(true);
    system.spawn(HIT.x, HIT.y, HIT.z, 'head', true);
    expect(system.activeDropCount).toBe(Math.round(BLOOD_ZONES.head.drops * BLOOD_KILL_SCALE));
    expect(system.activeDecalCount).toBe(1);
    expect(system.dropCapacity).toBeGreaterThanOrEqual(BLOOD_DROP_CAP);
    system.update(0.001, camera.position);
    expect(luminanceGrid(scene, camera).lit).toBeGreaterThan(0);
    system.dispose();
  });
});

describe('the pools are bounded and recycle the oldest', () => {
  it('caps droplets and splats, recycling rather than growing', () => {
    const { scene, camera, system } = rig();
    for (let i = 0; i < 40; i += 1) {
      system.spawn(HIT.x, HIT.y, HIT.z, 'head', true);
      system.update(0.001, camera.position);
    }
    expect(system.activeDropCount).toBe(system.dropCapacity);
    expect(system.activeDecalCount).toBe(system.decalCapacity);
    // Nothing leaked into the scene graph: every live quad is inside the two pools.
    expect(bloodMeshes(scene).length).toBe(system.dropCapacity + system.decalCapacity);
    system.dispose();
  });

  it('keeps the newest splat and recycles the oldest', () => {
    const { scene, camera, system } = rig();
    const old = new Vector3(0, 1.5, -6);
    system.spawn(old.x, old.y, old.z, 'body');
    system.update(0.001, camera.position);
    const oldPoint = nudged(old, camera.position);
    const atOld = (): boolean => decalsOfColor(scene, BLOOD_ZONES.body.decalColor)
      .some((mesh) => mesh.position.distanceTo(oldPoint) < 1e-3);
    expect(atOld()).toBe(true);

    const fresh = new Vector3(0, 1.5, -18);
    // One more than the cap: the oldest splat has to be the one recycled.
    for (let i = 0; i < BLOOD_DECAL_CAP + 1; i += 1) {
      system.spawn(fresh.x, fresh.y, fresh.z, 'body');
      system.update(0.001, camera.position);
    }
    expect(atOld()).toBe(false);
    const freshPoint = nudged(fresh, camera.position);
    expect(decalsOfColor(scene, BLOOD_ZONES.body.decalColor)
      .some((mesh) => mesh.position.distanceTo(freshPoint) < 1e-3)).toBe(true);
    system.dispose();
  });
});

describe('blood reaches the frame, proved by a grid diff', () => {
  it('lights cells an empty frame does not', () => {
    const { scene, camera, system } = rig();
    const before = luminanceGrid(scene, camera);
    expect(before.lit).toBe(0);

    system.spawn(HIT.x, HIT.y, HIT.z, 'head', true);
    system.update(0.016, camera.position);
    const after = luminanceGrid(scene, camera);

    // "An object is in the scene graph" is a different claim from "it rendered": here the
    // quad is projected through the same camera the game uses, so a non-zero diff means the
    // blood genuinely lands in the frame. Mirrors the harness's two-grid diff.
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
});

describe('blood does not leak', () => {
  it('stays bounded over a thousand hits and empties when the burst is over', () => {
    const { scene, camera, system } = rig();
    const group = scene.getObjectByName('blood-effects');
    expect(group).toBeTruthy();
    for (let hit = 0; hit < 1000; hit += 1) {
      system.spawn(HIT.x, HIT.y, HIT.z, hit % 2 === 0 ? 'head' : 'body', hit % 5 === 0);
      system.update(0.02, camera.position);
    }
    system.update(5, camera.position);
    expect(system.activeDropCount).toBe(0);
    expect(system.activeDecalCount).toBe(0);
    // Everything lives in the pool, and the scene graph holds nothing alive.
    expect(group?.children.length ?? -1).toBe(0);
    expect(system.hitCount).toBe(1000);
    system.dispose();
  });

  it('frees the materials and textures it owns and detaches from the scene', () => {
    const { scene, system } = rig();
    system.spawn(HIT.x, HIT.y, HIT.z, 'body');
    const group = scene.getObjectByName('blood-effects');
    const material = (group?.children[0] as Mesh).material as MeshBasicMaterial;
    // A per-quad material is what fades independently; dispose must free every one of them,
    // and there is at most one per pooled slot — never one per hit.
    let disposed = false;
    const original = material.dispose.bind(material);
    material.dispose = () => { disposed = true; original(); };

    system.dispose();
    expect(disposed).toBe(true);
    expect(scene.getObjectByName('blood-effects')).toBeUndefined();
    expect(group?.children.length ?? -1).toBe(0);
  });
});
