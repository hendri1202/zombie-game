/**
 * Ownership/lifecycle contract. Every subsystem that allocates GPU resources,
 * DOM listeners or timers implements this so a restart can return the game to a
 * clean state instead of stacking a second set of listeners on top of the first.
 */
export interface Disposable {
  dispose(): void;
}

export class DisposableGroup implements Disposable {
  private readonly items: Disposable[] = [];

  add<T extends Disposable>(item: T): T {
    this.items.push(item);
    return item;
  }

  addFn(fn: () => void): void {
    this.items.push({ dispose: fn });
  }

  dispose(): void {
    // Reverse order: children are released before their owners.
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      try {
        this.items[i].dispose();
      } catch (error) {
        console.error('[dispose] failed', error);
      }
    }
    this.items.length = 0;
  }
}
