/**
 * What the store sells.
 *
 * Deliberately its own table rather than a field on `WEAPONS`/`MELEE`: a price is an economy
 * value, not a weapon statistic, and the plan this follows explicitly asks for the price
 * table to live apart from the balance numbers the runtime reads. That also means this file
 * can be checked for integrity (every id exists, every model ships) without touching a
 * single weapon value.
 *
 * Only gear the player does not start with is sellable: the sidearm and the knife are in the
 * starting loadout, so listing them would be a row that can never be bought.
 *
 * Prices are in non-decreasing order, cheapest first, and why:
 * - Machete 150 — the cheapest melee. Fastest swing of any weapon, shortest reach, so it is
 *   the thing you buy when you have nothing (the work order's own figure).
 * - Crowbar 200 — a heavier hit than the machete for a slightly slower swing.
 * - Barbed bat 250 — fast and wide, and the fallback when a magazine runs dry.
 * - Spear 300 — the longest reach of the melee set (3 m), so it costs more than the bat.
 * - Fire axe 350 — the crowd weapon: 92 degrees of arc and 62 damage a swing.
 * - Firefighter's axe 350 — the same class and so the same price; it trades a little of
 *   that axe's arc for more damage and a shorter cooldown. Both take the work order's 350.
 * - Katana 400 — 86 degrees and 2.4 m: the crowd blade, and the best "many zombies at once"
 *   answer melee has.
 * - Sledgehammer 600 — 110 damage in one swing. Paid for with a 1.25 s cooldown.
 * - Rifle 700 — the first firearm worth buying. The drop ladder also hands it out, so the
 *   price is the impatient route to one.
 * - SMG 800 — faster and more controllable up close than the rifle, so it costs more.
 * - MP5 800 — the same price as the SMG: a slower, harder-hitting 30-round submachine gun.
 * - Shotgun 900 — one shell kills a walker outright. The priciest of the hand-held class
 *   because it is the strongest thing in it.
 * - P90 1100 — 40 rounds a magazine and the highest rate of fire, which is what the extra
 *   cost over the shotgun buys.
 * - Belt-fed LMG 2500 — 150 rounds, 22 damage, a 4.5 s reload. The most expensive item on
 *   the shelf by a factor of two, and the only one the game is not balanced around.
 */
import { MELEE, WEAPONS, type MeleeId, type WeaponId } from '../app/gameConfig';

export type StoreCategory = 'melee' | 'firearm';

export interface StoreItemBase {
  /** Display name. Pinned to the weapon config's own name by a test. */
  name: string;
  /** Cost in points. Always a positive integer. */
  price: number;
  /** One line for the detail panel. */
  blurb: string;
}

export interface MeleeStoreItem extends StoreItemBase {
  category: 'melee';
  id: MeleeId;
}

export interface FirearmStoreItem extends StoreItemBase {
  category: 'firearm';
  id: WeaponId;
}

export type StoreItem = MeleeStoreItem | FirearmStoreItem;

export const STORE_ITEMS: readonly StoreItem[] = [
  { category: 'melee', id: 'machete', name: 'Machete', price: 150, blurb: 'The fastest swing in the game. Short reach, so you have to step in.' },
  { category: 'melee', id: 'crowbar', name: 'Crowbar', price: 200, blurb: 'A forged bar: heavier than a machete, still quick.' },
  { category: 'melee', id: 'barbed-bat', name: 'Barbed Bat', price: 250, blurb: 'Fast, wide and cheap. The fallback when the magazine runs dry.' },
  { category: 'melee', id: 'spear', name: 'Spear', price: 300, blurb: 'Three metres of reach. One thrust at a time, aimed.' },
  { category: 'melee', id: 'axe', name: 'Fire Axe', price: 350, blurb: 'The widest arc of the melee weapons: built for a crowd.' },
  { category: 'melee', id: 'fire-axe', name: "Firefighter's Axe", price: 350, blurb: 'A tighter arc than the fire axe, but more damage and a faster swing.' },
  { category: 'melee', id: 'katana', name: 'Katana', price: 400, blurb: 'A long, sweeping blade: the best melee answer to a crowd.' },
  { category: 'melee', id: 'sledgehammer', name: 'Sledgehammer', price: 600, blurb: 'One blow kills. One point two seconds between blows.' },
  { category: 'firearm', id: 'rifle', name: 'Assault rifle', price: 700, blurb: 'Automatic, thirty rounds, accurate at range.' },
  { category: 'firearm', id: 'smg', name: 'Compact SMG', price: 800, blurb: 'Thirteen rounds a second with almost no recoil.' },
  { category: 'firearm', id: 'mp5', name: 'MP5', price: 800, blurb: 'Slower than the SMG and harder hitting, with the least recoil of the automatics.' },
  { category: 'firearm', id: 'shotgun', name: 'Pump Shotgun', price: 900, blurb: 'Eight pellets. One shell kills a walker outright up close.' },
  { category: 'firearm', id: 'p90', name: 'P90', price: 1100, blurb: 'Bullpup, forty rounds, and the fastest trigger on the shelf.' },
  { category: 'firearm', id: 'lmg', name: 'Belt-Fed LMG', price: 2500, blurb: 'A 150-round belt of 22-damage rounds. It takes four and a half seconds to feed a new one.' },
];

/** The item with this id, or null when the store does not sell it. */
export function findStoreItem(id: string): StoreItem | null {
  return STORE_ITEMS.find((item) => item.id === id) ?? null;
}

/** The glTF the store preview loads for an item, from the weapon configs themselves. */
export function storeItemModelPath(item: StoreItem): string {
  return item.category === 'firearm' ? WEAPONS[item.id].modelPath : MELEE[item.id].modelPath;
}
