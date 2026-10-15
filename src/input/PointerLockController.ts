import type { Disposable } from '../core/Disposable';

export type PointerLockStatus = 'unlocked' | 'locked' | 'denied' | 'unsupported';

/**
 * Wraps the Pointer Lock API.
 *
 * Pointer lock may only be requested from a user gesture, and browsers reject it
 * for reasons the player needs to hear (recently exited, not focused). Instead of
 * silently leaving the controls dead, the controller reports `denied` so the UI
 * can explain how to recover.
 */
export class PointerLockController implements Disposable {
  private readonly element: HTMLElement;
  private status: PointerLockStatus = 'unlocked';
  private listeners = new Set<(status: PointerLockStatus) => void>();
  private lastErrorReason = '';

  constructor(element: HTMLElement) {
    this.element = element;
    if (typeof this.element.requestPointerLock !== 'function') {
      this.status = 'unsupported';
    }
  }

  get isLocked(): boolean {
    return document.pointerLockElement === this.element;
  }

  get current(): PointerLockStatus {
    return this.status;
  }

  get errorReason(): string {
    return this.lastErrorReason;
  }

  onChange(listener: (status: PointerLockStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  private setStatus(next: PointerLockStatus, reason = ''): void {
    this.lastErrorReason = reason;
    if (this.status === next) return;
    this.status = next;
    for (const listener of [...this.listeners]) listener(next);
  }

  private readonly onPointerLockChange = (): void => {
    if (this.isLocked) this.setStatus('locked');
    else this.setStatus('unlocked');
  };

  private readonly onPointerLockError = (): void => {
    this.setStatus('denied', 'The browser refused pointer lock. Click the play area again, and make sure the tab is focused.');
  };

  attach(): void {
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('pointerlockerror', this.onPointerLockError);
  }

  dispose(): void {
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    document.removeEventListener('pointerlockerror', this.onPointerLockError);
    this.listeners.clear();
  }

  /** Must be called synchronously from a click/keydown handler. */
  request(): void {
    if (this.status === 'unsupported') return;
    if (this.isLocked) return;
    try {
      const result = this.element.requestPointerLock() as unknown;
      if (result instanceof Promise) {
        result.catch((error: unknown) => {
          this.setStatus('denied', error instanceof Error ? error.message : String(error));
        });
      }
    } catch (error) {
      this.setStatus('denied', error instanceof Error ? error.message : String(error));
    }
  }

  exit(): void {
    if (this.isLocked) document.exitPointerLock();
  }
}
