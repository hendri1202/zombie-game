/**
 * Grid A* used by the zombie director.
 *
 * Plain arrays and typed arrays only: this runs for every zombie that needs a
 * new path, so it must not allocate per node. Callers pass in the reusable
 * buffers they own.
 */

export interface PathGrid {
  width: number;
  height: number;
  /** 1 = walkable, 0 = blocked. Row-major, index = z * width + x. */
  cells: Uint8Array;
}

export interface PathBuffers {
  gScore: Float32Array;
  fScore: Float32Array;
  cameFrom: Int32Array;
  closed: Uint8Array;
  openHeap: Int32Array;
  openSize: { value: number };
}

export function createPathBuffers(width: number, height: number): PathBuffers {
  const size = width * height;
  return {
    gScore: new Float32Array(size),
    fScore: new Float32Array(size),
    cameFrom: new Int32Array(size),
    closed: new Uint8Array(size),
    openHeap: new Int32Array(size + 1),
    openSize: { value: 0 },
  };
}

export function indexOf(grid: PathGrid, x: number, z: number): number {
  return z * grid.width + x;
}

export function isWalkable(grid: PathGrid, x: number, z: number): boolean {
  if (x < 0 || z < 0 || x >= grid.width || z >= grid.height) return false;
  return grid.cells[z * grid.width + x] === 1;
}

const NEIGHBOURS: Array<{ dx: number; dz: number; cost: number }> = [
  { dx: 1, dz: 0, cost: 1 },
  { dx: -1, dz: 0, cost: 1 },
  { dx: 0, dz: 1, cost: 1 },
  { dx: 0, dz: -1, cost: 1 },
  { dx: 1, dz: 1, cost: Math.SQRT2 },
  { dx: 1, dz: -1, cost: Math.SQRT2 },
  { dx: -1, dz: 1, cost: Math.SQRT2 },
  { dx: -1, dz: -1, cost: Math.SQRT2 },
];

function heuristic(x0: number, z0: number, x1: number, z1: number): number {
  const dx = Math.abs(x0 - x1);
  const dz = Math.abs(z0 - z1);
  // Octile distance: admissible and consistent for 8-way movement.
  return (dx + dz) + (Math.SQRT2 - 2) * Math.min(dx, dz);
}

function heapPush(buffers: PathBuffers, node: number): void {
  const heap = buffers.openHeap;
  buffers.openSize.value += 1;
  let i = buffers.openSize.value;
  heap[i] = node;
  while (i > 1) {
    const parent = i >> 1;
    if (buffers.fScore[heap[parent]] <= buffers.fScore[heap[i]]) break;
    const tmp = heap[parent];
    heap[parent] = heap[i];
    heap[i] = tmp;
    i = parent;
  }
}

function heapPop(buffers: PathBuffers): number {
  const heap = buffers.openHeap;
  const top = heap[1];
  heap[1] = heap[buffers.openSize.value];
  buffers.openSize.value -= 1;
  let i = 1;
  for (;;) {
    const left = i * 2;
    const right = left + 1;
    let smallest = i;
    if (left <= buffers.openSize.value && buffers.fScore[heap[left]] < buffers.fScore[heap[smallest]]) smallest = left;
    if (right <= buffers.openSize.value && buffers.fScore[heap[right]] < buffers.fScore[heap[smallest]]) smallest = right;
    if (smallest === i) break;
    const tmp = heap[smallest];
    heap[smallest] = heap[i];
    heap[i] = tmp;
    i = smallest;
  }
  return top;
}

export interface PathRequest {
  startX: number;
  startZ: number;
  goalX: number;
  goalZ: number;
  maxNodes?: number;
}

/**
 * Returns the path as grid coordinates from the cell *after* start up to and
 * including the goal, or null when no path exists. Writing into `out` keeps the
 * allocation out of the zombie update loop.
 */
export function findPath(
  grid: PathGrid,
  buffers: PathBuffers,
  request: PathRequest,
  out: Array<{ x: number; z: number }>,
): Array<{ x: number; z: number }> | null {
  const { startX, startZ, goalX, goalZ } = request;
  out.length = 0;

  if (!isWalkable(grid, startX, startZ) || !isWalkable(grid, goalX, goalZ)) return null;

  const size = grid.width * grid.height;
  const maxNodes = request.maxNodes ?? 2500;
  buffers.gScore.fill(Number.POSITIVE_INFINITY);
  buffers.fScore.fill(Number.POSITIVE_INFINITY);
  buffers.closed.fill(0);
  buffers.cameFrom.fill(-1);
  buffers.openSize.value = 0;

  const start = indexOf(grid, startX, startZ);
  const goal = indexOf(grid, goalX, goalZ);
  buffers.gScore[start] = 0;
  buffers.fScore[start] = heuristic(startX, startZ, goalX, goalZ);
  heapPush(buffers, start);

  let expanded = 0;
  let found = false;

  while (buffers.openSize.value > 0) {
    const current = heapPop(buffers);
    if (current === goal) {
      found = true;
      break;
    }
    if (buffers.closed[current] === 1) continue;
    buffers.closed[current] = 1;
    expanded += 1;
    if (expanded > maxNodes) break;

    const cx = current % grid.width;
    const cz = (current - cx) / grid.width;

    for (const neighbour of NEIGHBOURS) {
      const nx = cx + neighbour.dx;
      const nz = cz + neighbour.dz;
      if (!isWalkable(grid, nx, nz)) continue;
      // No corner cutting: a diagonal move needs both orthogonal cells free.
      if (neighbour.dx !== 0 && neighbour.dz !== 0) {
        if (!isWalkable(grid, cx + neighbour.dx, cz) || !isWalkable(grid, cx, cz + neighbour.dz)) continue;
      }
      const node = nz * grid.width + nx;
      if (buffers.closed[node] === 1) continue;
      const tentative = buffers.gScore[current] + neighbour.cost;
      if (tentative >= buffers.gScore[node]) continue;
      buffers.cameFrom[node] = current;
      buffers.gScore[node] = tentative;
      buffers.fScore[node] = tentative + heuristic(nx, nz, goalX, goalZ);
      heapPush(buffers, node);
      if (node < 0 || node >= size) continue;
    }
  }

  if (!found) return null;

  let node = goal;
  while (node !== -1 && node !== start) {
    const x = node % grid.width;
    const z = (node - x) / grid.width;
    out.push({ x, z });
    node = buffers.cameFrom[node];
    if (out.length > size) break; // safety against a corrupted cameFrom chain
  }
  out.reverse();
  return out;
}
