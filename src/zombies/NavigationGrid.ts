import { NAV } from '../app/gameConfig';
import type { CollisionWorld } from '../level/CollisionWorld';
import {
  createPathBuffers, findPath, isWalkable, type PathBuffers, type PathGrid,
} from './pathfinding';

export interface GridPoint {
  x: number;
  z: number;
}

/**
 * Uniform-cost grid built from the same boxes the collision world uses, so the
 * route a zombie walks and the walls that stop it cannot disagree.
 *
 * Cell size is NAV.cellSize (1 m). A cell is blocked when a zombie-radius circle
 * placed at its centre would overlap solid geometry; that inflates obstacles by
 * the zombie radius and removes the need for a separate clearance pass.
 */
export class NavigationGrid {
  readonly grid: PathGrid;
  readonly cellSize: number;
  readonly originX: number;
  readonly originZ: number;
  private readonly buffers: PathBuffers;
  private readonly scratch: GridPoint[] = [];

  constructor(bounds: { minX: number; maxX: number; minZ: number; maxZ: number }, cellSize = NAV.cellSize) {
    this.cellSize = cellSize;
    this.originX = bounds.minX;
    this.originZ = bounds.minZ;
    const width = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / cellSize));
    const height = Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ) / cellSize));
    this.grid = { width, height, cells: new Uint8Array(width * height) };
    this.buffers = createPathBuffers(width, height);
  }

  rebuild(world: CollisionWorld, agentRadius: number): void {
    const { width, height, cells } = this.grid;
    for (let z = 0; z < height; z += 1) {
      for (let x = 0; x < width; x += 1) {
        const worldX = this.originX + (x + 0.5) * this.cellSize;
        const worldZ = this.originZ + (z + 0.5) * this.cellSize;
        // A radius-wide probe on each axis approximates a circle without the
        // trigonometry, and guarantees connectivity for the actual movers.
        const blocked = world.isCircleBlocked(worldX, worldZ, agentRadius);
        cells[z * width + x] = blocked ? 0 : 1;
      }
    }
  }

  worldToGrid(worldX: number, worldZ: number): GridPoint {
    return {
      x: Math.floor((worldX - this.originX) / this.cellSize),
      z: Math.floor((worldZ - this.originZ) / this.cellSize),
    };
  }

  gridToWorld(gridX: number, gridZ: number): GridPoint {
    return {
      x: this.originX + (gridX + 0.5) * this.cellSize,
      z: this.originZ + (gridZ + 0.5) * this.cellSize,
    };
  }

  isWalkableWorld(worldX: number, worldZ: number): boolean {
    const cell = this.worldToGrid(worldX, worldZ);
    return isWalkable(this.grid, cell.x, cell.z);
  }

  /**
   * Nearest walkable cell to a world position, searched in rings. Used when a
   * zombie or the player ends up standing inside inflated geometry.
   */
  nearestWalkable(worldX: number, worldZ: number, maxRadius = 6): GridPoint | null {
    const start = this.worldToGrid(worldX, worldZ);
    if (isWalkable(this.grid, start.x, start.z)) return start;
    for (let radius = 1; radius <= maxRadius; radius += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (Math.abs(dx) !== radius && Math.abs(dz) !== radius) continue;
          const x = start.x + dx;
          const z = start.z + dz;
          if (isWalkable(this.grid, x, z)) return { x, z };
        }
      }
    }
    return null;
  }

  /**
   * Path between two world positions, returned as world-space waypoints.
   * The returned array is reused between calls; copy it if it must outlive the
   * current frame.
   */
  findPathWorld(startX: number, startZ: number, goalX: number, goalZ: number): GridPoint[] | null {
    const start = this.nearestWalkable(startX, startZ);
    const goal = this.nearestWalkable(goalX, goalZ);
    if (!start || !goal) return null;
    const path = findPath(
      this.grid,
      this.buffers,
      { startX: start.x, startZ: start.z, goalX: goal.x, goalZ: goal.z, maxNodes: NAV.maxPathNodes },
      this.scratch,
    );
    if (!path) return null;
    return path.map((cell) => this.gridToWorld(cell.x, cell.z));
  }

  get walkableRatio(): number {
    let walkable = 0;
    for (let i = 0; i < this.grid.cells.length; i += 1) walkable += this.grid.cells[i];
    return walkable / this.grid.cells.length;
  }
}
