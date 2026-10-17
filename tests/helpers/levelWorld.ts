/**
 * Test harness for the city block's collision geometry.
 *
 * The production level is built from real GLTF assets, and the sizes of those
 * assets decide where a prop's collision box lands. Tests cannot load the models
 * (no WebGL, no DOM), but they can read the *exact* bounding boxes the loader
 * computes: every glTF here stores its buffers inline and its accessors carry
 * `min`/`max`, so walking the node hierarchy over those corners reproduces
 * `Box3.setFromObject` on the real model.
 *
 * Those bounds are then handed to the real `PropLibrary`, so normalisation,
 * scaling and the footprint maths under test are the shipped code rather than a
 * second implementation that can drift from it.
 */
import { Box3, BoxGeometry, Group, Matrix4, Mesh, Quaternion, Vector3 } from 'three';
import type { AssetManager, LoadedModel } from '../../src/core/AssetManager';
import { CollisionWorld } from '../../src/level/CollisionWorld';
import {
  addGlassPanes, generateBuildings, perimeterWallSpecs, PROP_LAYOUT, PROP_SPECS,
  propCollisionFootprint, PERIMETER_WALL_HEIGHT,
} from '../../src/level/CityLevel';
import { PropLibrary, type PropSpec } from '../../src/level/PropLibrary';
import { WORLD } from '../../src/app/gameConfig';
import { NavigationGrid } from '../../src/zombies/NavigationGrid';

// Read through Vite's raw glob, the way the other asset tests here do: it keeps the suite on
// `vite/client` types (there is no @types/node in this project) and still measures the real
// shipped GLTF files rather than a table someone typed out by hand.
const PROP_FILES = {
  ...import.meta.glob('/public/assets/environment/*.gltf', { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob('/public/assets/vehicles/*.gltf', { query: '?raw', import: 'default', eager: true }),
} as Record<string, string>;

/** Raw glTF text for a public asset URL such as `/assets/environment/Couch.gltf`. */
function rawAsset(url: string): string {
  const file = PROP_FILES[`/public${url}`];
  if (!file) throw new Error(`no shipped asset for ${url}`);
  return file;
}

interface GltfJson {
  scene?: number;
  scenes: Array<{ nodes: number[] }>;
  nodes: Array<{
    mesh?: number;
    children?: number[];
    matrix?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
  }>;
  meshes: Array<{ primitives: Array<{ attributes: { POSITION: number } }> }>;
  accessors: Array<{ min?: number[]; max?: number[] }>;
}

const boundsCache = new Map<string, Box3>();

/** World-space bounds of a glTF file, node transforms included. */
export function gltfBounds(spec: PropSpec): Box3 {
  const cached = boundsCache.get(spec.path);
  if (cached) return cached.clone();
  const json = JSON.parse(rawAsset(spec.path)) as GltfJson;
  const box = new Box3();
  const corner = new Vector3();

  const walk = (index: number, parent: Matrix4): void => {
    const node = json.nodes[index];
    const local = new Matrix4();
    if (node.matrix) local.fromArray(node.matrix);
    else {
      local.compose(
        new Vector3().fromArray(node.translation ?? [0, 0, 0]),
        new Quaternion().fromArray(node.rotation ?? [0, 0, 0, 1]),
        new Vector3().fromArray(node.scale ?? [1, 1, 1]),
      );
    }
    const world = parent.clone().multiply(local);
    if (node.mesh !== undefined) {
      for (const primitive of json.meshes[node.mesh].primitives) {
        const accessor = json.accessors[primitive.attributes.POSITION];
        if (!accessor.min || !accessor.max) continue;
        for (let cornerIndex = 0; cornerIndex < 8; cornerIndex += 1) {
          corner.set(
            cornerIndex & 1 ? accessor.max[0] : accessor.min[0],
            cornerIndex & 2 ? accessor.max[1] : accessor.min[1],
            cornerIndex & 4 ? accessor.max[2] : accessor.min[2],
          ).applyMatrix4(world);
          box.expandByPoint(corner);
        }
      }
    }
    for (const child of node.children ?? []) walk(child, world);
  };

  for (const root of json.scenes[json.scene ?? 0].nodes) walk(root, new Matrix4());
  boundsCache.set(spec.path, box.clone());
  return box;
}

/**
 * A stand-in for the loaded model: one box mesh exactly as large as the real
 * asset's bounds, so `PropLibrary`'s normalisation sees the true dimensions.
 */
function propModel(spec: PropSpec, bounds: Box3): Group {
  const size = bounds.getSize(new Vector3());
  const center = bounds.getCenter(new Vector3());
  const mesh = new Mesh(new BoxGeometry(size.x, size.y, size.z));
  mesh.position.set(center.x, center.y, center.z);
  const group = new Group();
  group.name = spec.name;
  group.add(mesh);
  return group;
}

/** AssetManager stand-in that answers with real-asset-sized boxes. */
export function fakeAssets(): AssetManager {
  const specs = new Map(PROP_SPECS.map((spec) => [spec.path, spec]));
  return {
    loadModel: async (url: string): Promise<LoadedModel> => {
      const spec = specs.get(url);
      if (!spec) throw new Error(`no such prop: ${url}`);
      return { scene: propModel(spec, gltfBounds(spec)), animations: [], url };
    },
    failures: [],
    onProgress: null,
    totalRequested: specs.size,
    loadedCount: 0,
  } as unknown as AssetManager;
}

export interface LevelWorld {
  collision: CollisionWorld;
  grid: NavigationGrid;
  props: PropLibrary;
}

/**
 * The collision world and navigation grid of the shipped block, built from the
 * real layout, the real prop sizes, the real building generator, the real
 * perimeter and the real glass panes.
 */
export async function buildLevelWorld(): Promise<LevelWorld> {
  const props = new PropLibrary(fakeAssets());
  await props.load(PROP_SPECS);
  const collision = new CollisionWorld({ ...WORLD.playArea });

  for (const placement of PROP_LAYOUT) {
    const spec = PROP_SPECS.find((entry) => entry.name === placement.prop);
    const template = props.get(placement.prop);
    if (!spec?.solid || !template) continue;
    const footprint = propCollisionFootprint(placement.rotationY ?? 0, template.size);
    collision.addCenteredBox(
      placement.x, placement.z, footprint.width, footprint.depth, template.size.height,
      `prop:${placement.prop}`, { blocksPlayer: true, blocksZombies: true },
    );
  }

  for (const building of generateBuildings()) {
    collision.addCenteredBox(
      building.x, building.z, building.width, building.depth, building.height, 'building',
      { blocksPlayer: true, blocksZombies: true },
    );
  }

  for (const [x, z, width, depth] of perimeterWallSpecs(WORLD.playArea)) {
    collision.addCenteredBox(x, z, width, depth, PERIMETER_WALL_HEIGHT, 'perimeter', {
      blocksPlayer: true, blocksZombies: true,
    });
  }

  addGlassPanes(new Group(), collision, false);

  const grid = new NavigationGrid({ ...WORLD.playArea });
  grid.rebuild(collision, 0.45);
  return { collision, grid, props };
}

/**
 * Walks a body of the given radius along a list of waypoints, pushed out of geometry every
 * step, and reports where it stopped if it stopped short.
 *
 * This is the harness's stand-in for a player holding the movement key: it uses the same
 * `resolveCircle` the player controller calls, so "the route is unbroken" is measured
 * against the collision world the game actually runs rather than assumed from the grid.
 */
export function walkRoute(
  collision: CollisionWorld,
  waypoints: Array<{ x: number; z: number }>,
  radius: number,
  step = 0.1,
): { reached: boolean; stalledAt: { x: number; z: number } | null; steps: number } {
  if (waypoints.length === 0) return { reached: false, stalledAt: null, steps: 0 };
  const position = new Vector3(waypoints[0].x, 0, waypoints[0].z);
  let steps = 0;
  for (let i = 1; i < waypoints.length; i += 1) {
    const target = waypoints[i];
    let stalled = 0;
    for (;;) {
      steps += 1;
      if (steps > 40000) return { reached: false, stalledAt: { x: position.x, z: position.z }, steps };
      const dx = target.x - position.x;
      const dz = target.z - position.z;
      const distance = Math.hypot(dx, dz);
      if (distance < 0.35) break;
      position.x += (dx / distance) * step;
      position.z += (dz / distance) * step;
      collision.resolveCircle(position, radius);
      const after = Math.hypot(target.x - position.x, target.z - position.z);
      if (after >= distance - 1e-4) {
        stalled += 1;
        if (stalled > 12) return { reached: false, stalledAt: { x: position.x, z: position.z }, steps };
      } else stalled = 0;
    }
  }
  return { reached: true, stalledAt: null, steps };
}

/** Rectangles used by the level tests, with a couple of measurement helpers. */
export interface Rect { minX: number; maxX: number; minZ: number; maxZ: number }

/** How much two rectangles overlap on each axis; `overlaps` is true only for a real overlap. */
export function rectOverlap(a: Rect, b: Rect): { overlapX: number; overlapZ: number; overlaps: boolean } {
  const overlapX = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const overlapZ = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
  return { overlapX, overlapZ, overlaps: overlapX > 0 && overlapZ > 0 };
}

/** Every collision box carrying the given tag prefix, as plain rectangles. */
export function boxesWithTag(collision: CollisionWorld, prefix: string): Array<Rect & { tag: string }> {
  return collision.boxes
    .filter((box) => box.tag.startsWith(prefix))
    .map((box) => ({ tag: box.tag, minX: box.minX, maxX: box.maxX, minZ: box.minZ, maxZ: box.maxZ }));
}
