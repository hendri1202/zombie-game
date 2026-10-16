import { describe, expect, it } from 'vitest';
import { Box3, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { HANDS_PLACEMENT, createFirstPersonHands, createGlovedHand } from '../src/player/proceduralArms';
import { WEAPONS } from '../src/app/gameConfig';

function meshesOf(root: import('three').Object3D): Mesh[] {
  const found: Mesh[] = [];
  root.traverse((child) => {
    const mesh = child as Mesh;
    if (mesh.isMesh) found.push(mesh);
  });
  return found;
}

describe('first-person hands', () => {
  it('builds a gloved hand with a palm, fingers and a thumb', () => {
    const hand = createGlovedHand();
    const meshes = meshesOf(hand);
    // Palm, four fingers, thumb.
    expect(meshes.length).toBe(6);
    for (const mesh of meshes) {
      const position = mesh.geometry.getAttribute('position');
      expect(position.count).toBeGreaterThan(0);
      expect(Number.isFinite(position.getX(0))).toBe(true);
    }
    const box = new Box3().setFromObject(hand);
    expect(box.isEmpty()).toBe(false);
    // Hand sized to a grip, not to a torso: roughly 10 cm across at most.
    const size = box.getSize(new Vector3());
    expect(size.x).toBeLessThan(0.2);
    expect(size.y).toBeLessThan(0.2);
    expect(size.z).toBeLessThan(0.2);
  });

  it('gives every mesh an emissive lift and keeps them out of the shadow pass', () => {
    for (const kind of ['pistol', 'rifle'] as const) {
      const hands = createFirstPersonHands(kind);
      const meshes = meshesOf(hands);
      expect(meshes.length).toBeGreaterThan(6);
      for (const mesh of meshes) {
        // Dusk lighting leaves an unlifted hand a black shape in the corner of the
        // screen, which is how the weapon view model was fixed too.
        const material = mesh.material as MeshStandardMaterial;
        expect(material.emissive.getHex()).toBeGreaterThan(0);
        // View-model geometry sits inside the camera and must not cast shadows.
        expect(mesh.castShadow).toBe(false);
        expect(mesh.receiveShadow).toBe(false);
        expect(mesh.frustumCulled).toBe(false);
      }
    }
  });

  it('puts the support hand further along the weapon for a rifle than for a pistol', () => {
    expect(HANDS_PLACEMENT.rifle.supportReach).toBeGreaterThan(HANDS_PLACEMENT.pistol.supportReach);
    const rifle = new Box3().setFromObject(createFirstPersonHands('rifle')).getSize(new Vector3());
    const pistol = new Box3().setFromObject(createFirstPersonHands('pistol')).getSize(new Vector3());
    expect(rifle.z).toBeGreaterThan(pistol.z);
    // The offsets are relative to the weapon and must stay small enough to keep the hands
    // near it: an absolute placement 30 cm below the weapon put them outside the frame.
    for (const kind of ['pistol', 'rifle'] as const) {
      for (const value of HANDS_PLACEMENT[kind].offset) expect(Math.abs(value)).toBeLessThan(0.12);
    }
  });

  it('has a hand pose declared for every weapon', () => {
    for (const id of Object.keys(WEAPONS) as Array<keyof typeof WEAPONS>) {
      expect(['pistol', 'rifle'], id).toContain(WEAPONS[id].grip);
      expect(HANDS_PLACEMENT[WEAPONS[id].grip]).toBeTruthy();
    }
  });
});
