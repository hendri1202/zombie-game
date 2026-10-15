import {
  BoxGeometry, Group, Material, Mesh, MeshStandardMaterial, PlaneGeometry, PointLight, Scene,
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

interface PropPlacement {
  prop: string;
  x: number;
  z: number;
  rotationY?: number;
  /** Relative chance the prop survives the quality filter; 1 = always placed. */
  importance?: number;
}

interface BuildingPlacement {
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

const ROAD_HALF_WIDTH = 8;
const STREET_EXTENT = 64;

/** Deterministic prop layout so the level looks the same on every machine. */
const PROP_LAYOUT: PropPlacement[] = [
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
  { prop: 'couch', x: 9.6, z: 22, rotationY: 1.4 },
  { prop: 'chest', x: -9.4, z: 34, rotationY: 0.5 },

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
 * Builds the block: ground, streets, buildings, perimeter and props; then
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
      const rotated = Math.abs(Math.sin(placement.rotationY ?? 0)) > 0.7;
      const width = rotated ? template.size.depth : template.size.width;
      const depth = rotated ? template.size.width : template.size.depth;
      collision.addCenteredBox(placement.x, placement.z, width, depth, template.size.height, `prop:${placement.prop}`, {
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
  const sidewalkSpecs: Array<[number, number, number, number]> = [
    [-ROAD_HALF_WIDTH - 1.6, 0, 3.2, STREET_EXTENT * 2],
    [ROAD_HALF_WIDTH + 1.6, 0, 3.2, STREET_EXTENT * 2],
    [0, -ROAD_HALF_WIDTH - 1.6, STREET_EXTENT * 2, 3.2],
    [0, ROAD_HALF_WIDTH + 1.6, STREET_EXTENT * 2, 3.2],
  ];
  for (const [x, z, width, depth] of sidewalkSpecs) {
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
  const wallHeight = 6;
  const wallThickness = 1.5;
  const wallSpecs: Array<[number, number, number, number]> = [
    [(area.minX + area.maxX) / 2, area.minZ - wallThickness / 2, area.maxX - area.minX + wallThickness * 2, wallThickness],
    [(area.minX + area.maxX) / 2, area.maxZ + wallThickness / 2, area.maxX - area.minX + wallThickness * 2, wallThickness],
    [area.minX - wallThickness / 2, (area.minZ + area.maxZ) / 2, wallThickness, area.maxZ - area.minZ + wallThickness * 2],
    [area.maxX + wallThickness / 2, (area.minZ + area.maxZ) / 2, wallThickness, area.maxZ - area.minZ + wallThickness * 2],
  ];
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
function generateBuildings(): BuildingPlacement[] {
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
