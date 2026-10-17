import { describe, expect, it } from 'vitest';
import { Box3, Group, Matrix4, Mesh, Object3D, PerspectiveCamera, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { GRENADES, MELEE, WEAPONS, WEAPON_FEEL, type MeleeId, type WeaponId } from '../src/app/gameConfig';
import {
  OPTICS, opticVisibleFor, reticleFor, reticleShownFor, type OpticKind,
} from '../src/app/opticsConfig';
import { EventBus } from '../src/core/EventBus';
import type { GameEvents } from '../src/app/GameEvents';
import { HUD, type HudState } from '../src/ui/HUD';
import type { DamageSystem } from '../src/combat/DamageSystem';
import type { MeleeSystem } from '../src/combat/MeleeSystem';
import { WeaponController } from '../src/player/WeaponController';
import { measureWeaponFrame } from '../src/player/weaponMechanism';
import { normalizeViewModel } from '../src/player/viewModel';
import {
  OPTIC_MESH_PREFIX, hasExistingOptic, mountOptic, opticParts,
} from '../src/player/opticMeshes';
import type { PlayerController } from '../src/player/PlayerController';
import { MP7_DESCRIPTOR, createMp7 } from '../src/player/weapons/mp7';
import { AUG_DESCRIPTOR, createAug } from '../src/player/weapons/aug';
import { REMINGTON870_DESCRIPTOR } from '../src/player/weapons/remington870';

/**
 * The aiming sight: the reticle table, the rule that decides when it is up, and the optic body
 * mounted on the weapons whose meshes have no sight of their own.
 *
 * These are measuring tests. This host has no browser and the work order forbids driving one
 * (and the five other features being built alongside this one are why), so nothing here can
 * say what a reticle *looks* like. What it can hold to, and therefore what it does hold to, is
 * everything the feature promised as a fact: the pistol draws nothing at all; every other
 * firearm has a mark with a real colour and real numbers; a mark is up exactly when the player
 * is aiming with a weapon that has one, and never for melee, the grenade, released sights or a
 * weapon that has none; the optic body exists as separate, consistently named geometry on the
 * weapons that need it; it does not move the weapon's own meshes, the muzzle offset or a single
 * ballistic value; and it stops short of the barrel's tip, so it can never cover the muzzle the
 * flash and the tracer leave from.
 *
 * The mesh tests load the shipped glTF files through the same `GLTFLoader` and the same
 * `normalizeViewModel` the game calls, so nothing is measured against a hand-made stand-in.
 */

// The pack's files carry embedded textures, and GLTFLoader decodes them through browser
// globals node does not have. Only geometry is measured here, so stub bitmaps are enough.
(globalThis as unknown as { self?: unknown }).self = globalThis;
if (typeof globalThis.ProgressEvent !== 'function') {
  (globalThis as unknown as { ProgressEvent: unknown }).ProgressEvent = class ProgressEvent {
    constructor(public type: string, init: Record<string, unknown> = {}) {
      Object.assign(this, init);
    }
  };
}
if (typeof globalThis.createImageBitmap !== 'function') {
  (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap =
    async () => ({ width: 1, height: 1, close() {} });
}

const WEAPON_FILES = import.meta.glob('/public/assets/weapons/*.gltf', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

const FIREARMS = Object.keys(WEAPONS) as WeaponId[];
/** Weapons the table currently asks for an optic body on, from the game's own roster. */
const WITH_HOUSING: WeaponId[] = FIREARMS.filter((id) => reticleFor(id)?.housing != null);

function fileFor(modelPath: string): string {
  const name = modelPath.split('/').pop() ?? '';
  const key = Object.keys(WEAPON_FILES).find((candidate) => candidate.endsWith(`/${name}`));
  expect(key, `${modelPath} is not among the shipped weapon files`).toBeTruthy();
  return WEAPON_FILES[key ?? ''];
}

async function load(modelPath: string): Promise<Group> {
  const loader = new GLTFLoader();
  const gltf = await new Promise<{ scene: Group }>((resolve, reject) => {
    loader.parse(fileFor(modelPath), '', resolve, reject);
  });
  return gltf.scene;
}

let templatesPromise: Promise<Map<WeaponId, Object3D>> | null = null;
function modelTemplates(): Promise<Map<WeaponId, Object3D>> {
  templatesPromise ??= (async () => {
    const models = new Map<WeaponId, Object3D>();
    for (const id of FIREARMS) models.set(id, normalizeViewModel(await load(WEAPONS[id].modelPath)));
    return models;
  })();
  return templatesPromise;
}

/**
 * A private copy of every firearm's view model, normalised as the game normalises it.
 *
 * A clone per caller: `mountOptic` parents a housing to the mesh it was handed, so two tests
 * sharing one model would count each other's sights and measure a gun wearing two of them.
 */
async function firearmModels(): Promise<Map<WeaponId, Object3D>> {
  const templates = await modelTemplates();
  const models = new Map<WeaponId, Object3D>();
  for (const [id, template] of templates) models.set(id, template.clone(true));
  return models;
}

interface Rig {
  weapons: WeaponController;
  models: Map<WeaponId, Object3D>;
}

/** A controller over the real meshes, so the optics are the ones the game would mount. */
async function rig(): Promise<Rig> {
  const models = await firearmModels();
  const camera = new PerspectiveCamera(76, 16 / 9, 0.08, 420);
  camera.position.set(0, 1.62, 0);
  camera.updateMatrixWorld(true);
  const weapons = new WeaponController({
    camera,
    events: new EventBus<GameEvents>(),
    damage: {
      fire: () => ({ target: 'none', zone: 'body', killed: false, kind: null, damage: 0 }),
    } as unknown as DamageSystem,
    player: {
      eyePosition: new Vector3(0, 1.62, 0),
      facingAngle: 0,
      addRecoil: () => {},
    } as unknown as PlayerController,
    melee: {
      swing: () => ({ target: 'none', targetId: null, damage: 0 }),
    } as unknown as MeleeSystem,
    viewModels: models,
  });
  for (const id of FIREARMS) weapons.grantWeapon(id);
  return { weapons, models };
}

/** Switches weapon and lets the equip drop play out before anything is measured. */
function equip(weapons: WeaponController, id: WeaponId): void {
  weapons.switchTo(id);
  weapons.update(0.3, null, true);
}

/** Vertices belonging to the weapon's own meshes, i.e. everything this feature did not add. */
function ownVertices(root: Object3D): number {
  let total = 0;
  root.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    if (mesh.name.startsWith(OPTIC_MESH_PREFIX)) return;
    total += mesh.geometry.getAttribute('position').count;
  });
  return total;
}

/**
 * The furthest any vertex reaches along a direction, in the model's own local space.
 *
 * Written out rather than taken from a bounding box: the SMG's shipped mesh runs diagonally
 * across its own XZ plane, so an axis-aligned box would answer "how far forward is the front
 * corner", not "how far along the barrel". `axis` and `origin` come from `measureWeaponFrame`
 * on the *clean* model, which is the same frame the housing was placed against.
 */
function furthestAlong(
  root: Object3D,
  axis: Vector3,
  origin: Vector3,
  filter: (mesh: Mesh) => boolean = () => true,
): number {
  root.updateMatrixWorld(true);
  const toLocal = new Matrix4().copy(root.matrixWorld).invert();
  const vertex = new Vector3();
  let best = Number.NEGATIVE_INFINITY;
  root.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    if (!filter(mesh)) return;
    const position = mesh.geometry.getAttribute('position');
    if (!position) return;
    const matrix = new Matrix4().multiplyMatrices(toLocal, mesh.matrixWorld);
    for (let index = 0; index < position.count; index += 1) {
      vertex.fromBufferAttribute(position, index).applyMatrix4(matrix);
      best = Math.max(best, vertex.sub(origin).dot(axis));
    }
  });
  return best;
}

const KINDS: readonly OpticKind[] = ['none', 'bead', 'dot', 'chevron', 'cross'];

describe('the reticle table', () => {
  it('answers for every firearm, and for nothing the game does not have', () => {
    // The weapons the game ships, plus the melee weapons and the grenade — the whole id space a
    // reticle question can be asked about. A row for anything else would be a row for a weapon
    // that does not exist, which is the drift this check exists to catch.
    const known = new Set<string>([
      ...FIREARMS,
      ...(Object.keys(MELEE) as MeleeId[]),
      ...Object.keys(GRENADES),
      MP7_DESCRIPTOR.id,
      AUG_DESCRIPTOR.id,
      REMINGTON870_DESCRIPTOR.id,
    ]);

    for (const id of FIREARMS) expect(OPTICS[id], `${id} has no row in the reticle table`).toBeTruthy();
    for (const id of Object.keys(OPTICS)) {
      expect(known.has(id), `the reticle table holds "${id}", which is not a weapon the game has`)
        .toBe(true);
    }
    // The three extras are the ones those descriptors declare, so the table cannot invent an
    // id and a rename in the weapon modules cannot leave a stale row behind.
    expect(reticleFor(MP7_DESCRIPTOR.id)?.kind).toBe('dot');
    expect(reticleFor(AUG_DESCRIPTOR.id)?.kind).toBe('cross');
    expect(reticleFor(REMINGTON870_DESCRIPTOR.id)?.kind).toBe('bead');
  });

  it('gives the pistol no reticle at all, by an explicit decision', () => {
    // Not an omission: the row exists so the file answers "what is on the pistol's sights?"
    // with a decision, and the decision is that there is nothing to aim through.
    expect(OPTICS.pistol.kind).toBe('none');
    expect(reticleFor('pistol')).toBeNull();
    expect(OPTICS.pistol.size).toBe(0);
    expect(OPTICS.pistol.housing).toBeNull();
    // And it keeps the plain crosshair: nothing about the pistol draws a lens or a dot.
    expect(reticleShownFor('pistol', true)).toBeNull();
  });

  it('never gives a melee weapon or the grenade a reticle', () => {
    for (const id of Object.keys(MELEE) as MeleeId[]) {
      expect(reticleFor(id), `${id} is not something you aim down`).toBeNull();
      expect(opticVisibleFor(id, true), id).toBe(false);
      expect((OPTICS as Record<string, unknown>)[id], id).toBeUndefined();
    }
    for (const id of Object.keys(GRENADES)) {
      expect(reticleFor(id), `${id} is thrown, not aimed`).toBeNull();
      expect(opticVisibleFor(id, true), id).toBe(false);
    }
  });

  it('is total: an id the table does not hold answers null instead of throwing', () => {
    // A frame must never break because the reticle asked a question with no answer.
    expect(reticleFor(null)).toBeNull();
    expect(reticleFor(undefined)).toBeNull();
    expect(reticleFor('')).toBeNull();
    expect(reticleFor('no-such-weapon')).toBeNull();
    expect(reticleShownFor('no-such-weapon', true)).toBeNull();
    expect(opticVisibleFor(null, true)).toBe(false);
  });

  it('draws a real mark, with real numbers, for every weapon that has one', () => {
    for (const [id, spec] of Object.entries(OPTICS)) {
      expect(KINDS, id).toContain(spec.kind);
      // A weapon with no mark is the pistol, and only the pistol: every other row draws one.
      if (spec.kind === 'none') {
        expect(id, 'only the pistol comes up with no sight').toBe('pistol');
        continue;
      }
      expect(spec.color, `${id}: no colour`).toMatch(/^#[0-9a-f]{6}$/i);
      // Positive, not merely present: a mark of zero size is a sight you cannot see, which is
      // the failed state this whole feature exists to avoid.
      expect(spec.size, `${id}: no size`).toBeGreaterThan(0);
      expect(spec.thickness, `${id}: no thickness`).toBeGreaterThan(0);
      expect(spec.gap, `${id}: negative gap`).toBeGreaterThanOrEqual(0);
      // A cross whose gap is half its own span has no arms left at all.
      expect(spec.gap * 2, `${id}: the arms close up`).toBeLessThan(spec.size);
      // And it is a mark the player can see without hunting for it.
      expect(spec.size, `${id}: too small to read`).toBeGreaterThanOrEqual(5);
    }
  });

  it('splits the marks by weapon class the way the owner asked', () => {
    // Close quarters: a dot.
    for (const id of ['smg', 'mp5', 'mp7'] as const) {
      expect(reticleFor(id)?.kind, id).toBe('dot');
    }
    // Range: a cross, on both rifles.
    expect(reticleFor('rifle')?.kind).toBe('cross');
    expect(reticleFor('aug')?.kind).toBe('cross');
    // The PDW is aimed like an SMG, not like a rifle.
    expect(reticleFor('p90')?.kind).toBe('dot');
    // The belt-fed gun: a chevron, and the largest mark in the game.
    expect(reticleFor('lmg')?.kind).toBe('chevron');
    const lmg = reticleFor('lmg');
    for (const id of FIREARMS) {
      if (id === 'lmg') continue;
      const other = reticleFor(id);
      if (!other) continue;
      expect((lmg?.size ?? 0), `the LMG's mark must read bigger than ${id}'s`)
        .toBeGreaterThan(other.size);
    }
    // Pump guns point rather than aim: a bead, and no optic body on either.
    expect(reticleFor('shotgun')?.kind).toBe('bead');
    expect(reticleFor('remington-870')?.kind).toBe('bead');
    expect(OPTICS.shotgun.housing).toBeNull();
    expect(OPTICS['remington-870'].housing).toBeNull();
    // No second optic where a mesh already ships a sight.
    expect(OPTICS.aug.housing, 'the AUG ships its own scope').toBeNull();
    expect(OPTICS.p90.housing, 'the P90 ships an integrated optic').toBeNull();
    expect(OPTICS.pistol.housing).toBeNull();
  });

  it('shows a mark exactly while the sights are up, and only on a weapon that has one', () => {
    // The whole visibility rule, as a truth table. Every case the reticle must not appear in is
    // one row here rather than an exception somewhere in the HUD.
    expect(opticVisibleFor('rifle', true)).toBe(true);
    expect(opticVisibleFor('rifle', false)).toBe(false);
    expect(opticVisibleFor('pistol', true)).toBe(false);
    expect(opticVisibleFor('pistol', false)).toBe(false);
    expect(opticVisibleFor('knife', true)).toBe(false);
    expect(opticVisibleFor('frag', true)).toBe(false);
    expect(opticVisibleFor(null, true)).toBe(false);
    expect(opticVisibleFor(null, false)).toBe(false);

    // And the spec the HUD paints is the row itself, so the numbers drawn are the numbers
    // tested above rather than a second copy of them.
    expect(reticleShownFor('rifle', true)).toBe(OPTICS.rifle);
    expect(reticleShownFor('rifle', false)).toBeNull();
    // Every row the table holds with a mark draws that very row with the sights up; the pistol
    // — the one `none` row — draws nothing, and so does everything the table does not hold.
    for (const [id, row] of Object.entries(OPTICS)) {
      expect(reticleShownFor(id, true) === null, id).toBe(row.kind === 'none');
    }
    for (const id of [...Object.keys(MELEE), ...Object.keys(GRENADES)]) {
      expect(reticleShownFor(id, true), id).toBeNull();
    }
  });
});

describe('the optic body on the shipped meshes', () => {
  it('mounts one named housing on every weapon that needs one, and none on the rest',
    async () => {
      const models = await firearmModels();
      // The weapons the table asks for a housing on, over the roster the game actually ships.
      const wanted: WeaponId[] = [];
      for (const id of FIREARMS) {
        const model = models.get(id) as Object3D;
        const spec = reticleFor(id);
        const needsOne = spec?.housing != null && !hasExistingOptic(model);
        const optic = mountOptic(model, id);
        const parts = opticParts(model);

        if (needsOne) {
          wanted.push(id);
          expect(optic, `${id} needs a sight and got none`).not.toBeNull();
          expect(optic?.group.name, id).toBe(`${OPTIC_MESH_PREFIX}${id}`);
          expect(optic?.group.parent, `${id}: the sight is not on the weapon`).toBe(model);
          expect(parts.length, id).toBeGreaterThan(0);
          for (const part of parts) {
            // One convention for every part this feature adds, so a diagnostic (or a later
            // feature) can tell its meshes from the weapon's own without guessing.
            expect(part.name.startsWith(OPTIC_MESH_PREFIX), part.name).toBe(true);
            expect(part.name.length, part.name).toBeGreaterThan(OPTIC_MESH_PREFIX.length);
            expect(part.geometry.getAttribute('position').count, part.name).toBeGreaterThan(0);
            expect(part.castShadow, part.name).toBe(false);
          }
        } else {
          expect(optic, `${id} was given a sight it should not have`).toBeNull();
          expect(parts, `${id} was given parts without a housing`).toHaveLength(0);
        }

        // Idempotent: mounting again leaves one sight rather than a stack of them.
        mountOptic(model, id);
        expect(opticParts(model).length, `${id}: mounted twice`).toBe(parts.length);
      }
      expect(wanted.length, 'no weapon got a sight at all').toBeGreaterThan(0);
      expect(wanted.sort()).toEqual([...WITH_HOUSING].sort());
      // The pistol (no sight) and the shotgun (a bead is an iron sight) are the two the table
      // deliberately leaves alone.
      expect(wanted).not.toContain('pistol');
      expect(wanted).not.toContain('shotgun');
    });

  it('refuses to add a second sight to a mesh that already names a scope', async () => {
    // The AUG's own optic is named, so the guard catches it even if a later edit gave it a
    // `housing` row by mistake.
    const aug = createAug();
    expect(hasExistingOptic(aug), 'the AUG ships AugScopeTube').toBe(true);
    expect(mountOptic(aug, 'aug')).toBeNull();
    expect(opticParts(aug)).toHaveLength(0);

    // And a mesh whose sight is unnamed is covered by the table instead: the P90's integrated
    // optic has no node name to find, which is why its row carries `housing: null`.
    const p90 = normalizeViewModel(await load(WEAPONS.p90.modelPath));
    expect(mountOptic(p90, 'p90')).toBeNull();
    expect(opticParts(p90)).toHaveLength(0);

    // The MP7, whose iron sights are named but are not an optic, does get one: a red dot is
    // the sight it is missing, not a sight it already has.
    const mp7 = createMp7();
    expect(hasExistingOptic(mp7)).toBe(false);
    expect(mountOptic(mp7, 'mp7')?.group.name).toBe(`${OPTIC_MESH_PREFIX}mp7`);
  });

  it('leaves the weapon itself exactly where it was', async () => {
    const models = await firearmModels();
    for (const id of WITH_HOUSING) {
      const model = models.get(id) as Object3D;
      const positionBefore = model.position.clone();
      const quaternionBefore = model.quaternion.clone();
      const scaleBefore = model.scale.clone();
      const verticesBefore = ownVertices(model);

      const optic = mountOptic(model, id);
      expect(optic, id).not.toBeNull();
      if (!optic) continue;

      // The muzzle the flash and the tracer leave from is the view-model holder's position
      // plus the fixed `WEAPON_FEEL.muzzleOffset`. Neither is touched here — the holder is not
      // even reachable from this module — so what has to hold is that the mesh the holder
      // carries is unchanged: same root transform, same number of vertices in the weapon's own
      // meshes, and one new child that is the sight.
      expect(model.position.toArray(), id).toEqual(positionBefore.toArray());
      expect(model.quaternion.toArray(), id).toEqual(quaternionBefore.toArray());
      expect(model.scale.toArray(), id).toEqual(scaleBefore.toArray());
      expect(ownVertices(model), `${id}: the weapon was reshaped`).toBe(verticesBefore);
    }

    // And the other half of that argument, pinned as the number it is: the muzzle the flash and
    // the tracer leave from is this fixed offset from the holder, so an offset that had moved
    // would move the muzzle whatever the meshes did. View-model-framing holds the flash at or
    // beyond every barrel tip, and the test above holds this feature behind every barrel tip.
    expect(WEAPON_FEEL.muzzleOffset).toEqual([0, 0.03, -0.36]);
  });

  it('stops short of the barrel tip, so it can never cover the muzzle', async () => {
    const models = await firearmModels();
    for (const id of WITH_HOUSING) {
      const model = models.get(id) as Object3D;
      // The frame of the *clean* weapon: axis, the rear end of the body, and its length along
      // that axis. The barrel's tip is at `length` from the rear.
      const frame = measureWeaponFrame(model);
      const rear = frame.pointAt(0, new Vector3());
      const axis = frame.axis.clone();
      const bodyTip = furthestAlong(model, axis, rear);
      expect(bodyTip, id).toBeGreaterThan(0);

      const optic = mountOptic(model, id);
      expect(optic, id).not.toBeNull();
      if (!optic) continue;

      const housing = furthestAlong(
        model, axis, rear, (mesh) => mesh.name.startsWith(OPTIC_MESH_PREFIX),
      );
      // The sight is behind the barrel's tip, and by a wide margin rather than by a hair: the
      // tube is 16% of the body and sits over the receiver.
      expect(housing, `${id}: the sight reaches past the barrel tip`).toBeLessThan(bodyTip * 0.9);
      // The same number the report carries, measured rather than restated: a report that
      // disagreed with the geometry would be worse than no report.
      expect(housing, id).toBeCloseTo(optic.forwardReach, 4);
      expect(optic.bodyLength, id).toBeCloseTo(bodyTip, 4);
      expect(optic.muzzleClearance, id).toBeGreaterThan(0);
      expect(optic.muzzleClearance, id).toBeCloseTo(bodyTip - housing, 4);
    }
  });

  it('sits on top of the receiver, not beside it', async () => {
    const models = await firearmModels();
    for (const id of WITH_HOUSING) {
      const model = models.get(id) as Object3D;
      const body = new Box3().setFromObject(model);
      const frame = measureWeaponFrame(model);
      const optic = mountOptic(model, id);
      expect(optic, id).not.toBeNull();
      if (!optic) continue;

      // Above the body's own centre line at the station it was placed at, which is what makes
      // it a sight rather than a box glued to the side of the weapon.
      expect(optic.group.position.y, id).toBeGreaterThan(frame.centreAt(optic.station));
      // And within the weapon's own horizontal footprint: on the receiver, not off the frame.
      expect(optic.group.position.x, id).toBeGreaterThanOrEqual(body.min.x);
      expect(optic.group.position.x, id).toBeLessThanOrEqual(body.max.x);
      expect(optic.group.position.z, id).toBeGreaterThanOrEqual(body.min.z);
      expect(optic.group.position.z, id).toBeLessThanOrEqual(body.max.z);
    }
  });

  it('is mounted by the controller, after the moving parts, on the right weapons', async () => {
    const { weapons } = await rig();
    const report = weapons.opticReport.weapons;
    expect(report.map((entry) => entry.weaponId).sort()).toEqual([...WITH_HOUSING].sort());
    for (const entry of report) {
      expect(entry.meshName, entry.weaponId).toBe(`${OPTIC_MESH_PREFIX}${entry.weaponId}`);
      expect(entry.parts, entry.weaponId).toBeGreaterThan(0);
      expect(entry.kind, entry.weaponId).toBe(reticleFor(entry.weaponId)?.kind);
      expect(entry.station, entry.weaponId).toBeGreaterThan(0);
      expect(entry.station, entry.weaponId).toBeLessThan(1);
      expect(entry.bodyLength, entry.weaponId).toBeGreaterThan(0);
      expect(entry.forwardReach, entry.weaponId).toBeLessThan(entry.bodyLength);
      expect(entry.muzzleClearance, entry.weaponId).toBeGreaterThan(0);
    }
    // Nothing on the weapons the table leaves sightless.
    for (const id of ['pistol', 'shotgun'] as WeaponId[]) {
      expect(report.find((entry) => entry.weaponId === id), id).toBeUndefined();
    }
  });

  it('does not disturb the mechanism, the magazine or the sight’s own pose', async () => {
    const { weapons, models } = await rig();
    const partsByWeapon = weapons.mechanismReport.weapons.map((entry) => [entry.weaponId, entry.parts]);
    // A sight is not a second moving part: the mechanism report is exactly as it was.
    expect(partsByWeapon).toHaveLength(FIREARMS.length);
    for (const [id, parts] of partsByWeapon) expect(parts, String(id)).toBe(1);

    const optic = opticParts(models.get('rifle') as Object3D)[0];
    expect(optic, 'the rifle has no sight').toBeTruthy();
    const sightPosition = optic.position.clone();

    equip(weapons, 'rifle');
    const magazineBefore = weapons.snapshot.magazine;
    expect(weapons.tryFire(), 'the shot was refused').not.toBeNull();
    for (let step = 0; step < 40; step += 1) weapons.update(0.004, null, true);
    // One round spent and one only: the sight is a thing to look through, not a second shot.
    expect(weapons.snapshot.magazine).toBe(magazineBefore - 1);
    // The bolt racked (the part moved) and the sight did not: a housing that travelled with the
    // receiver would be a sight that slides off the gun with every round.
    const mechanism = weapons.mechanismReport.weapons.find((entry) => entry.weaponId === 'rifle');
    expect(mechanism, 'the rifle has no mechanism').toBeTruthy();
    expect(optic.position.toArray(), 'the sight moved').toEqual(sightPosition.toArray());
  });
});

/**
 * The HUD's own half of the wiring.
 *
 * The rule is tested above as a pure function; this is what proves the *element* follows it,
 * because a rule nothing paints is a feature that only looks implemented. There is no DOM here
 * (this host has no browser and the vitest config runs the suite in node), so the HUD is handed
 * the smallest stand-in that supports what it touches — getElementById, a class list, a style
 * map and a dataset. That is deliberately not jsdom: the question is only which classes and
 * custom properties the HUD writes, and a real DOM would answer it no differently.
 */
class FakeElement {
  readonly classes = new Set<string>();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, unknown> = {};
  textContent = '';
  className = '';
  offsetWidth = 0;

  constructor(readonly id: string) {
    // The HUD writes custom properties with setProperty and plain values (width, transform) as
    // object fields; both land in the same map, so a test can read either back.
    this.style.setProperty = (name: string, value: string): void => {
      this.style[name] = value;
    };
  }

  readonly classList = {
    add: (name: string): void => { this.classes.add(name); },
    remove: (name: string): void => { this.classes.delete(name); },
    contains: (name: string): boolean => this.classes.has(name),
    toggle: (name: string, force?: boolean): boolean => {
      const wanted = force ?? !this.classes.has(name);
      if (wanted) this.classes.add(name);
      else this.classes.delete(name);
      return wanted;
    },
  };

  setAttribute(): void {}
}

/** A HUD over stub elements, plus the elements it was given, so they can be read back. */
function stubHud(): { hud: HUD; elements: Map<string, FakeElement> } {
  const elements = new Map<string, FakeElement>();
  const stubDocument = {
    getElementById: (id: string): FakeElement => {
      let element = elements.get(id);
      if (!element) {
        element = new FakeElement(id);
        elements.set(id, element);
      }
      return element;
    },
  };
  const previous = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = stubDocument;
  try {
    return { hud: new HUD(new EventBus<GameEvents>()), elements };
  } finally {
    (globalThis as { document?: unknown }).document = previous;
  }
}

/** A complete HUD state, so a test only states the two fields it is about. */
function hudState(overrides: Partial<HudState> = {}): HudState {
  return {
    health: 100,
    ammo: 30,
    reserve: 120,
    weaponName: 'Assault rifle',
    meleeName: 'Combat Knife',
    melee: false,
    ordnanceName: 'Frag Grenade',
    ordnance: false,
    grenades: 2,
    kills: 0,
    wave: 1,
    remaining: 0,
    points: 0,
    reloading: false,
    spread: 0,
    objective: '',
    objectiveAngle: 0,
    objectiveActive: false,
    opticWeaponId: 'rifle',
    aiming: false,
    ...overrides,
  };
}

describe('the reticle element follows the rule', () => {
  it('paints the mark the table names, with the table own numbers', () => {
    const { hud, elements } = stubHud();
    const optic = elements.get('optic') as FakeElement;
    const crosshair = elements.get('crosshair') as FakeElement;

    // Down before anything is aimed: the element ships hidden in index.html and nothing has
    // switched it on yet.
    expect(optic.classList.contains('visible')).toBe(false);

    hud.update(0.016, hudState({ opticWeaponId: 'rifle', aiming: true }));
    expect(optic.classList.contains('visible'), 'the rifle has a sight and is not showing it')
      .toBe(true);
    expect(optic.dataset.kind).toBe(OPTICS.rifle.kind);
    // The numbers are the table's, not a second copy of them in the HUD.
    expect(optic.style['--optic-size']).toBe(`${OPTICS.rifle.size}px`);
    expect(optic.style['--optic-thickness']).toBe(`${OPTICS.rifle.thickness}px`);
    expect(optic.style['--optic-gap']).toBe(`${OPTICS.rifle.gap}px`);
    expect(optic.style['--optic-color']).toBe(OPTICS.rifle.color);
    // And the plain crosshair is out of the way, so the two aiming marks never overlap.
    expect(crosshair.classList.contains('sighted')).toBe(true);
  });

  it('switches mark when the weapon changes, sizes included', () => {
    const { hud, elements } = stubHud();
    const optic = elements.get('optic') as FakeElement;

    // Two weapons share a kind and differ in size: the element has to be repainted between
    // them, or the MP5 would be drawn with the compact SMG's dot.
    hud.update(0.016, hudState({ opticWeaponId: 'smg', aiming: true }));
    expect(optic.dataset.kind).toBe('dot');
    expect(optic.style['--optic-size']).toBe(`${OPTICS.smg.size}px`);
    hud.update(0.016, hudState({ opticWeaponId: 'mp5', aiming: true }));
    expect(optic.dataset.kind).toBe('dot');
    expect(optic.style['--optic-size']).toBe(`${OPTICS.mp5.size}px`);
    hud.update(0.016, hudState({ opticWeaponId: 'lmg', aiming: true }));
    expect(optic.dataset.kind).toBe('chevron');
    expect(optic.style['--optic-size']).toBe(`${OPTICS.lmg.size}px`);
    hud.update(0.016, hudState({ opticWeaponId: 'shotgun', aiming: true }));
    expect(optic.dataset.kind).toBe('bead');
  });

  it('never shows the pistol a mark, and leaves it its crosshair', () => {
    const { hud, elements } = stubHud();
    const optic = elements.get('optic') as FakeElement;
    const crosshair = elements.get('crosshair') as FakeElement;

    // Aiming with a rifle first, then switching to the pistol with the sights up: the reticle
    // has to go with the weapon rather than linger until the button is released.
    hud.update(0.016, hudState({ opticWeaponId: 'rifle', aiming: true }));
    expect(optic.classList.contains('visible')).toBe(true);
    hud.update(0.016, hudState({ opticWeaponId: 'pistol', aiming: true }));
    expect(optic.classList.contains('visible'), 'the pistol draws no reticle').toBe(false);
    // The pistol is aimed with its crosshair, which must not have been taken away with it.
    expect(crosshair.classList.contains('sighted')).toBe(false);
  });

  it('hides the mark when the sights come down and for anything that has no sight', () => {
    const { hud, elements } = stubHud();
    const optic = elements.get('optic') as FakeElement;
    const crosshair = elements.get('crosshair') as FakeElement;

    hud.update(0.016, hudState({ opticWeaponId: 'rifle', aiming: true }));
    expect(optic.classList.contains('visible')).toBe(true);
    // Released: right mouse up.
    hud.update(0.016, hudState({ opticWeaponId: 'rifle', aiming: false }));
    expect(optic.classList.contains('visible')).toBe(false);
    expect(crosshair.classList.contains('sighted'), 'the crosshair came back').toBe(false);

    // A drawn melee weapon, a selected grenade, and a frame with no firearm in hand at all:
    // the game passes null for all three, because the sight rides on what is held.
    for (const id of ['knife', 'katana', GRENADES.frag.id, null]) {
      hud.update(0.016, hudState({ opticWeaponId: id, aiming: true }));
      expect(optic.classList.contains('visible'), String(id)).toBe(false);
      expect(crosshair.classList.contains('sighted'), String(id)).toBe(false);
    }
  });
});
