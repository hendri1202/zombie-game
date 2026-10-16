import {
  BoxGeometry, Group, Mesh, MeshStandardMaterial, OctahedronGeometry, PointLight, Scene, TorusGeometry, Vector3,
} from 'three';
import {
  PICKUPS, RIFLE_UNLOCK_WAVE, SHOTGUN_UNLOCK_WAVE, SMG_UNLOCK_WAVE, WEAPONS, type WeaponId,
} from '../app/gameConfig';
import type { EventBus } from '../core/EventBus';
import type { GameEvents } from '../app/GameEvents';
import type { CollisionWorld } from '../level/CollisionWorld';
import type { RandomSource } from '../utils/math';

export type PickupType = 'medkit' | 'ammo' | 'weapon';

/**
 * Which weapon a drop hands over, in the order the weapons unlock.
 *
 * Newest-first was tried and is wrong: a player on wave six who never found a rifle would
 * be handed the shotgun and skip the ladder they are meant to climb. Returns null when
 * there is nothing left to give, and the drop falls through to the ordinary roll.
 */
export function weaponDropFor(wave: number, ownedWeapons: readonly WeaponId[]): WeaponId | null {
  if (wave >= RIFLE_UNLOCK_WAVE && !ownedWeapons.includes('rifle')) return 'rifle';
  if (wave >= SMG_UNLOCK_WAVE && !ownedWeapons.includes('smg')) return 'smg';
  if (wave >= SHOTGUN_UNLOCK_WAVE && !ownedWeapons.includes('shotgun')) return 'shotgun';
  return null;
}

interface Pickup {
  type: PickupType;
  weaponId: WeaponId | null;
  object: Group;
  position: Vector3;
  lifetime: number;
  bobPhase: number;
}

export interface PickupManagerDeps {
  scene: Scene;
  events: EventBus<GameEvents>;
  random: RandomSource;
  collision: CollisionWorld;
}

export interface PickupUpdateContext {
  playerX: number;
  playerZ: number;
  playerHealthFraction: number;
  ownedWeapons: readonly WeaponId[];
}

export interface PickupResult {
  healed: number;
  ammo: Array<{ weaponId: WeaponId; amount: number }>;
  weapon: WeaponId | null;
}

/**
 * Drops and collects pickups.
 *
 * Meshes are built procedurally so no third-party art is needed. Drops are
 * pushed out of solid geometry on creation, which stops medkits from spawning
 * inside a container where the player can never reach them.
 */
export class PickupManager {
  private readonly scene: Scene;
  private readonly events: EventBus<GameEvents>;
  private readonly random: RandomSource;
  private readonly collision: CollisionWorld;
  private readonly active: Pickup[] = [];
  private readonly geometries: {
    medkit: BoxGeometry; ammo: BoxGeometry; weapon: OctahedronGeometry; ring: TorusGeometry;
  };
  private readonly materials: { medkit: MeshStandardMaterial; ammo: MeshStandardMaterial; weapon: MeshStandardMaterial };
  private readonly group = new Group();
  private elapsed = 0;

  constructor(deps: PickupManagerDeps) {
    this.scene = deps.scene;
    this.events = deps.events;
    this.random = deps.random;
    this.collision = deps.collision;

    this.geometries = {
      medkit: new BoxGeometry(0.34, 0.34, 0.34),
      ammo: new BoxGeometry(0.28, 0.2, 0.4),
      weapon: new OctahedronGeometry(0.3, 0),
      ring: new TorusGeometry(0.45, 0.03, 6, 16),
    };
    this.materials = {
      medkit: new MeshStandardMaterial({ color: 0xff5a5a, emissive: 0x7a1010, emissiveIntensity: 0.7, roughness: 0.4 }),
      ammo: new MeshStandardMaterial({ color: 0xf0c060, emissive: 0x6a4a00, emissiveIntensity: 0.6, roughness: 0.5 }),
      weapon: new MeshStandardMaterial({ color: 0x8ad0ff, emissive: 0x1c5a80, emissiveIntensity: 0.8, roughness: 0.35 }),
    };
    this.group.name = 'pickups';
    this.scene.add(this.group);
  }

  get count(): number {
    return this.active.length;
  }

  get positions(): ReadonlyArray<{ x: number; z: number; type: PickupType }> {
    return this.active.map((pickup) => ({ x: pickup.position.x, z: pickup.position.z, type: pickup.type }));
  }

  /** Rolled on every kill. */
  rollDrop(x: number, z: number, currentHealthFraction: number, ownedWeapons: readonly WeaponId[], wave: number): void {
    if (this.active.length >= PICKUPS.maxActive) return;
    const roll = this.random.next();

    // Weapon drops arrive in the order the weapons unlock. The store will sell them
    // later; until it exists this is how the roster is reachable in play.
    const weapon = weaponDropFor(wave, ownedWeapons);
    if (weapon) {
      // The rifle keeps the wider chance it has always had: it is the one every run needs.
      const chance = weapon === 'rifle' ? PICKUPS.medkitChance * 3 : PICKUPS.medkitChance;
      if (roll < chance) {
        this.spawn('weapon', x, z, weapon);
        return;
      }
    }
    if (currentHealthFraction < 0.7 && roll < PICKUPS.medkitChance * 2) {
      this.spawn('medkit', x, z, null);
      return;
    }
    if (roll < PICKUPS.ammoChance) {
      this.spawn('ammo', x, z, null);
    }
  }

  spawn(type: PickupType, x: number, z: number, weaponId: WeaponId | null): void {
    if (this.active.length >= PICKUPS.maxActive) return;

    const position = new Vector3(x, 0, z);
    this.collision.resolveCircle(position, 0.6);

    const geometry = type === 'medkit' ? this.geometries.medkit : type === 'ammo' ? this.geometries.ammo : this.geometries.weapon;
    const material = type === 'medkit' ? this.materials.medkit : type === 'ammo' ? this.materials.ammo : this.materials.weapon;

    const object = new Group();
    const body = new Mesh(geometry, material);
    body.position.y = 0.55;
    body.castShadow = false;
    object.add(body);

    const ring = new Mesh(this.geometries.ring, material);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.08;
    object.add(ring);

    const light = new PointLight(type === 'medkit' ? 0xff6a6a : type === 'ammo' ? 0xffc060 : 0x7ac8ff, 3, 4, 2);
    light.position.y = 0.7;
    object.add(light);

    object.position.copy(position);
    this.group.add(object);

    this.active.push({
      type,
      weaponId,
      object,
      position,
      lifetime: PICKUPS.lifetimeSeconds,
      bobPhase: this.random.range(0, Math.PI * 2),
    });
    this.events.emit('pickup:spawned', { type });
  }

  update(delta: number, context: PickupUpdateContext): PickupResult {
    const result: PickupResult = { healed: 0, ammo: [], weapon: null };
    this.elapsed += delta;

    for (let i = this.active.length - 1; i >= 0; i -= 1) {
      const pickup = this.active[i];
      pickup.lifetime -= delta;
      pickup.object.position.y = Math.sin(this.elapsed * 2 + pickup.bobPhase) * 0.08;
      pickup.object.rotation.y += delta * 1.4;

      const dx = pickup.position.x - context.playerX;
      const dz = pickup.position.z - context.playerZ;
      const collected = dx * dx + dz * dz <= PICKUPS.pickupRadius * PICKUPS.pickupRadius;

      if (collected) {
        if (pickup.type === 'medkit') result.healed += PICKUPS.medkitHeal;
        else if (pickup.type === 'ammo') {
          for (const weaponId of context.ownedWeapons) result.ammo.push({ weaponId, amount: PICKUPS.ammoAmount });
        } else if (pickup.weaponId) {
          result.weapon = pickup.weaponId;
        }
        this.events.emit('pickup:collected', {
          type: pickup.type,
          label: pickup.type === 'weapon' && pickup.weaponId ? WEAPONS[pickup.weaponId].name : pickup.type,
        });
        this.removeAt(i);
        continue;
      }

      if (pickup.lifetime <= 0) this.removeAt(i);
    }

    return result;
  }

  private removeAt(index: number): void {
    const pickup = this.active[index];
    pickup.object.removeFromParent();
    const children = pickup.object.children;
    for (const child of children) {
      const light = child as PointLight;
      if (light.isPointLight) light.dispose();
    }
    this.active.splice(index, 1);
  }

  /**
   * Shows or hides every pickup.
   *
   * Gameplay items floating in the street are noise on the title screen, where the
   * only subject should be the character being chosen.
   */
  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  get visible(): boolean {
    return this.group.visible;
  }

  clear(): void {
    for (let i = this.active.length - 1; i >= 0; i -= 1) this.removeAt(i);
    this.active.length = 0;
  }

  dispose(): void {
    this.clear();
    this.scene.remove(this.group);
    this.geometries.medkit.dispose();
    this.geometries.ammo.dispose();
    this.geometries.weapon.dispose();
    this.geometries.ring.dispose();
    this.materials.medkit.dispose();
    this.materials.ammo.dispose();
    this.materials.weapon.dispose();
  }
}
