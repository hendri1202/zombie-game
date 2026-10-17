import { describe, expect, it } from 'vitest';
import { DoubleSide, Group, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { CollisionWorld, type CollisionBox } from '../src/level/CollisionWorld';
import { addGlassPanes, GLASS_PANES, GLASS_TAG, PROP_SPECS } from '../src/level/CityLevel';
import { MATERIAL_TAG_KEYWORDS, WORLD, materialForTag } from '../src/app/gameConfig';

/**
 * The glass impact profile was built and tested before the block contained a single
 * glass surface, so it could never fire in play. These tests hold the level to the
 * other half of that promise: glass exists, its tag is the one `ImpactEffects`
 * actually resolves, the panes sit inside the world, and the tag collides with
 * nothing already in use.
 *
 * The tag is imported from `CityLevel` and put through the real `materialForTag`
 * rather than copied as a string: a copied tag would keep passing after the
 * classifier's keyword list changed, which is the exact drift this guards against.
 *
 * The panes are built through the same `addGlassPanes` the level calls, into a level's
 * own bounds, so there is no second copy of the placement logic to go stale.
 */

function buildGlass(): { group: Group; collision: CollisionWorld; placed: number } {
  const group = new Group();
  group.name = 'glass';
  // The level's own bounds, so "inside the world" is the level's definition of it.
  const collision = new CollisionWorld({ ...WORLD.playArea });
  const placed = addGlassPanes(group, collision, true);
  return { group, collision, placed };
}

function glassBoxes(collision: CollisionWorld): CollisionBox[] {
  return collision.boxes.filter((box) => box.tag === GLASS_TAG);
}

function paneMeshes(group: Group): Mesh[] {
  return group.children.filter((child): child is Mesh => child instanceof Mesh);
}

describe('the city block contains shootable glass', () => {
  it('places at least three panes, each tagged as the impact classifier reads glass', () => {
    const { collision, placed } = buildGlass();
    const boxes = glassBoxes(collision);

    expect(placed).toBeGreaterThanOrEqual(3);
    expect(boxes.length).toBe(placed);
    // The classifier, not a copied string: if the glass keywords ever stopped
    // matching this tag, every pane would quietly go back to throwing default dust.
    expect(materialForTag(GLASS_TAG)).toBe('glass');
    expect(MATERIAL_TAG_KEYWORDS.glass.some((keyword) => GLASS_TAG.toLowerCase().includes(keyword))).toBe(true);
    for (const box of boxes) expect(materialForTag(box.tag), box.tag).toBe('glass');
  });

  it('keeps every glass box inside the play area and tall enough to shoot at eye level', () => {
    for (const box of glassBoxes(buildGlass().collision)) {
      expect(box.minX).toBeGreaterThanOrEqual(WORLD.playArea.minX);
      expect(box.maxX).toBeLessThanOrEqual(WORLD.playArea.maxX);
      expect(box.minZ).toBeGreaterThanOrEqual(WORLD.playArea.minZ);
      expect(box.maxZ).toBeLessThanOrEqual(WORLD.playArea.maxZ);
      // Height 0 means "full height" in the collision world; glass has to be a real
      // volume or a bullet at 1.6 m passes over or through it.
      expect(box.height).toBeGreaterThan(1.2);
      expect(box.height).toBeLessThan(4);
      expect(box.blocksPlayer).toBe(true);
      expect(box.blocksZombies).toBe(true);
    }
  });

  it('mirrors each pane in the collision world, so the glass you see is the glass you hit', () => {
    const { group, collision } = buildGlass();
    const meshes = paneMeshes(group);

    expect(meshes.length).toBe(GLASS_PANES.length);
    // Distinct debug names: the panes must be identifiable in the collision overlay.
    expect(new Set(meshes.map((mesh) => mesh.name)).size).toBe(meshes.length);

    GLASS_PANES.forEach((pane, index) => {
      const mesh = meshes[index];
      expect(mesh.position.x).toBeCloseTo(pane.x, 5);
      expect(mesh.position.z).toBeCloseTo(pane.z, 5);
      // Rests on the ground: half its height above y = 0.
      expect(mesh.position.y).toBeCloseTo(pane.height / 2, 5);

      const box = collision.boxes.find((candidate) => candidate.tag === GLASS_TAG
        && Math.abs((candidate.minX + candidate.maxX) / 2 - pane.x) < 1e-6
        && Math.abs((candidate.minZ + candidate.maxZ) / 2 - pane.z) < 1e-6);
      expect(box, `pane ${index}`).toBeDefined();
      expect(box?.height).toBeCloseTo(mesh.scale.y, 5);
    });
  });

  it('gives a ray from the street a glass hit, so the profile reaches the gun', () => {
    // combat:world-hit carries the tag of whatever CollisionWorld.raycast returns; if
    // this ray reports the glass tag, ImpactEffects picks the glass profile for it.
    const { collision } = buildGlass();
    for (const pane of GLASS_PANES) {
      const side = Math.sign(pane.x);
      const origin = new Vector3(pane.x - side * 8, 1.6, pane.z);
      const hit = collision.raycast(origin, new Vector3(side, 0, 0), 30);
      expect(hit, `pane at ${pane.x}, ${pane.z}`).not.toBeNull();
      expect(hit?.tag).toBe(GLASS_TAG);
      expect(materialForTag(hit?.tag ?? '')).toBe('glass');
    }
  });

  it('does not reuse a tag the block already writes', () => {
    // Every existing tag maps to a tested non-glass profile; a pane sharing one of
    // them would change what a container or a wall throws when it is shot.
    const existing = ['building', 'perimeter', ...PROP_SPECS.map((spec) => `prop:${spec.name}`)];
    expect(existing).not.toContain(GLASS_TAG);
    for (const tag of existing) expect(materialForTag(tag), tag).not.toBe('glass');
  });

  it('builds the panes in code as translucent, bluish meshes that read at night', () => {
    const meshes = paneMeshes(buildGlass().group);
    expect(meshes.length).toBeGreaterThanOrEqual(3);

    for (const mesh of meshes) {
      const material = mesh.material as MeshStandardMaterial;
      expect(material.transparent).toBe(true);
      expect(material.opacity).toBeGreaterThan(0.1);
      expect(material.opacity).toBeLessThan(1);
      // Bluish: the blue channel leads, so it never reads as concrete grey.
      expect(material.color.b).toBeGreaterThan(material.color.r);
      // The street is unlit at night; glass with no emissive reads as a black hole.
      expect(material.emissiveIntensity).toBeGreaterThan(0);
      // Shot from either side of the street, so both faces have to be drawn.
      expect(material.side).toBe(DoubleSide);
      // A pane, not a slab: one axis is far thinner than the other two.
      const axes = [mesh.scale.x, mesh.scale.y, mesh.scale.z].sort((a, b) => a - b);
      expect(axes[2]).toBeGreaterThan(axes[0] * 10);
    }
  });
});
