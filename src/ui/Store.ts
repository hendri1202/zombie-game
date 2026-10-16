import {
  AmbientLight, Box3, DirectionalLight, Group, PerspectiveCamera, Scene, Vector3, WebGLRenderer,
  type Object3D,
} from 'three';
import { STORE_ITEMS, type StoreItem } from '../economy/storeItems';

/** Everything the store needs to paint itself, in one read per refresh. */
export interface StoreSnapshot {
  points: number;
  earnedTotal: number;
  /** Store item ids the player already owns. */
  owned: string[];
  /** Store item ids that can be bought right now (affordable and not yet owned). */
  purchasable: string[];
}

export interface StorePurchaseResult {
  ok: boolean;
  reason: string;
}

export interface StoreDeps {
  /** Current economy state, read on every refresh. */
  snapshot: () => StoreSnapshot;
  /** Runs the purchase and reports what happened; the store does not own economy rules. */
  purchase: (itemId: string) => StorePurchaseResult;
  /** Asked when the player closes the store (the B key or the Close button). */
  onClose: () => void;
  /**
   * A fresh, unparented copy of the item's mesh for the preview. Returns null when the model
   * failed to load; the store then shows the text panel alone instead of a black rectangle.
   *
   * A copy rather than the live view model: that object is parented to the game camera, and
   * moving it into the preview scene would take the weapon out of the player's hands.
   */
  previewModel: (item: StoreItem) => Object3D | null;
}

function el<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`UI element #${id} is missing from index.html`);
  return element as T;
}

/**
 * How the buy button should look for one item.
 *
 * `ready` is the only state where the button does anything: owned and too-dear both leave
 * it inert, and the too-dear case carries `is-locked` so the CSS can grey it out instead of
 * relying on the player noticing a `disabled` attribute. Pure and DOM-free so all three
 * cases are a unit test rather than something only a browser can show.
 */
export type BuyButtonState = 'ready' | 'locked' | 'owned';

export interface BuyButtonAppearance {
  state: BuyButtonState;
  disabled: boolean;
  /** Extra class the button carries, on top of `btn btn-primary`. */
  modifierClass: string;
}

export function buyButtonState(options: { owned: boolean; canBuy: boolean }): BuyButtonAppearance {
  if (options.owned) return { state: 'owned', disabled: true, modifierClass: 'is-owned' };
  if (options.canBuy) return { state: 'ready', disabled: false, modifierClass: 'is-ready' };
  return { state: 'locked', disabled: true, modifierClass: 'is-locked' };
}

/**
 * The store overlay: item list, detail panel and a live 3D preview.
 *
 * Plain DOM over the game canvas, like every other screen, because readable text and real
 * buttons cost nothing and a canvas-drawn shop would be worse for keyboard and screen
 * readers. The one piece of 3D is the preview: its own scene, camera and renderer, drawn into
 * a small canvas only while the store is open, so a closed shop costs no draw call.
 *
 * The store holds no economy rules at all — it asks `snapshot()` for what to show and calls
 * `purchase()` to buy. That is what lets prices, affordability and the "already owned" rule be
 * unit-tested in `src/economy/`, far away from any DOM.
 *
 * One deliberate reading of "an unaffordable item cannot be clicked": the *buy* is refused
 * (button disabled, price red), but the row stays selectable so the preview shows what the
 * player is saving for. Blocking selection would hide the weapon you are working towards.
 */
export class Store {
  private readonly root = el<HTMLDivElement>('screen-store');
  private readonly list = el<HTMLDivElement>('store-list');
  private readonly balance = el<HTMLElement>('store-points');
  private readonly detailName = el<HTMLElement>('store-detail-name');
  private readonly detailBlurb = el<HTMLElement>('store-detail-blurb');
  private readonly detailStatus = el<HTMLElement>('store-detail-status');
  private readonly note = el<HTMLElement>('store-note');
  private readonly buyButton = el<HTMLButtonElement>('store-buy');
  private readonly closeButton = el<HTMLButtonElement>('store-close');
  private readonly canvas = el<HTMLCanvasElement>('store-preview');

  private readonly deps: StoreDeps;
  private readonly buttons: HTMLButtonElement[] = [];
  private selectedIndex = 0;
  private opened = false;

  // --- preview ------------------------------------------------------------
  private renderer: WebGLRenderer | null = null;
  private readonly previewScene = new Scene();
  private readonly previewCamera = new PerspectiveCamera(38, 1.5, 0.01, 60);
  private readonly previewGroup = new Group();
  private previewModel: Object3D | null = null;
  /** Id of the item currently in the preview, so a repaint does not rebuild the mesh. */
  private previewItemId: string | null = null;
  private previewSpin = 0;

  constructor(deps: StoreDeps) {
    this.deps = deps;
    this.buildList();
    this.buildPreview();
    this.buyButton.addEventListener('click', () => this.buySelected());
    this.closeButton.addEventListener('click', () => this.deps.onClose());
    window.addEventListener('keydown', this.onKeyDown);
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** The item currently shown in the detail panel and the preview. */
  get selected(): StoreItem {
    return STORE_ITEMS[this.selectedIndex];
  }

  /**
   * Opens the store. The caller is responsible for the phase rule — Game only calls this
   * between waves or while paused, because a shop you can be eaten in is not a shop.
   */
  open(): void {
    if (this.opened) return;
    this.opened = true;
    this.root.classList.remove('hidden');
    this.root.setAttribute('aria-hidden', 'false');
    this.resizePreview();
    this.refresh();
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.root.classList.add('hidden');
    this.root.setAttribute('aria-hidden', 'true');
  }

  /** Repaints list prices, the balance and the detail panel from the current economy state. */
  refresh(): void {
    const snapshot = this.deps.snapshot();
    this.balance.textContent = String(Math.max(0, Math.round(snapshot.points)));
    const owned = new Set(snapshot.owned);
    const purchasable = new Set(snapshot.purchasable);

    STORE_ITEMS.forEach((item, index) => {
      const button = this.buttons[index];
      if (!button) return;
      const isOwned = owned.has(item.id);
      const canBuy = purchasable.has(item.id);
      button.classList.toggle('is-selected', index === this.selectedIndex);
      button.classList.toggle('is-owned', isOwned);
      button.classList.toggle('is-poor', !isOwned && !canBuy);
      button.setAttribute('aria-selected', String(index === this.selectedIndex));
      const price = button.querySelector<HTMLElement>('.store-item-price');
      if (price) price.textContent = isOwned ? 'OWNED' : `${item.price}`;
    });

    const item = this.selected;
    const isOwned = owned.has(item.id);
    const canBuy = purchasable.has(item.id);
    this.detailName.textContent = item.name;
    this.detailBlurb.textContent = item.blurb;
    this.detailStatus.classList.toggle('is-owned', isOwned);
    this.detailStatus.classList.toggle('is-poor', !isOwned && !canBuy);
    this.detailStatus.classList.toggle('is-ready', canBuy);
    if (isOwned) {
      this.detailStatus.textContent = 'OWNED';
    } else if (canBuy) {
      this.detailStatus.textContent = `READY — ${item.price} points`;
    } else {
      this.detailStatus.textContent = `NEED ${item.price - snapshot.points} MORE POINTS`;
    }
    // The buy button's look and its enabled state come from one rule, so a button that is
    // greyed out is always the one that cannot be clicked (see buyButtonState).
    const buy = buyButtonState({ owned: isOwned, canBuy });
    this.buyButton.disabled = buy.disabled;
    this.buyButton.classList.toggle('is-ready', buy.state === 'ready');
    this.buyButton.classList.toggle('is-locked', buy.state === 'locked');
    this.buyButton.classList.toggle('is-owned', buy.state === 'owned');
    this.buyButton.textContent = isOwned ? 'Owned' : `Buy — ${item.price}`;
    this.note.textContent = snapshot.earnedTotal > 0
      ? `${snapshot.earnedTotal} points earned in total. Progress is stored in this browser only.`
      : 'Kill zombies to earn points. Progress is stored in this browser only.';
    this.setPreview(item);
  }

  /** Advances the preview and draws it. No-op while closed, so a closed store costs nothing. */
  render(delta: number): void {
    if (!this.opened || !this.renderer || !this.previewModel) return;
    this.previewSpin += delta * 0.7;
    this.previewGroup.rotation.y = this.previewSpin;
    this.renderer.render(this.previewScene, this.previewCamera);
  }

  /** What the debug hook reports. */
  report(): StoreSnapshot & { open: boolean } {
    return { open: this.opened, ...this.deps.snapshot() };
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    this.previewScene.clear();
    this.renderer?.dispose();
    this.renderer = null;
  }

  // -------------------------------------------------------------------------

  private buildList(): void {
    this.list.textContent = '';
    STORE_ITEMS.forEach((item, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'store-item';
      button.setAttribute('role', 'option');
      button.dataset.item = item.id;

      const name = document.createElement('span');
      name.className = 'store-item-name';
      name.textContent = item.name;

      const price = document.createElement('span');
      price.className = 'store-item-price';
      price.textContent = String(item.price);

      button.append(name, price);
      button.addEventListener('click', () => this.select(index));
      button.addEventListener('pointerenter', () => this.select(index));
      this.buttons.push(button);
      this.list.appendChild(button);
    });
  }

  private buildPreview(): void {
    // Null lit in a dark room: an unlit weapon mesh would come out black, and a floodlit one
    // loses the shape. Unlike the level's dusk rig, this is a display case.
    const ambient = new AmbientLight(0xffffff, 1.35);
    const key = new DirectionalLight(0xffe8d0, 2.4);
    key.position.set(2.2, 2.6, 2.4);
    const rim = new DirectionalLight(0x8fb8ff, 1.1);
    rim.position.set(-2.4, 0.6, -1.8);
    this.previewScene.add(ambient, key, rim);
    this.previewScene.add(this.previewGroup);
    this.previewCamera.position.set(0, 0.28, 1.75);
    this.previewCamera.lookAt(0, 0, 0);

    try {
      this.renderer = new WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    } catch (error) {
      // No WebGL for the preview is not a reason to lose the shop: the list and the buy
      // button work without it, only the picture is missing.
      console.warn('[store] preview renderer unavailable; the item list still works', error);
      this.renderer = null;
    }
  }

  private resizePreview(): void {
    if (!this.renderer) return;
    const width = this.canvas.clientWidth || 360;
    const height = this.canvas.clientHeight || 160;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height, false);
    this.previewCamera.aspect = width / Math.max(1, height);
    this.previewCamera.updateProjectionMatrix();
  }

  private select(index: number): void {
    if (index < 0 || index >= STORE_ITEMS.length || index === this.selectedIndex) return;
    this.selectedIndex = index;
    this.refresh();
  }

  private buySelected(): void {
    const item = this.selected;
    const result = this.deps.purchase(item.id);
    if (result.ok) this.refresh();
    // A refused purchase (already owned, not enough points) leaves the panel as it was; the
    // button is disabled in that state, so this is only reachable in a race.
  }

  private setPreview(item: StoreItem): void {
    if (item.id === this.previewItemId) return;
    this.previewItemId = item.id;
    this.previewGroup.clear();
    const model = this.deps.previewModel(item);
    this.previewModel = model;
    if (!model) return;

    // Frame by measured bounds rather than by a per-weapon offset: a knife and a shotgun are
    // both normalised to the same longest axis by the view model pipeline, but the preview
    // should not depend on that staying true.
    model.position.set(0, 0, 0);
    model.rotation.set(0, 0, 0);
    model.scale.set(1, 1, 1);
    this.previewGroup.add(model);
    this.previewGroup.rotation.y = 0;
    this.previewSpin = 0;

    const box = new Box3().setFromObject(model);
    const size = box.getSize(new Vector3());
    const longest = Math.max(size.x, size.y, size.z, 1e-4);
    const scale = 1.1 / longest;
    model.scale.multiplyScalar(scale);
    // Re-centre after scaling so the weapon sits in the middle of the case at any size.
    const centre = box.getCenter(new Vector3());
    model.position.set(-centre.x * scale, -centre.y * scale, -centre.z * scale);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.opened) return;
    if (event.code === 'ArrowUp') {
      event.preventDefault();
      this.select((this.selectedIndex - 1 + STORE_ITEMS.length) % STORE_ITEMS.length);
    } else if (event.code === 'ArrowDown') {
      event.preventDefault();
      this.select((this.selectedIndex + 1) % STORE_ITEMS.length);
    } else if (event.code === 'Enter' || event.code === 'NumpadEnter') {
      event.preventDefault();
      this.buySelected();
    } else if (event.code === 'Escape') {
      // Escape is the pause gesture everywhere else, so it closes the shop the same way.
      event.preventDefault();
      this.deps.onClose();
    }
  };
}
