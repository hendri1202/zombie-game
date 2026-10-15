import { describe, expect, it } from 'vitest';
import { AnimationClip, Group, Object3D } from 'three';
import { ZOMBIE_TYPES } from '../src/app/gameConfig';
import { Zombie } from '../src/zombies/Zombie';
import { ZombieAnimator } from '../src/zombies/ZombieAnimator';

/** Minimal stand-in for the factory's output: a root with two hitboxes. */
function makeZombie(): Zombie {
  const root = new Group();
  const body = new Object3D();
  body.name = 'body';
  root.add(body);
  const head = new Object3D();
  head.userData.hitZone = 'head';
  const torso = new Object3D();
  torso.userData.hitZone = 'body';
  root.add(head, torso);

  const clip = new AnimationClip('CharacterArmature|Idle', 1, []);
  const animator = new ZombieAnimator(body, [clip], ZOMBIE_TYPES.walker);
  const zombie = new Zombie(1, 'walker', ZOMBIE_TYPES.walker, root, animator);
  zombie.hitboxes.push(head, torso);
  return zombie;
}

describe('Zombie pooling', () => {
  it('keeps its hitboxes after being retired, so a pooled zombie stays hittable', () => {
    const zombie = makeZombie();
    zombie.reset(3, 4, 0);
    const scene = new Group();
    scene.add(zombie.root);
    expect(zombie.hitboxes.length).toBe(2);

    zombie.retire();
    // Detached from the scene, but still owned and still armed.
    expect(zombie.root.parent).toBeNull();
    expect(zombie.hitboxes.length).toBe(2);
    expect(zombie.hitboxes[0].parent).toBe(zombie.root);

    // Reused: reset must give a clean, live entity.
    zombie.reset(-8, 2, 1);
    scene.add(zombie.root);
    expect(zombie.isAlive).toBe(true);
    expect(zombie.health).toBe(ZOMBIE_TYPES.walker.maxHealth);
    expect(zombie.position.x).toBe(-8);
    expect(zombie.hitboxes.length).toBe(2);
  });

  it('releases hitboxes on final disposal', () => {
    const zombie = makeZombie();
    zombie.dispose();
    expect(zombie.hitboxes.length).toBe(0);
    expect(zombie.root.parent).toBeNull();
  });

  it('starts a revived zombie in the spawn state with full health', () => {
    const zombie = makeZombie();
    zombie.reset(0, 0, 0);
    zombie.applyDamage(ZOMBIE_TYPES.walker.maxHealth * 2);
    expect(zombie.isAlive).toBe(false);
    zombie.reset(5, 5, 0);
    expect(zombie.isAlive).toBe(true);
    expect(zombie.state).toBe('spawn');
  });
});
