export { CollisionWorld, type CollisionBox, type RaycastHit } from './CollisionWorld';
export { PropLibrary, type PropSpec, type PropTemplate } from './PropLibrary';
export {
  addGlassPanes, buildCityLevel, generateBuildings, GLASS_PANES, GLASS_TAG, PERIMETER_WALL_HEIGHT,
  PERIMETER_WALL_THICKNESS, PROP_LAYOUT, PROP_SPECS, ROAD_HALF_WIDTH, SIDEWALK_BANDS, SIDEWALK_WIDTH,
  STREET_EXTENT, perimeterWallSpecs, propCollisionFootprint, roadwayRects, sidewalkRects,
  type BuildingPlacement, type CityLevelHandle, type CityLevelDeps, type PropPlacement,
} from './CityLevel';
export { MAX_SPAWN_DISTANCE, pickNearbySpawnPoint, pickSpawnPoint, type SpawnCandidate, type SpawnQuery } from './SpawnPoints';
