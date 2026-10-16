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
 * Prices, cheapest first, and why:
 * - Barbed bat 250 — the cheapest melee. It is the thing you buy when you have nothing.
 * - Spear 300 — the longest reach of the melee set (3 m), so it costs more than the bat.
 * - Fire axe 350 — the crowd weapon: 92 degrees of arc and 62 damage a swing.
 * - Rifle 700 — the first firearm worth buying. The drop ladder also hands it out, so the
 *   price is the impatient route to one.
 * - SMG 800 — faster and more controllable up close than the rifle, so it costs more.
 * - Shotgun 900 — one shell kills a walker outright. The priciest because it is the
 *   strongest thing on the shelf.
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
  { category: 'melee', id: 'barbed-bat', name: 'Barbed Bat', price: 250, blurb: 'Fast, wide and cheap. The fallback when the magazine runs dry.' },
  { category: 'melee', id: 'spear', name: 'Spear', price: 300, blurb: 'Three metres of reach. One thrust at a time, aimed.' },
  { category: 'melee', id: 'axe', name: 'Fire Axe', price: 350, blurb: 'The widest arc of any melee weapon: built for a crowd.' },
  { category: 'firearm', id: 'rifle', name: 'Assault rifle', price: 700, blurb: 'Automatic, thirty rounds, accurate at range.' },
  { category: 'firearm', id: 'smg', name: 'Compact SMG', price: 800, blurb: 'Thirteen rounds a second with almost no recoil.' },
  { category: 'firearm', id: 'shotgun', name: 'Pump Shotgun', price: 900, blurb: 'Eight pellets. One shell kills a walker outright up close.' },
];

/** The item with this id, or null when the store does not sell it. */
export function findStoreItem(id: string): StoreItem | null {
  return STORE_ITEMS.find((item) => item.id === id) ?? null;
}

/** The glTF the store preview loads for an item, from the weapon configs themselves. */
export function storeItemModelPath(item: StoreItem): string {
  return item.category === 'firearm' ? WEAPONS[item.id].modelPath : MELEE[item.id].modelPath;
}
