/**
 * Aiming sights: which reticle a weapon draws with its sights up, and the numbers behind it.
 *
 * A table of its own, beside the weapon data in `gameConfig.ts`, because a reticle is decided
 * by what a weapon *is* — a class of gun with a class of sight — and not by a stat on each
 * weapon. A per-weapon copy of "a dot, 8 px wide" would be seven chances to drift apart, and
 * adding a firearm to `WeaponId` without a row here is a type error rather than a gun that
 * silently comes to the sights with nothing to aim with.
 *
 * The numbers are the ones the DOM reticle is drawn from: `size`, `thickness`, `gap` and
 * `color` are written onto the `#optic` element as custom properties (`src/ui/HUD.ts`), so
 * everything about how a mark looks is here and nothing about it is a magic number in a
 * stylesheet. Only the *shape* lives in CSS, switched by the element's `data-kind`.
 *
 * Nothing in here is a ballistic value. A sight is a thing the player looks through; it does
 * not change what a round does, and no weapon's damage, cadence, magazine or spread is read
 * from this file.
 */

import type { WeaponId } from './gameConfig';

/**
 * The aiming marks. `none` is a decision — a weapon that comes to the sights with no mark at
 * all — and not the absence of one: the pistol is here on purpose (the owner's call), so the
 * table answers for it instead of leaving a reader to guess whether it was forgotten.
 */
export type OpticKind = 'none' | 'bead' | 'dot' | 'chevron' | 'cross';

/**
 * Weapon ids the reticle table answers for.
 *
 * Every firearm the game ships, which is what `WeaponId` is: the three code-built ones
 * (`mp7`, `aug`, `remington-870`, whose meshes and descriptors live in `src/player/weapons/`)
 * arrived in the same hand-off as this table, and they are in it because the mark follows the
 * weapon's class and every class was decided at once — the MP7 is an SMG, the AUG a rifle and
 * the 870 a pump gun, so none of them needed a decision of its own.
 *
 * Aliased rather than written out so the table's key type has a name to point at, and so a
 * weapon added to `WeaponId` without a row here is a type error rather than a firearm that
 * silently comes to the sights with nothing to aim with.
 */
export type OpticWeaponId = WeaponId;

/** One weapon's sight: the mark, its numbers, and the code-built housing it is drawn in. */
export interface OpticSpec {
  kind: OpticKind;
  /**
   * Colour of the mark, as a CSS colour string.
   *
   * The code-built optic's illuminated reticle is painted the same colour (see
   * `opticMeshes.ts`), which is why this is one value and not two: the dot the player sees
   * through the housing and the dot on the housing are the same sight.
   */
  color: string;
  /**
   * Bounding size of the mark in CSS pixels, meaning per kind:
   * `dot` the dot's diameter, `cross` the total arm span, `chevron` the chevron's width,
   * `bead` the bead's diameter. Zero for a weapon with no mark.
   */
  size: number;
  /** Stroke thickness in CSS pixels: an arm's width, the bead's rim, the chevron's stroke. */
  thickness: number;
  /** Half the gap between the arms of a cross, CSS pixels. Zero for marks without arms. */
  gap: number;
  /**
   * The optic body this weapon needs, when its own mesh has none: where along the body the
   * housing is mounted (0 at the rear of the mesh, 1 at the muzzle). `null` for a weapon that
   * carries no housing — either because it has no mark at all, because a bead is an iron
   * sight and not an optic, or because its own mesh already ships a sight.
   *
   * A station per weapon rather than one constant, for the same reason `WEAPON_MECHANISMS`
   * has one: where the top of a receiver is depends on the weapon. The LMG's ammunition box,
   * carry handle and belt all sit over the middle of its receiver, so its housing goes behind
   * the handle; the MP5's cocking handle is forward of the middle, so its housing goes ahead
   * of the grip instead.
   */
  housing: { station: number } | null;
}

/**
 * The sights, one row per weapon the table answers for.
 *
 * The class split, and the reason for each: the pistol comes up with no sight at all (the
 * owner's explicit request — a sidearm that needs no lens), the close-quarters SMGs get a
 * small red dot because a dot covers the one target they are fired at, the rifles get a
 * four-arm cross for the range they are carried for, the belt-fed gun gets a larger chevron
 * because a chevron is a hold-over aid and its cone opens fastest of anything in the game,
 * the shotguns get a brass bead because a pump gun points rather than aims, and melee weapons
 * and the grenade have no entry here at all (they are not `OpticWeaponId`s, and `reticleFor`
 * answers null for anything the table does not hold).
 */
export const OPTICS: Record<OpticWeaponId, OpticSpec> = {
  /**
   * No sight, by the owner's request: the pistol is the weapon the player holds when nothing
   * is left, and putting a lens on it would make it the thing they would rather aim with.
   *
   * An explicit row and not an omission, so this file answers "what is on the pistol's
   * sights?" with a decision rather than with a shrug — and the plain crosshair stays on
   * screen for it, which is the aiming mark it has always had.
   */
  pistol: { kind: 'none', color: 'transparent', size: 0, thickness: 0, gap: 0, housing: null },

  /**
   * The SMGs: a red dot, small and round.
   *
   * A dot is honest at the range an SMG is used — close, moving, one target at a time — and
   * covers almost nothing, which is what a player firing a 13-rounds-a-second weapon needs
   * the middle of the screen to stay. 8 px on the compact SMG (the fastest of the three) and
   * 7 px on the MP5 and MP7, which are held on aim a beat longer.
   */
  smg: { kind: 'dot', color: '#ff6a4a', size: 8, thickness: 2, gap: 0, housing: { station: 0.45 } },
  mp5: { kind: 'dot', color: '#ff6a4a', size: 7, thickness: 2, gap: 0, housing: { station: 0.45 } },
  mp7: { kind: 'dot', color: '#ff6a4a', size: 7, thickness: 2, gap: 0, housing: { station: 0.42 } },

  /**
   * The rifles: a four-arm cross with a gap in the middle.
   *
   * A cross is what a gun carried for range is aimed with — the arms tell the eye which way
   * the weapon is off the target, which a dot does not. The centre is left open so the
   * crosshair-free middle of the screen is the target itself, and the arms sit wide enough
   * (a 6 px half-gap) that a zombie's head is framed rather than covered.
   */
  rifle: { kind: 'cross', color: '#e8f0ff', size: 26, thickness: 2, gap: 6, housing: { station: 0.4 } },

  /**
   * The AUG: the same cross, a little larger, and no housing of its own.
   *
   * The owner offered a chevron here on the grounds that a bullpup's optic is bigger; a cross
   * is kept, because the AUG is a precise rifle (0.010 rad of cone, the tightest in the game)
   * and a chevron is a compensation aid for a weapon that sprays — which is what the LMG gets
   * it for. What the bullpup's bigger optic justifies is the size: 30 px of arm instead of 26,
   * since the mark is read further from the eye down a long scope tube.
   *
   * No housing because the mesh already ships one: `src/player/weapons/aug.ts` builds
   * `AugScopeTube`, `AugScopeObjective` and `AugScopeEyepiece` as its integrated optic. The
   * same rule the owner gave for a scope another worker had added — never a second one.
   */
  aug: { kind: 'cross', color: '#e8f0ff', size: 30, thickness: 2, gap: 7, housing: null },

  /**
   * The P90: a dot, and no housing either.
   *
   * A dot, not a cross: the P90 is a PDW — a bullpup the size of an SMG with a light round —
   * so it is aimed the way an SMG is. A cross would promise precision the weapon does not
   * have (0.016 rad, wider than the assault rifle's) and its 40-round magazine is spent in
   * bursts at close range.
   *
   * The housing is left to the mesh, which already has one: `proceduralWeapons.createP90`
   * builds an integrated optic — a rail and a tube over the magazine. Mounting a second one
   * would place it at the same station as the sight already there, which reads as a scope
   * stacked on a scope. The name guard in `opticMeshes.ts` could not have caught it: those
   * meshes are unnamed, so this row is the decision and the guard is only a safety net.
   */
  p90: { kind: 'dot', color: '#ff6a4a', size: 9, thickness: 2, gap: 0, housing: null },

  /**
   * The belt-fed LMG: a large amber chevron.
   *
   * A chevron because of what the weapon is: a belt-fed gun whose recoil fights the aim and
   * whose cone opens fastest of anything here (0.022 rad), so the sight has to help hold a
   * line rather than merely mark a point. Amber against the red dot and the pale cross, so
   * the one weapon with a hold-over mark can be told from the others at a glance.
   */
  lmg: { kind: 'chevron', color: '#ffd166', size: 34, thickness: 4, gap: 0, housing: { station: 0.25 } },

  /**
   * The shotguns: a brass bead, the smallest mark in the table.
   *
   * This is the iron sight a pump gun actually has — a bead on the end of the barrel and a
   * rear groove, no lens and no tube — and the sight picture is meant to be rough: a shotgun
   * is pointed at a doorway, not aimed at a head. A cross or a dot here would invite a
   * precision the 0.062 rad cone cannot deliver. Brass, because that is what a bead is.
   * No housing: an optic on a shotgun is a scope on a weapon whose whole point is the spread.
   */
  shotgun: { kind: 'bead', color: '#ffe08a', size: 7, thickness: 2, gap: 0, housing: null },

  /**
   * The pump-action 870: the same bead, and its mesh already carries the part.
   *
   * `src/player/weapons/remington870.ts` builds `Remington870FrontBead` at the muzzle and a
   * rear sight on the rail, which is exactly the sight this row draws. Nothing is mounted.
   */
  'remington-870': { kind: 'bead', color: '#ffe08a', size: 7, thickness: 2, gap: 0, housing: null },
};

/**
 * The sight a weapon draws, or null when it draws none.
 *
 * Total and total on purpose: an id the table does not hold — a melee weapon, the grenade, a
 * weapon that does not exist, null because nothing is in hand — answers null rather than
 * throwing, so the reticle can never be the thing that breaks a frame. A firearm that is in
 * the table with kind `none` (the pistol) also answers null: the row exists to record the
 * decision, and the decision is that there is no mark.
 */
export function reticleFor(weaponId: string | null | undefined): OpticSpec | null {
  if (!weaponId) return null;
  const spec = (OPTICS as Record<string, OpticSpec | undefined>)[weaponId];
  if (!spec || spec.kind === 'none') return null;
  return spec;
}

/**
 * Whether the reticle is on screen right now.
 *
 * The whole rule, in one pure function, so the HUD cannot hold a second version of it: the
 * mark is up when the player is aiming *and* the weapon in hand has one. That single `&&` is
 * what makes every case the reticle must not appear in true by construction rather than by a
 * list of exceptions — released ADS (`isAiming` false), a weapon with no mark (pistol), a
 * melee weapon, the grenade, and a paused game (where the controller drops the aim blend to
 * zero and nothing is passed as aiming) all fall out of it.
 */
export function opticVisibleFor(weaponId: string | null | undefined, isAiming: boolean): boolean {
  return isAiming && reticleFor(weaponId) !== null;
}

/**
 * The spec to draw right now, or null.
 *
 * The shape the HUD actually wants: the *spec* rather than the boolean, because it needs the
 * numbers too. Kept beside `opticVisibleFor` and built on it, so the visibility rule has one
 * implementation and the HUD cannot paint a mark the rule says is down.
 */
export function reticleShownFor(
  weaponId: string | null | undefined,
  isAiming: boolean,
): OpticSpec | null {
  return opticVisibleFor(weaponId, isAiming) ? reticleFor(weaponId) : null;
}
