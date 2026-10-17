import { describe, expect, it } from 'vitest';
import { MELEE, WEAPONS, type MeleeId, type WeaponId } from '../src/app/gameConfig';
import {
  hudWeaponSlotReadout, objectiveEdgePlacement, type ObjectiveEdgePlacement,
} from '../src/ui/HUD';

/**
 * The two readability complaints, held to as facts.
 *
 * The owner played the game and could not find how to pick a weapon, did not know the trade post
 * existed, and called the objective marker "sangat ga jelas". Each of those is a *presentation*
 * failure, so nothing here can be proved by the simulation, and this host has no browser to look
 * at. What can be held to is the part of the presentation that is arithmetic or wording:
 *
 *  - the slot row says which number key holds the weapon in hand, what that category is called,
 *    where inside it the player is, and every other weapon that answers to the same key;
 *  - the off-screen objective arrow is placed on the viewport edge in the target's direction,
 *    for a target to the side, above, behind the player and dead behind — the case the old
 *    on-the-spot arrow could not express at all;
 *  - and the elements and classes the HUD writes really are the ones index.html and the
 *    stylesheet provide, so a renamed id cannot leave the new rows silently blank.
 */

describe('the weapon slot row', () => {
  it('prints the key, the category and the rotation position', () => {
    const readout = hudWeaponSlotReadout({
      slot: 1, names: ['Assault rifle', 'MP5', 'Pump Shotgun'], activeIndex: 1,
    });
    expect(readout.key).toBe('1');
    expect(readout.category).toBe('PRIMARY');
    expect(readout.line).toBe('SLOT 1 · PRIMARY · 2 OF 3 — TAP 1 TO CYCLE');
    expect(readout.names).toEqual(['Assault rifle', 'MP5', 'Pump Shotgun']);
    expect(readout.activeIndex).toBe(1);
  });

  it('names every category the number keys can reach', () => {
    const at = (slot: number) => hudWeaponSlotReadout({ slot, names: ['x'], activeIndex: 0 }).category;
    expect(at(1)).toBe('PRIMARY');
    expect(at(2)).toBe('SIDEARM');
    expect(at(3)).toBe('MELEE');
    expect(at(4)).toBe('GRENADE');
  });

  it('never invites a press that does nothing in a single-weapon category', () => {
    const readout = hudWeaponSlotReadout({ slot: 2, names: ['Sidearm'], activeIndex: 0 });
    expect(readout.line).toBe('SLOT 2 · SIDEARM');
    expect(readout.line).not.toMatch(/OF 1|CYCLE/);
  });

  it('still prints the key when the category is empty', () => {
    const readout = hudWeaponSlotReadout({ slot: 1, names: [], activeIndex: -1 });
    expect(readout.line).toBe('SLOT 1 · PRIMARY');
    expect(readout.names).toEqual([]);
  });

  it('copies the names, so a later mutation cannot rewrite what was printed', () => {
    const names = ['MP5'];
    const readout = hudWeaponSlotReadout({ slot: 1, names, activeIndex: 0 });
    names.push('P90');
    expect(readout.names).toEqual(['MP5']);
  });

  it('reads the real tables: a bought primary is listed under the slot its key opens', () => {
    const slotOf = (id: WeaponId) => WEAPONS[id].slot;
    const primaries = (Object.keys(WEAPONS) as WeaponId[]).filter((id) => slotOf(id) === 1);
    expect(primaries.length).toBeGreaterThan(1);
    const readout = hudWeaponSlotReadout({
      slot: 1, names: primaries.map((id) => WEAPONS[id].name), activeIndex: 0,
    });
    // The row must be honest about how many weapons answer to the key, which is the whole point
    // of the "tap again to cycle" hint.
    expect(readout.line).toContain(`1 OF ${primaries.length}`);
  });

  it('lists the melee rotation the way slot 3 sees it', () => {
    const ids = Object.keys(MELEE) as MeleeId[];
    const names = ids.map((id) => MELEE[id].name);
    const readout = hudWeaponSlotReadout({ slot: 3, names, activeIndex: names.length - 1 });
    expect(readout.line).toContain(`SLOT 3 · MELEE · ${names.length} OF ${names.length}`);
    expect(readout.names).toHaveLength(ids.length);
  });
});

describe('the off-screen objective arrow', () => {
  /** Every default placement keeps the glyph inside the frame, not straddling the edge. */
  const INSET = 0.08;
  const inside = (placement: ObjectiveEdgePlacement): boolean =>
    placement.x >= INSET - 1e-9 && placement.x <= 1 - INSET + 1e-9
    && placement.y >= INSET - 1e-9 && placement.y <= 1 - INSET + 1e-9;

  it('puts a target to the right on the right edge, pointing right', () => {
    const placement = objectiveEdgePlacement(1, 0, false);
    expect(placement.x).toBeCloseTo(0.92, 6);
    expect(placement.y).toBeCloseTo(0.5, 6);
    // The glyph points up, so 90 degrees clockwise is "point right".
    expect(placement.angleDeg).toBeCloseTo(90, 6);
  });

  it('puts a target above the frame at the top, pointing up', () => {
    const placement = objectiveEdgePlacement(0, 1, false);
    expect(placement.x).toBeCloseTo(0.5, 6);
    expect(placement.y).toBeCloseTo(0.08, 6);
    expect(placement.angleDeg).toBeCloseTo(0, 6);
  });

  it('keeps the diagonal a diagonal', () => {
    const placement = objectiveEdgePlacement(1, 1, false);
    expect(placement.x).toBeCloseTo(0.92, 6);
    expect(placement.y).toBeCloseTo(0.08, 6);
    expect(placement.angleDeg).toBeCloseTo(45, 6);
  });

  it('pulls a point that is off screen back onto the edge without turning it', () => {
    // The projection of a point past the frame can be any distance out; the arrow still belongs
    // on the edge it left through, at the same bearing.
    const far = objectiveEdgePlacement(6.4, 0.2, false);
    const near = objectiveEdgePlacement(1, 0.03125, false);
    expect(far.x).toBeCloseTo(near.x, 6);
    expect(far.y).toBeCloseTo(near.y, 6);
    expect(far.angleDeg).toBeCloseTo(near.angleDeg, 6);
    expect(inside(far)).toBe(true);
  });

  it('points back over the shoulder for a target behind the player', () => {
    // `project` mirrors a point behind the camera, so (-1, 0, behind) is a target off the
    // player's right: the arrow has to point right, not left.
    const behindRight = objectiveEdgePlacement(-1, 0, true);
    expect(behindRight.x).toBeCloseTo(0.92, 6);
    expect(behindRight.angleDeg).toBeCloseTo(90, 6);

    const behindAbove = objectiveEdgePlacement(0, -1, true);
    expect(behindAbove.y).toBeCloseTo(0.08, 6);
    expect(behindAbove.angleDeg).toBeCloseTo(0, 6);
  });

  it('points straight down for a target dead behind the player', () => {
    // The one case with no bearing at all: the point projects onto the centre. The arrow drops
    // to the bottom of the frame and points down, which is the convention every game uses.
    const placement = objectiveEdgePlacement(0, 0, true);
    expect(placement.x).toBeCloseTo(0.5, 6);
    expect(placement.y).toBeCloseTo(0.92, 6);
    expect(placement.angleDeg).toBeCloseTo(180, 6);
  });

  it('keeps every placement inside the frame, and every angle finite', () => {
    for (const [x, y] of [[0, 0], [1, 0], [0, 1], [-1, 0], [0.3, -0.7], [12, -30], [-0.01, 0.01]]) {
      for (const behind of [false, true]) {
        const placement = objectiveEdgePlacement(x, y, behind);
        expect(Number.isFinite(placement.angleDeg), `${x},${y},${behind}`).toBe(true);
        expect(placement.angleDeg).toBeGreaterThanOrEqual(-180);
        expect(placement.angleDeg).toBeLessThanOrEqual(180);
        expect(inside(placement), `${x},${y},${behind} -> ${placement.x},${placement.y}`).toBe(true);
      }
    }
  });

  it('takes the inset from the caller, and clamps a nonsense one', () => {
    const flush = objectiveEdgePlacement(1, 0, false, 0);
    expect(flush.x).toBeCloseTo(1, 6);
    // A margin past half the viewport would invert the placement; it is clamped instead.
    const clamped = objectiveEdgePlacement(1, 0, false, 0.9);
    expect(clamped.x).toBeCloseTo(0.55, 6);
  });
});

// ---------------------------------------------------------------------------
// The elements those readouts are written into
// ---------------------------------------------------------------------------

/**
 * The HUD is plain DOM, so its ids are a contract between three files. This is the seam a rename
 * breaks silently — a row that is written every frame into an element that no longer exists by
 * that name is simply blank on screen — so the ids are checked as source rather than only by
 * looking.
 */
describe('the HUD rows have somewhere to be written', () => {
  const SOURCES = import.meta.glob('/{index.html,src/ui/HUD.ts,src/styles/main.css}', {
    query: '?raw', import: 'default', eager: true,
  }) as Record<string, string>;

  const source = (suffix: string): string => {
    const key = Object.keys(SOURCES).find((candidate) => candidate.endsWith(suffix));
    expect(key, `${suffix} was not loaded`).toBeTruthy();
    return SOURCES[key ?? ''] ?? '';
  };

  it('every element the HUD reads exists in index.html', () => {
    const hud = source('/src/ui/HUD.ts');
    const html = source('/index.html');
    const ids = [...hud.matchAll(/requireElement(?:<[^>]*>)?\('([^']+)'\)/g)].map((match) => match[1]);
    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) {
      expect(html, `#${id} is read by the HUD but missing from index.html`)
        .toContain(`id="${id}"`);
    }
  });

  it('the new rows are among them', () => {
    const hud = source('/src/ui/HUD.ts');
    for (const id of [
      'hud-slot-line', 'hud-slot-list', 'objective-distance', 'objective-edge',
      'objective-edge-arrow', 'objective-edge-distance',
    ]) {
      expect(hud, `the HUD no longer reads #${id}`).toContain(`'${id}'`);
    }
  });

  it('the hint line and the slot chips are styled, not invisible markup', () => {
    const css = source('/src/styles/main.css');
    for (const selector of ['.hud-hint', '.weapon-slot-line', '.slot-chip', '.objective-edge']) {
      expect(css, `${selector} has no rule in the stylesheet`).toContain(selector);
    }
  });

  it('the Controls screen documents the store key and the slot keys', () => {
    const html = source('/index.html');
    // The owner's report was that the store looked like it did not exist; the screen that lists
    // every key has to name it.
    expect(html).toMatch(/<kbd>B<\/kbd><span>[^<]*[Tt]rade post/);
    expect(html).toMatch(/<kbd>1<\/kbd><kbd>2<\/kbd><kbd>3<\/kbd><kbd>4<\/kbd><span>[^<]*cycle/);
  });
});
