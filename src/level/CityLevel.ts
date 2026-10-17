import {
  BoxGeometry, DoubleSide, Group, Material, Mesh, MeshStandardMaterial, PlaneGeometry, PointLight, Scene,
  SphereGeometry, Texture,
} from 'three';
import { createLampPool } from '../engine/Lighting';
import { WORLD, type QualityPreset } from '../app/gameConfig';
import type { AssetManager } from '../core/AssetManager';
import { SeededRandom } from '../utils/math';
import { createDirtTexture, createFacadeTextures, createRoadTexture, createSidewalkTexture } from '../utils/textures';
import { CollisionWorld } from './CollisionWorld';
import { PropLibrary, type PropSpec } from './PropLibrary';
import { NavigationGrid } from '../zombies/NavigationGrid';

const ASSETS = {
  zombiesRoot: '/assets/characters/zombies/',
  environment: '/assets/environment/',
  vehicles: '/assets/vehicles/',
} as const;

/**
 * Prop catalogue. Every entry maps to a file that is actually shipped in
 * public/assets and actually placed by the layout below.
 */
export const PROP_SPECS: PropSpec[] = [
  // Containers / cover, waist-height and above: solid for both actors.
  { name: 'containerGreen', path: `${ASSETS.environment}Container_Green.gltf`, fit: 'height', targetSize: 2.6, solid: true },
  { name: 'containerRed', path: `${ASSETS.environment}Container_Red.gltf`, fit: 'height', targetSize: 2.6, solid: true },
  { name: 'barrel', path: `${ASSETS.environment}Barrel.gltf`, fit: 'height', targetSize: 1.0, solid: true },
  { name: 'fireHydrant', path: `${ASSETS.environment}FireHydrant.gltf`, fit: 'height', targetSize: 0.9, solid: true },
  { name: 'plasticBarrier', path: `${ASSETS.environment}PlasticBarrier.gltf`, fit: 'height', targetSize: 1.1, solid: true },
  { name: 'trafficBarrier1', path: `${ASSETS.environment}TrafficBarrier_1.gltf`, fit: 'height', targetSize: 1.0, solid: true },
  { name: 'trafficBarrier2', path: `${ASSETS.environment}TrafficBarrier_2.gltf`, fit: 'height', targetSize: 1.0, solid: true },
  { name: 'trafficLight1', path: `${ASSETS.environment}TrafficLight_1.gltf`, fit: 'height', targetSize: 5.6, solid: true },
  { name: 'trafficLight2', path: `${ASSETS.environment}TrafficLight_2.gltf`, fit: 'height', targetSize: 5.6, solid: true },
  { name: 'streetLights', path: `${ASSETS.environment}StreetLights.gltf`, fit: 'height', targetSize: 7.4, solid: true },
  { name: 'townSign', path: `${ASSETS.environment}TownSign.gltf`, fit: 'height', targetSize: 3.2, solid: true },
  { name: 'waterTower', path: `${ASSETS.environment}WaterTower.gltf`, fit: 'height', targetSize: 12, solid: true },
  { name: 'pipes', path: `${ASSETS.environment}Pipes.gltf`, fit: 'height', targetSize: 0.65, solid: true },
  { name: 'couch', path: `${ASSETS.environment}Couch.gltf`, fit: 'height', targetSize: 0.9, solid: true },
  { name: 'chest', path: `${ASSETS.environment}Chest.gltf`, fit: 'height', targetSize: 0.85, solid: true },
  { name: 'cinderBlock', path: `${ASSETS.environment}CinderBlock.gltf`, fit: 'height', targetSize: 0.45, solid: false },
  { name: 'pallet', path: `${ASSETS.environment}Pallet.gltf`, fit: 'height', targetSize: 0.16, solid: false },
  { name: 'palletBroken', path: `${ASSETS.environment}Pallet_Broken.gltf`, fit: 'height', targetSize: 0.16, solid: false },
  { name: 'trafficCone1', path: `${ASSETS.environment}TrafficCone_1.gltf`, fit: 'height', targetSize: 0.72, solid: false },
  { name: 'trafficCone2', path: `${ASSETS.environment}TrafficCone_2.gltf`, fit: 'height', targetSize: 0.72, solid: false },
  { name: 'trashBag1', path: `${ASSETS.environment}TrashBag_1.gltf`, fit: 'height', targetSize: 0.9, solid: false },
  { name: 'trashBag2', path: `${ASSETS.environment}TrashBag_2.gltf`, fit: 'height', targetSize: 0.9, solid: false },
  // Wrecks: the main mid-street cover.
  { name: 'pickup', path: `${ASSETS.vehicles}Vehicle_Pickup.gltf`, fit: 'height', targetSize: 1.85, solid: true },
  { name: 'pickupArmored', path: `${ASSETS.vehicles}Vehicle_Pickup_Armored.gltf`, fit: 'height', targetSize: 2.0, solid: true },
  { name: 'sports', path: `${ASSETS.vehicles}Vehicle_Sports.gltf`, fit: 'height', targetSize: 1.3, solid: true },
  { name: 'truck', path: `${ASSETS.vehicles}Vehicle_Truck.gltf`, fit: 'height', targetSize: 3.0, solid: true },
  { name: 'truckArmored', path: `${ASSETS.vehicles}Vehicle_Truck_Armored.gltf`, fit: 'height', targetSize: 3.2, solid: true },
  { name: 'wheelsStack', path: `${ASSETS.vehicles}Wheels_Stack.gltf`, fit: 'height', targetSize: 1.2, solid: true },
  // Road tiles, normalised to a 16 m footprint so they tile the street grid.
  { name: 'streetStraight', path: `${ASSETS.environment}Street_Straight.gltf`, fit: 'width', targetSize: 16, solid: false, castShadow: false },
  { name: 'streetStraightCrack1', path: `${ASSETS.environment}Street_Straight_Crack1.gltf`, fit: 'width', targetSize: 16, solid: false, castShadow: false },
  { name: 'streetStraightCrack2', path: `${ASSETS.environment}Street_Straight_Crack2.gltf`, fit: 'width', targetSize: 16, solid: false, castShadow: false },
  { name: 'street4Way', path: `${ASSETS.environment}Street_4Way.gltf`, fit: 'width', targetSize: 16, solid: false, castShadow: false },
];

export interface PropPlacement {
  prop: string;
  x: number;
  z: number;
  rotationY?: number;
  /** Relative chance the prop survives the quality filter; 1 = always placed. */
  importance?: number;
}

export interface BuildingPlacement {
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  seed: number;
}

export interface CityLevelDeps {
  scene: Scene;
  assets: AssetManager;
  quality: QualityPreset;
  navigation: NavigationGrid;
}

export interface CityLevelHandle {
  group: Group;
  collision: CollisionWorld;
  props: PropLibrary;
  /** Positions designed to be good zombie entry points at the edges of the block. */
  spawnHints: Array<{ x: number; z: number }>;
  dispose(): void;
}

export const ROAD_HALF_WIDTH = 8;
export const STREET_EXTENT = 64;

/** Deterministic prop layout so the level looks the same on every machine. */
export const PROP_LAYOUT: PropPlacement[] = [
  // Main street (along Z), abandoned vehicles and containment barriers.
  { prop: 'pickup', x: -4.2, z: 26, rotationY: 0.12 },
  { prop: 'pickupArmored', x: 4.4, z: 40, rotationY: 3.05 },
  { prop: 'sports', x: 5.1, z: -18, rotationY: 1.6 },
  { prop: 'truck', x: -4.8, z: -40, rotationY: 0.05 },
  { prop: 'truckArmored', x: 3.9, z: 54, rotationY: 3.1 },
  { prop: 'trafficBarrier1', x: -7.4, z: 12, rotationY: 0 },
  { prop: 'trafficBarrier2', x: -7.4, z: 13.6, rotationY: 0 },
  { prop: 'plasticBarrier', x: 7.2, z: -6, rotationY: 0.06 },
  { prop: 'plasticBarrier', x: 7.2, z: -4.4, rotationY: -0.04 },
  { prop: 'barrel', x: -8.9, z: 2.5, rotationY: 0 },
  { prop: 'barrel', x: -8.9, z: 3.6, rotationY: 0 },
  { prop: 'wheelsStack', x: 5.6, z: 8.5, rotationY: 0.4 },
  { prop: 'trafficCone1', x: 1.6, z: 18, rotationY: 0, importance: 0.6 },
  { prop: 'trafficCone2', x: 2.3, z: 17.2, rotationY: 0, importance: 0.6 },
  { prop: 'trashBag1', x: -9.6, z: -12, rotationY: 0, importance: 0.7 },
  { prop: 'trashBag2', x: -9.2, z: -12.9, rotationY: 0, importance: 0.7 },
  // Against the shopfront, not in the middle of the pavement: at 9.6 the couch sat with
  // 1.16 m of pavement on either side of it, which reads as furniture dumped in the road
  // and stops a player walking onto the kerb there (the pavement and the asphalt are the
  // same colour at night). Its near edge now stands 2.31 m clear of the roadway and leaves
  // 2.31 m of pavement to walk past on — a sofa someone left against the wall.
  { prop: 'couch', x: 10.75, z: 22, rotationY: 1.4 },
  // Same correction on the other side of the street: this chest was 0.73 m from the kerb
  // with 1.13 m of pavement behind it, so it blocked the walking line exactly as the couch
  // did. Now it stands against the building line.
  { prop: 'chest', x: -10.6, z: 34, rotationY: 0.5 },

  // Cross street (along X).
  { prop: 'containerGreen', x: -26, z: 5.4, rotationY: 0.02 },
  { prop: 'containerRed', x: -26, z: -5.4, rotationY: 0.03 },
  { prop: 'pickup', x: 22, z: 4.6, rotationY: 1.55 },
  { prop: 'trafficBarrier1', x: 34, z: -5.5, rotationY: Math.PI / 2 },
  { prop: 'trafficBarrier2', x: 35.5, z: -5.5, rotationY: Math.PI / 2 },

  // Block interiors: dead ends, loot corners and flanking routes.
  { prop: 'containerRed', x: -30, z: 30, rotationY: 0.6 },
  { prop: 'containerGreen', x: -34.5, z: 24, rotationY: -0.4 },
  { prop: 'truck', x: -22, z: -30, rotationY: 2.2 },
  { prop: 'pickupArmored', x: -33, z: -20, rotationY: 0.9 },
  { prop: 'waterTower', x: -48, z: 48, rotationY: 0.3 },
  { prop: 'waterTower', x: 48, z: -46, rotationY: 2.4 },
  { prop: 'streetLights', x: 16, z: 16.5, rotationY: Math.PI },
  { prop: 'streetLights', x: -16, z: -16.5, rotationY: 0 },
  { prop: 'streetLights', x: 16, z: -16.5, rotationY: Math.PI },
  { prop: 'trafficLight1', x: 9.4, z: 9.4, rotationY: Math.PI * 0.75 },
  { prop: 'trafficLight2', x: -9.4, z: -9.4, rotationY: Math.PI * 0.25 },
  { prop: 'townSign', x: -13, z: 30, rotationY: 0.2 },
  { prop: 'townSign', x: 30, z: 13.4, rotationY: -1.4 },
  { prop: 'pipes', x: 27, z: 26, rotationY: 0.5 },
  { prop: 'pipes', x: 28.4, z: 25.2, rotationY: 1.2 },
  { prop: 'fireHydrant', x: -10.4, z: 8.2, rotationY: 0 },
  { prop: 'fireHydrant', x: 10.4, z: -8.2, rotationY: 0 },
  { prop: 'pallet', x: 20, z: -24, rotationY: 0.3, importance: 0.5 },
  { prop: 'palletBroken', x: 21.4, z: -23.2, rotationY: 0.9, importance: 0.5 },
  { prop: 'cinderBlock', x: -19, z: 40, rotationY: 0, importance: 0.5 },
  { prop: 'cinderBlock', x: -18.4, z: 40.8, rotationY: 0, importance: 0.5 },
  { prop: 'trashBag2', x: 40, z: 20, rotationY: 0, importance: 0.6 },
];

/**
 * Axis-aligned footprint of a prop after its placement rotation, metres.
 *
 * Props are only ever turned by roughly a quarter turn in the layout, so the
 * bounding box swaps its axes once |sin(rotationY)| passes the diagonal. Kept in
 * one place because the collision box the player walks into and the box the
 * level tests measure have to be the same box.
 */
export function propCollisionFootprint(
  rotationY: number,
  size: { width: number; depth: number },
): { width: number; depth: number } {
  const quarterTurned = Math.abs(Math.sin(rotationY)) > 0.7;
  return {
    width: quarterTurned ? size.depth : size.width,
    depth: quarterTurned ? size.width : size.depth,
  };
}

/** Wall thickness and height of the play-area perimeter, metres. */
export const PERIMETER_WALL_THICKNESS = 1.5;
export const PERIMETER_WALL_HEIGHT = 6;

/** The four perimeter walls as `[x, z, width, depth]`, centred on the play area. */
export function perimeterWallSpecs(
  area: { minX: number; maxX: number; minZ: number; maxZ: number },
  thickness = PERIMETER_WALL_THICKNESS,
): Array<[number, number, number, number]> {
  return [
    [(area.minX + area.maxX) / 2, area.minZ - thickness / 2, area.maxX - area.minX + thickness * 2, thickness],
    [(area.minX + area.maxX) / 2, area.maxZ + thickness / 2, area.maxX - area.minX + thickness * 2, thickness],
    [area.minX - thickness / 2, (area.minZ + area.maxZ) / 2, thickness, area.maxZ - area.minZ + thickness * 2],
    [area.maxX + thickness / 2, (area.minZ + area.maxZ) / 2, thickness, area.maxZ - area.minZ + thickness * 2],
  ];
}

/** The two drivable road surfaces in world XZ: the main street and the cross street. */
export function roadwayRects(halfWidth = ROAD_HALF_WIDTH): Array<{ minX: number; maxX: number; minZ: number; maxZ: number }> {
  return [
    { minX: -halfWidth, maxX: halfWidth, minZ: -STREET_EXTENT, maxZ: STREET_EXTENT },
    { minX: -STREET_EXTENT, maxX: STREET_EXTENT, minZ: -halfWidth, maxZ: halfWidth },
  ];
}

/** Width of a sidewalk strip, metres. */
export const SIDEWALK_WIDTH = 3.2;

/**
 * The sidewalk strips as `[x, z, width, depth]`: walkable pavement down both sides of both
 * streets. Exported because "is this prop on the pavement or in the road?" is a question
 * the level's tests have to answer with the same numbers the slabs are drawn from.
 */
export const SIDEWALK_BANDS: Array<[number, number, number, number]> = [
  [-(ROAD_HALF_WIDTH + SIDEWALK_WIDTH / 2), 0, SIDEWALK_WIDTH, STREET_EXTENT * 2],
  [ROAD_HALF_WIDTH + SIDEWALK_WIDTH / 2, 0, SIDEWALK_WIDTH, STREET_EXTENT * 2],
  [0, -(ROAD_HALF_WIDTH + SIDEWALK_WIDTH / 2), STREET_EXTENT * 2, SIDEWALK_WIDTH],
  [0, ROAD_HALF_WIDTH + SIDEWALK_WIDTH / 2, STREET_EXTENT * 2, SIDEWALK_WIDTH],
];

/** A sidewalk strip as a rectangle, `[0]` and `[1]` being the two long sides. */
export function sidewalkRects(): Array<{ minX: number; maxX: number; minZ: number; maxZ: number }> {
  return SIDEWALK_BANDS.map(([x, z, width, depth]) => ({
    minX: x - width / 2,
    maxX: x + width / 2,
    minZ: z - depth / 2,
    maxZ: z + depth / 2,
  }));
}

/**
 * Tag every glass pane carries into the collision world.
 *
 * Read straight off the impact classifier: `materialForTag` already answers `glass`
 * for a tag containing `window`, so this is the exact label the glass profile keys
 * on — no second material system and no new keyword to keep in sync.
 */
export const GLASS_TAG = 'prop:window';

interface GlassPanePlacement {
  x: number;
  z: number;
  /** Pane width along its own local X, metres. */
  width: number;
  height: number;
  /** 0 faces ±Z; ±`Math.PI / 2` turns the pane broadside to the street. */
  rotationY: number;
}

/** Pane thickness, metres. Thin enough to read as glass, thick enough to be a box. */
const GLASS_THICKNESS = 0.08;

/**
 * Shattered shopfront panes propped along the building line.
 *
 * The block shipped without a single glass surface, so the glass impact profile was
 * built, tested and never fired in play. These put glass in front of the gun. Each
 * one stands just past the sidewalk on the building line — the natural place for a
 * pane that has come out of a shopfront — clear of the road, of the cross-street
 * sidewalk and of every footprint in `PROP_LAYOUT`, and inside `WORLD.playArea` so
 * the bounds test means something.
 */
export const GLASS_PANES: readonly GlassPanePlacement[] = [
  { x: 11.6, z: 15, width: 3.4, height: 2.6, rotationY: Math.PI / 2 },
  { x: 11.6, z: -30, width: 2.6, height: 2.2, rotationY: Math.PI / 2 },
  { x: -11.6, z: -22, width: 3.0, height: 2.4, rotationY: -Math.PI / 2 },
  { x: -11.6, z: 38, width: 2.4, height: 2.0, rotationY: -Math.PI / 2 },
];

/**
 * Builds the glass panes and registers one collision box per pane; returns the
 * number placed.
 *
 * The mesh is a coded primitive (a scaled unit box) with a shared translucent
 * material, so the block still contains glass when the prop download fails — a pane
 * that depends on an asset is a pane that can be missing again. The collision box
 * mirrors the visual footprint, so the pane the player sees is the pane their bullet
 * hits and the tag `ImpactEffects` reads is the one on the geometry in front of them.
 */
export function addGlassPanes(
  group: Group,
  collision: CollisionWorld,
  shadows: boolean,
  disposables: Array<{ dispose(): void }> = [],
): number {
  const geometry = new BoxGeometry(1, 1, 1);
  // Pale blue and see-through, with a faint emissive: plain transparent glass turns
  // black on the unlit night street and reads as a hole in the world instead of a
  // pane. Double-sided because a pane on the street is shot from either side.
  const material = new MeshStandardMaterial({
    color: 0x9fd4e6,
    transparent: true,
    opacity: 0.34,
    roughness: 0.08,
    metalness: 0,
    emissive: 0x1d4756,
    emissiveIntensity: 0.9,
    side: DoubleSide,
    depthWrite: false,
  });
  disposables.push(geometry, material);

  let placed = 0;
  for (const pane of GLASS_PANES) {
    const mesh = new Mesh(geometry, material);
    mesh.position.set(pane.x, pane.height / 2, pane.z);
    mesh.rotation.y = pane.rotationY;
    mesh.scale.set(pane.width, pane.height, GLASS_THICKNESS);
    // Glass throws no shadow worth the pass, but it does catch the lamp light.
    mesh.castShadow = false;
    mesh.receiveShadow = shadows;
    mesh.name = `glass-pane-${placed}`;
    group.add(mesh);

    // Same axis swap the prop loop uses: a quarter-turned pane is thin on X.
    const paneFootprint = propCollisionFootprint(pane.rotationY, { width: pane.width, depth: GLASS_THICKNESS });
    collision.addCenteredBox(pane.x, pane.z, paneFootprint.width, paneFootprint.depth, pane.height, GLASS_TAG, {
      blocksPlayer: true,
      blocksZombies: true,
    });
    placed += 1;
  }
  return placed;
}

/**
 * Builds the block: ground, streets, buildings, perimeter, glass and props; then
 * registers every solid object in the collision world and rebuilds the
 * navigation grid from it.
 */
export async function buildCityLevel(deps: CityLevelDeps): Promise<CityLevelHandle> {
  const { scene, assets, quality, navigation } = deps;
  const group = new Group();
  group.name = 'city';
  const collision = new CollisionWorld({ ...WORLD.playArea });
  const props = new PropLibrary(assets);
  const disposables: Array<{ dispose(): void }> = [];

  // --- ground -------------------------------------------------------------
  const groundTexture = createDirtTexture(20);
  const groundGeometry = new PlaneGeometry(WORLD.size, WORLD.size);
  const groundMaterial = new MeshStandardMaterial({ map: groundTexture, roughness: 1, metalness: 0 });
  const ground = new Mesh(groundGeometry, groundMaterial);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  ground.receiveShadow = quality.shadows;
  ground.name = 'ground';
  group.add(ground);
  disposables.push(groundGeometry, groundMaterial, groundTexture);

  // --- props --------------------------------------------------------------
  const loadResult = await props.load(PROP_SPECS);
  if (loadResult.failed.length > 0) {
    console.warn('[city] props that failed to load:', loadResult.failed.join(', '));
  }

  const detailRandom = new SeededRandom(20240317);
  let placedProps = 0;
  for (const placement of PROP_LAYOUT) {
    const importance = placement.importance ?? 1;
    if (importance < 1 && detailRandom.next() > importance * quality.propDensity) continue;
    const object = props.create(placement.prop);
    if (!object) continue;
    object.position.set(placement.x, 0, placement.z);
    object.rotation.y = placement.rotationY ?? 0;
    group.add(object);
    placedProps += 1;

    const spec = PROP_SPECS.find((entry) => entry.name === placement.prop);
    const template = props.get(placement.prop);
    if (spec?.solid && template) {
      const footprint = propCollisionFootprint(placement.rotationY ?? 0, template.size);
      collision.addCenteredBox(placement.x, placement.z, footprint.width, footprint.depth, template.size.height, `prop:${placement.prop}`, {
        blocksPlayer: true,
        blocksZombies: true,
      });
    }
  }

  // --- streets ------------------------------------------------------------
  const roadMaterial = new MeshStandardMaterial({ map: createRoadTexture(3), roughness: 0.95, metalness: 0.05 });
  const sidewalkMaterial = new MeshStandardMaterial({ map: createSidewalkTexture(4), roughness: 1, metalness: 0 });
  disposables.push(roadMaterial, sidewalkMaterial);
  if (roadMaterial.map) disposables.push(roadMaterial.map);
  if (sidewalkMaterial.map) disposables.push(sidewalkMaterial.map);

  const roadGeometry = new PlaneGeometry(ROAD_HALF_WIDTH * 2, STREET_EXTENT * 2);
  const crossRoadGeometry = new PlaneGeometry(STREET_EXTENT * 2, ROAD_HALF_WIDTH * 2);
  const road = new Mesh(roadGeometry, roadMaterial);
  road.rotation.x = -Math.PI / 2;
  road.position.y = 0.005;
  road.receiveShadow = quality.shadows;
  road.name = 'road-main';
  group.add(road);

  const crossRoad = new Mesh(crossRoadGeometry, roadMaterial);
  crossRoad.rotation.x = -Math.PI / 2;
  crossRoad.position.y = 0.005;
  crossRoad.receiveShadow = quality.shadows;
  crossRoad.name = 'road-cross';
  group.add(crossRoad);
  disposables.push(roadGeometry, crossRoadGeometry);

  // Sidewalk strips frame the roads; they are walkable but give visual edges.
  for (const [x, z, width, depth] of SIDEWALK_BANDS) {
    const geometry = new PlaneGeometry(width, depth);
    const slab = new Mesh(geometry, sidewalkMaterial);
    slab.rotation.x = -Math.PI / 2;
    slab.position.set(x, 0.03, z);
    slab.receiveShadow = quality.shadows;
    slab.name = 'sidewalk';
    group.add(slab);
    disposables.push(geometry);
  }

  // --- buildings ----------------------------------------------------------
  const buildings = generateBuildings();
  const facadeCache = new Map<string, { map: ReturnType<typeof createFacadeTextures>['map']; emissiveMap: ReturnType<typeof createFacadeTextures>['emissiveMap'] }>();
  let buildingCount = 0;

  for (const building of buildings) {
    const key = `facade-${building.seed % 3}`;
    let textures = facadeCache.get(key);
    if (!textures) {
      textures = createFacadeTextures(building.seed % 2 === 0 ? '#2b2f38' : '#343138', building.seed);
      facadeCache.set(key, textures);
      disposables.push(textures.map, textures.emissiveMap);
    }
    const material = new MeshStandardMaterial({
      map: textures.map,
      emissiveMap: textures.emissiveMap,
      emissive: 0xffffff,
      emissiveIntensity: 0.85,
      roughness: 0.92,
      metalness: 0.05,
    });
    const geometry = new BoxGeometry(building.width, building.height, building.depth);
    const mesh = new Mesh(geometry, material);
    mesh.position.set(building.x, building.height / 2, building.z);
    mesh.castShadow = quality.shadows;
    mesh.receiveShadow = quality.shadows;
    mesh.name = `building-${buildingCount}`;
    group.add(mesh);
    disposables.push(geometry, material);
    buildingCount += 1;

    collision.addCenteredBox(building.x, building.z, building.width, building.depth, building.height, 'building', {
      blocksPlayer: true,
      blocksZombies: true,
    });

    // Roof lip: gives the silhouette a readable edge against the sky.
    const lipGeometry = new BoxGeometry(building.width + 1.2, 0.5, building.depth + 1.2);
    const lipMaterial = new MeshStandardMaterial({ color: 0x1a1d24, roughness: 1 });
    const lip = new Mesh(lipGeometry, lipMaterial);
    lip.position.set(building.x, building.height + 0.25, building.z);
    lip.castShadow = quality.shadows;
    group.add(lip);
    disposables.push(lipGeometry, lipMaterial);
  }

  // --- perimeter ----------------------------------------------------------
  const area = WORLD.playArea;
  const perimeterMaterial = new MeshStandardMaterial({ color: 0x1b1e25, roughness: 0.95, metalness: 0.1 });
  const wallHeight = PERIMETER_WALL_HEIGHT;
  const wallSpecs = perimeterWallSpecs(area);
  for (const [x, z, width, depth] of wallSpecs) {
    const geometry = new BoxGeometry(width, wallHeight, depth);
    const wall = new Mesh(geometry, perimeterMaterial);
    wall.position.set(x, wallHeight / 2, z);
    wall.receiveShadow = quality.shadows;
    wall.name = 'perimeter';
    group.add(wall);
    disposables.push(geometry);
    collision.addCenteredBox(x, z, width, depth, wallHeight, 'perimeter', { blocksPlayer: true, blocksZombies: true });
  }
  disposables.push(perimeterMaterial);

  // --- glass ---------------------------------------------------------------
  // Coded primitives rather than a prop asset: the block has to contain glass for
  // the impact classifier's glass profile to ever fire, and a pane that cannot fail
  // to download is a pane that is always there to be shot. See `addGlassPanes`.
  addGlassPanes(group, collision, quality.shadows, disposables);

  // --- lights -------------------------------------------------------------
  // Only a couple of real point lights: emissive geometry does the rest and
  // keeps the shadow pass cheap with dozens of skinned zombies on screen.
  const lampGeometry = new SphereGeometry(0.28, 10, 8);
  const lampMaterial = new MeshStandardMaterial({ color: 0xffdca8, emissive: 0xffc98a, emissiveIntensity: 2.6 });
  disposables.push(lampGeometry, lampMaterial);
  // Two rows down the street plus a cross street, so the player is never fighting
  // in a black pool between lights. Every lamp now gets a real light and a road
  // pool: a lamp that emits nothing was the other half of the "everything is
  // black" problem, and these lights cast no shadows so the pass stays cheap.
  const lampPositions: Array<[number, number, number]> = [
    [16, 5.2, 22], [16, 5.2, -2], [16, 5.2, -26],
    [-16, 5.2, 22], [-16, 5.2, -2], [-16, 5.2, -26],
    [0, 5.2, 0], [26, 5.2, 0], [-26, 5.2, 0],
  ];
  lampPositions.forEach(([x, y, z]) => {
    const lamp = new Mesh(lampGeometry, lampMaterial);
    lamp.position.set(x, y, z);
    group.add(lamp);

    // Intensity is in candela and falls off with the square of the distance, so
    // this is tuned for the road 5 m below: 18/25 = 0.7, bright enough to read the
    // asphalt without blowing out a zombie standing under the lamp.
    const light = new PointLight(0xffd0a0, 18, 30, 2);
    light.position.set(x, y - 0.3, z);
    light.castShadow = false;
    group.add(light);
    disposables.push(light);

    const pool = createLampPool(17);
    pool.position.set(x, 0.06, z);
    group.add(pool);
    disposables.push(pool.geometry);
    if (pool.material instanceof Material) disposables.push(pool.material);
    const poolTexture = pool.userData.texture;
    if (poolTexture instanceof Texture) disposables.push(poolTexture);
  });

  scene.add(group);
  navigation.rebuild(collision, 0.45);

  return {
    group,
    collision,
    props,
    spawnHints: BUILD_SPAWN_HINTS,
    dispose() {
      scene.remove(group);
      props.dispose();
      for (const entry of disposables) entry.dispose();
      disposables.length = 0;
      collision.clear();
    },
  };
}

/** Open ground at the four street ends plus a few block corners. */
const BUILD_SPAWN_HINTS: Array<{ x: number; z: number }> = [
  { x: 0, z: 55 }, { x: 0, z: -55 }, { x: 55, z: 0 }, { x: -55, z: 0 },
  { x: 34, z: 34 }, { x: -34, z: 34 }, { x: 34, z: -34 }, { x: -34, z: -34 },
  { x: 0, z: 30 }, { x: 0, z: -30 }, { x: 30, z: 0 }, { x: -30, z: 0 },
];

/**
 * Buildings are placed deterministically into the four city blocks, always
 * leaving a 6 m alley between neighbours so the navigation grid stays connected
 * and zombies have flanking routes rather than a single chokepoint.
 */
export function generateBuildings(): BuildingPlacement[] {
  const random = new SeededRandom(77123);
  const result: BuildingPlacement[] = [];
  const inner = ROAD_HALF_WIDTH + 3.5; // clear of the sidewalks
  const outer = WORLD.playArea.maxX - 2;
  const blocks: Array<{ x0: number; x1: number; z0: number; z1: number }> = [
    { x0: inner, x1: outer, z0: inner, z1: outer },
    { x0: -outer, x1: -inner, z0: inner, z1: outer },
    { x0: inner, x1: outer, z0: -outer, z1: -inner },
    { x0: -outer, x1: -inner, z0: -outer, z1: -inner },
  ];

  for (const block of blocks) {
    const columns = 2;
    const rows = 2;
    const gap = 6;
    const cellWidth = (block.x1 - block.x0 - gap * (columns + 1)) / columns;
    const cellDepth = (block.z1 - block.z0 - gap * (rows + 1)) / rows;
    for (let column = 0; column < columns; column += 1) {
      for (let row = 0; row < rows; row += 1) {
        const width = cellWidth * random.range(0.72, 0.98);
        const depth = cellDepth * random.range(0.72, 0.98);
        const x = block.x0 + gap * (column + 1) + cellWidth * column + width / 2;
        const z = block.z0 + gap * (row + 1) + cellDepth * row + depth / 2;
        const height = random.range(7, 20);
        result.push({ x, z, width, depth, height, seed: Math.floor(random.range(0, 9999)) });
      }
    }
  }
  return result;
}
