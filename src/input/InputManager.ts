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
  reloadPressed: boolean;
  weaponSlotRequested: number | null;
}

const KEY_BINDINGS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  reload: ['KeyR'],
  slot1: ['Digit1'],
  slot2: ['Digit2'],
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
  private firePressedThisFrame = false;
  private reloadPressedThisFrame = false;
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
    if (KEY_BINDINGS.slot1.includes(event.code as never)) this.slotRequest = 1;
    if (KEY_BINDINGS.slot2.includes(event.code as never)) this.slotRequest = 2;
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
    if (!this.enabled || event.button !== 0) return;
    this.fireHeld = true;
    this.firePressedThisFrame = true;
  };

  private readonly onMouseUp = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    this.fireHeld = false;
  };

  /** Losing pointer lock or focus must not leave the trigger stuck down. */
  private readonly onBlur = (): void => {
    this.keys.clear();
    this.fireHeld = false;
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
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.keys.clear();
    this.fireHeld = false;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.keys.clear();
      this.fireHeld = false;
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
      this.reloadPressedThisFrame = false;
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
      reloadPressed: this.reloadPressedThisFrame,
      weaponSlotRequested: this.slotRequest,
    };

    this.lookX = 0;
    this.lookY = 0;
    this.firePressedThisFrame = false;
    this.reloadPressedThisFrame = false;
    this.slotRequest = null;
    return snapshot;
  }
}
