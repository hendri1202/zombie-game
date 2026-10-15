import type { Vector3 } from 'three';

export interface CollisionBox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Box height above the ground plane; 0 means "full height". */
  height: number;
  /** Free-form label used by the debug overlay. */
  tag: string;
  /** False for low props the player can step over but zombies should not path through. */
  blocksPlayer: boolean;
  blocksZombies: boolean;
}

export interface RaycastHit {
  distance: number;
  pointX: number;
  pointY: number;
  pointZ: number;
  tag: string;
}

/**
 * Axis-aligned collision world shared by the player, the zombies and the
 * navigation grid. Everything here is cheap box maths on purpose: bringing in a
 * physics engine would be a large dependency for a game whose collisions are
 * boxes and capsules.
 */
export class CollisionWorld {
  readonly boxes: CollisionBox[] = [];
  readonly bounds: { minX: number; maxX: number; minZ: number; maxZ: number };

  constructor(bounds: { minX: number; maxX: number; minZ: number; maxZ: number }) {
    this.bounds = bounds;
  }

  addBox(box: CollisionBox): CollisionBox {
    this.boxes.push(box);
    return box;
  }

  /** Convenience for a centred box. */
  addCenteredBox(
    centerX: number,
    centerZ: number,
    width: number,
    depth: number,
    height: number,
    tag: string,
    options: { blocksPlayer?: boolean; blocksZombies?: boolean } = {},
  ): CollisionBox {
    return this.addBox({
      minX: centerX - width / 2,
      maxX: centerX + width / 2,
      minZ: centerZ - depth / 2,
      maxZ: centerZ + depth / 2,
      height,
      tag,
      blocksPlayer: options.blocksPlayer ?? true,
      blocksZombies: options.blocksZombies ?? true,
    });
  }

  clear(): void {
    this.boxes.length = 0;
  }

  get count(): number {
    return this.boxes.length;
  }

  /**
   * Pushes a circle out of every overlapping box and returns the corrected
   * position. Iterating a couple of times resolves the corner case where being
   * pushed out of one box pushes the circle into another.
   */
  resolveCircle(position: Vector3, radius: number, iterations = 3): boolean {
    let corrected = false;
    for (let pass = 0; pass < iterations; pass += 1) {
      let moved = false;
      for (const box of this.boxes) {
        if (!box.blocksPlayer) continue;
        const closestX = Math.min(Math.max(position.x, box.minX), box.maxX);
        const closestZ = Math.min(Math.max(position.z, box.minZ), box.maxZ);
        let dx = position.x - closestX;
        let dz = position.z - closestZ;
        let distanceSq = dx * dx + dz * dz;

        if (distanceSq > radius * radius) continue;

        if (distanceSq > 1e-8) {
          const distance = Math.sqrt(distanceSq);
          const push = radius - distance;
          position.x += (dx / distance) * push;
          position.z += (dz / distance) * push;
        } else {
          // Centre is inside the box: escape through the nearest face.
          const toLeft = Math.abs(position.x - box.minX);
          const toRight = Math.abs(box.maxX - position.x);
          const toBack = Math.abs(position.z - box.minZ);
          const toFront = Math.abs(box.maxZ - position.z);
          const smallest = Math.min(toLeft, toRight, toBack, toFront);
          if (smallest === toLeft) position.x = box.minX - radius;
          else if (smallest === toRight) position.x = box.maxX + radius;
          else if (smallest === toBack) position.z = box.minZ - radius;
          else position.z = box.maxZ + radius;
          dx = 0;
          dz = 0;
        }
        moved = true;
        corrected = true;
      }
      if (!moved) break;
    }
    return corrected;
  }

  /** True when a circle at (x, z) overlaps a zombie-blocking box. */
  isCircleBlocked(x: number, z: number, radius: number): boolean {
    for (const box of this.boxes) {
      if (!box.blocksZombies) continue;
      const closestX = Math.min(Math.max(x, box.minX), box.maxX);
      const closestZ = Math.min(Math.max(z, box.minZ), box.maxZ);
      const dx = x - closestX;
      const dz = z - closestZ;
      if (dx * dx + dz * dz < radius * radius) return true;
    }
    return false;
  }

  /**
   * Slab-method ray/box test against every solid box, including full-height
   * hits so bullets stop at walls instead of passing through buildings.
   */
  raycast(origin: Vector3, direction: Vector3, maxDistance: number): RaycastHit | null {
    let best: RaycastHit | null = null;

    // Vertical slab: from ground to the box height (or a tall default).
    const maxY = 60;
    const invX = 1 / (direction.x || 1e-9);
    const invY = 1 / (direction.y || 1e-9);
    const invZ = 1 / (direction.z || 1e-9);

    for (const box of this.boxes) {
      if (!box.blocksPlayer && !box.blocksZombies) continue;
      const top = box.height > 0 ? box.height : maxY;
      let tMin = 0;
      let tMax = maxDistance;

      // X slab
      let t1 = (box.minX - origin.x) * invX;
      let t2 = (box.maxX - origin.x) * invX;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) continue;

      // Y slab
      t1 = (0 - origin.y) * invY;
      t2 = (top - origin.y) * invY;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) continue;

      // Z slab
      t1 = (box.minZ - origin.z) * invZ;
      t2 = (box.maxZ - origin.z) * invZ;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) continue;

      if (tMin < 0 || tMin > maxDistance) continue;
      if (!best || tMin < best.distance) {
        best = {
          distance: tMin,
          pointX: origin.x + direction.x * tMin,
          pointY: origin.y + direction.y * tMin,
          pointZ: origin.z + direction.z * tMin,
          tag: box.tag,
        };
      }
    }
    return best;
  }

  /**
   * Line-of-sight test used by the AI: cheaper than a full raycast because it
   * stops at the first blocker.
   */
  hasLineOfSight(fromX: number, fromZ: number, toX: number, toZ: number, ignoreHeight = true): boolean {
    const dx = toX - fromX;
    const dz = toZ - fromZ;
    const distance = Math.hypot(dx, dz);
    if (distance < 1e-4) return true;
    const steps = Math.ceil(distance / 0.75);
    for (let i = 1; i < steps; i += 1) {
      const t = i / steps;
      const x = fromX + dx * t;
      const z = fromZ + dz * t;
      for (const box of this.boxes) {
        if (!box.blocksZombies) continue;
        // Zombies are ~1.8m tall, so only waist-high-and-up geometry blocks sight.
        if (ignoreHeight && box.height > 0 && box.height < 1.2) continue;
        if (x > box.minX && x < box.maxX && z > box.minZ && z < box.maxZ) return false;
      }
    }
    return true;
  }
}
