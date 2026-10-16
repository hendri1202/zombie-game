import type { Disposable } from '../core/Disposable';

export interface InputSnapshot {
  forward: number;
  right: number;
  sprint: boolean;
  /** Mouse movement accumulated since the last consume() call, in pixels. */
  lookX: number;
  lookY: number;
  firing: boolean;
  /** True on the frame the trigger is first held. */
  firePressed: boolean;
  /**
   * True on the frame the jump key is first held.
   *
   * Edge-triggered like `firePressed`, not held: the controller launches a jump on the frame
   * this is true and ignores it while airborne, so holding Space does not queue a second jump
   * for the moment the player lands.
   */
  jumpPressed: boolean;
  reloadPressed: boolean;
  /** True on the frame the melee key is first held: draw the melee weapon, or swing it. */
  meleePressed: boolean;
  weaponSlotRequested: number | null;
  /**
   * True while the aim button (right mouse) is held.
   *
   * Held rather than latched, and optional because it is the one input a synthetic
   * snapshot in a test can leave out: a snapshot without it simply never aims, which is
   * the safe direction for a harness to fall.
   */
  adsHeld?: boolean;
}

const KEY_BINDINGS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  reload: ['KeyR'],
  // Free when melee landed: F is not bound to anything else (V is the camera, F3 the
  // overlay, and 1-4 are the weapon category slots).
  melee: ['KeyF'],
  // Space: free when the jump landed. V is the camera, F melee, B the store, F3 the overlay,
  // 1-4 the weapon slots, R the reload — none of them is Space.
  jump: ['Space'],
  slot1: ['Digit1'],
  slot2: ['Digit2'],
  slot3: ['Digit3'],
  slot4: ['Digit4'],
} as const;

/**
 * Keyboard/mouse state for gameplay. It owns no global side effects beyond the
 * listeners it registers, and every listener is removed in dispose().
 */
export class InputManager implements Disposable {
  private readonly element: HTMLElement;
  private readonly keys = new Set<string>();
  private lookX = 0;
  private lookY = 0;
  private fireHeld = false;
  private adsHeld = false;
  private firePressedThisFrame = false;
  private jumpPressedThisFrame = false;
  private reloadPressedThisFrame = false;
  private meleePressedThisFrame = false;
  private slotRequest: number | null = null;
  private enabled = true;
  /** True while the pointer sits over a menu control; suppresses gameplay input. */
  private pointerOverUi = false;

  constructor(element: HTMLElement) {
    this.element = element;
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.enabled) return;
    if (event.code === 'F3') return; // handled by the debug overlay toggle
    this.keys.add(event.code);
    if (KEY_BINDINGS.reload.includes(event.code as never)) {
      this.reloadPressedThisFrame = true;
      event.preventDefault();
    }
    if (KEY_BINDINGS.melee.includes(event.code as never)) this.meleePressedThisFrame = true;
    if (KEY_BINDINGS.jump.includes(event.code as never)) {
      this.jumpPressedThisFrame = true;
      // Space scrolls the page and re-activates the last focused button by default, which
      // would drop the player out of pointer lock on the first jump.
      event.preventDefault();
    }
    if (KEY_BINDINGS.slot1.includes(event.code as never)) this.slotRequest = 1;
    if (KEY_BINDINGS.slot2.includes(event.code as never)) this.slotRequest = 2;
    if (KEY_BINDINGS.slot3.includes(event.code as never)) this.slotRequest = 3;
    if (KEY_BINDINGS.slot4.includes(event.code as never)) this.slotRequest = 4;
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (!this.enabled) return;
    if (document.pointerLockElement !== this.element) return;
    this.lookX += event.movementX;
    this.lookY += event.movementY;
  };

  private readonly onMouseDown = (event: MouseEvent): void => {
    if (!this.enabled) return;
    // Right mouse aims. It is free: the trigger is button 0, and pointer lock is only ever
    // requested from the menu buttons (start / resume / restart), never from a canvas
    // click — so the button a browser usually reserves for its context menu is not spoken
    // for here.
    if (event.button === 2) {
      this.adsHeld = true;
      event.preventDefault();
      return;
    }
    if (event.button !== 0) return;
    this.fireHeld = true;
    this.firePressedThisFrame = true;
  };

  private readonly onMouseUp = (event: MouseEvent): void => {
    if (event.button === 2) {
      this.adsHeld = false;
      return;
    }
    if (event.button !== 0) return;
    this.fireHeld = false;
  };

  /**
   * Swallows the browser menu while the pointer is locked.
   *
   * Right mouse is the aim button, so without this the context menu would open over the
   * play area on the first aim press. Gated on pointer lock: a right click on a menu is a
   * normal browser gesture and must keep working.
   */
  private readonly onContextMenu = (event: MouseEvent): void => {
    if (!this.enabled) return;
    if (document.pointerLockElement !== this.element) return;
    event.preventDefault();
  };

  /** Losing pointer lock or focus must not leave the trigger stuck down. */
  private readonly onBlur = (): void => {
    this.keys.clear();
    this.fireHeld = false;
    this.adsHeld = false;
  };

  private readonly onVisibilityChange = (): void => {
    if (document.hidden) this.onBlur();
  };

  attach(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.keys.clear();
    this.fireHeld = false;
    this.adsHeld = false;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.keys.clear();
      this.fireHeld = false;
      this.adsHeld = false;
      this.jumpPressedThisFrame = false;
      this.lookX = 0;
      this.lookY = 0;
    }
  }

  setPointerOverUi(over: boolean): void {
    this.pointerOverUi = over;
    if (over) {
      this.lookX = 0;
      this.lookY = 0;
    }
  }

  private isDown(codes: readonly string[]): boolean {
    for (const code of codes) if (this.keys.has(code)) return true;
    return false;
  }

  /** Reads and clears per-frame state. Returns null when gameplay input is off. */
  consume(): InputSnapshot | null {
    if (!this.enabled || this.pointerOverUi) {
      this.lookX = 0;
      this.lookY = 0;
      this.firePressedThisFrame = false;
      this.jumpPressedThisFrame = false;
      this.reloadPressedThisFrame = false;
      this.meleePressedThisFrame = false;
      this.slotRequest = null;
      return null;
    }

    let forward = 0;
    let right = 0;
    if (this.isDown(KEY_BINDINGS.forward)) forward += 1;
    if (this.isDown(KEY_BINDINGS.back)) forward -= 1;
    if (this.isDown(KEY_BINDINGS.right)) right += 1;
    if (this.isDown(KEY_BINDINGS.left)) right -= 1;

    const snapshot: InputSnapshot = {
      forward,
      right,
      sprint: this.isDown(KEY_BINDINGS.sprint),
      lookX: this.lookX,
      lookY: this.lookY,
      firing: this.fireHeld,
      firePressed: this.firePressedThisFrame,
      jumpPressed: this.jumpPressedThisFrame,
      reloadPressed: this.reloadPressedThisFrame,
      meleePressed: this.meleePressedThisFrame,
      weaponSlotRequested: this.slotRequest,
      adsHeld: this.adsHeld,
    };

    this.lookX = 0;
    this.lookY = 0;
    this.firePressedThisFrame = false;
    this.jumpPressedThisFrame = false;
    this.reloadPressedThisFrame = false;
    this.meleePressedThisFrame = false;
    this.slotRequest = null;
    return snapshot;
  }
}
