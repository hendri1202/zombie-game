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
  /** Connected-region label per cell, built lazily and invalidated on rebuild. */
  private componentLabels: Int32Array | null = null;
  private componentSizes: number[] = [];

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
    // Obstacles moved, so the old regions are meaningless.
    this.componentLabels = null;
    this.componentSizes = [];
  }

  /**
   * Labels walkable cells by connected region, 4-neighbour, once per rebuild.
   *
   * A cell being walkable says nothing about whether anything can *reach* it. The world
   * is a blockout with buildings on it, so it contains walkable pockets sealed off from
   * the street; a zombie spawned in one is alive, counted as remaining, and can never
   * arrive — the wave then never clears and the run is stuck with a HUD that promises
   * zombies nobody can find. Spawning only inside the region the player stands in removes
   * that whole class of stall.
   */
  private ensureComponents(): void {
    if (this.componentLabels) return;
    const { width, height, cells } = this.grid;
    const labels = new Int32Array(width * height).fill(-1);
    const sizes: number[] = [];
    const stack: number[] = [];
    for (let start = 0; start < cells.length; start += 1) {
      if (cells[start] === 0 || labels[start] !== -1) continue;
      const id = sizes.length;
      let size = 0;
      labels[start] = id;
      stack.push(start);
      while (stack.length > 0) {
        const index = stack.pop() as number;
        size += 1;
        const x = index % width;
        const z = (index - x) / width;
        // Four neighbours, not eight: a diagonal step would let a route slip through a
        // corner where two blocked cells touch.
        if (x > 0 && cells[index - 1] === 1 && labels[index - 1] === -1) {
          labels[index - 1] = id;
          stack.push(index - 1);
        }
        if (x < width - 1 && cells[index + 1] === 1 && labels[index + 1] === -1) {
          labels[index + 1] = id;
          stack.push(index + 1);
        }
        if (z > 0 && cells[index - width] === 1 && labels[index - width] === -1) {
          labels[index - width] = id;
          stack.push(index - width);
        }
        if (z < height - 1 && cells[index + width] === 1 && labels[index + width] === -1) {
          labels[index + width] = id;
          stack.push(index + width);
        }
      }
      sizes.push(size);
    }
    this.componentLabels = labels;
    this.componentSizes = sizes;
  }

  /** Connected-region id at a world position, or -1 when the cell is blocked. */
  componentAt(worldX: number, worldZ: number): number {
    this.ensureComponents();
    const cell = this.worldToGrid(worldX, worldZ);
    if (cell.x < 0 || cell.z < 0 || cell.x >= this.grid.width || cell.z >= this.grid.height) return -1;
    return this.componentLabels?.[cell.z * this.grid.width + cell.x] ?? -1;
  }

  /** True when both positions are walkable and in the same connected region. */
  isConnectedWorld(ax: number, az: number, bx: number, bz: number): boolean {
    const from = this.componentAt(ax, az);
    if (from < 0) return false;
    return from === this.componentAt(bx, bz);
  }

  get componentCount(): number {
    this.ensureComponents();
    return this.componentSizes.length;
  }

  /** Id of the biggest region, which is the street network. -1 when nothing is walkable. */
  get largestComponent(): number {
    this.ensureComponents();
    let best = -1;
    let bestSize = 0;
    this.componentSizes.forEach((size, id) => {
      if (size > bestSize) {
        bestSize = size;
        best = id;
      }
    });
    return best;
  }

  /** Number of cells in a region, for diagnostics. */
  componentSize(id: number): number {
    this.ensureComponents();
    return this.componentSizes[id] ?? 0;
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
