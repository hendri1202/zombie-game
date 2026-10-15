/**
 * Typed publish/subscribe bus.
 *
 * Subsystems (AI, combat, UI, audio) talk through events instead of importing
 * each other, which keeps the dependency graph acyclic: modules only depend on
 * this file and on shared types.
 */

/**
 * Any object type whose keys are the event names. Deliberately not
 * `Record<string, unknown>`: an interface without an index signature (which is
 * what `GameEvents` is) is not assignable to that.
 */
export type EventMap = object;

export type Unsubscribe = () => void;

/** Internal storage type. Handlers are re-narrowed on read in `emit`. */
type StoredHandler = (payload: never) => void;

export class EventBus<E extends EventMap> {
  private readonly handlers = new Map<keyof E, Set<StoredHandler>>();

  on<K extends keyof E>(type: K, handler: (payload: E[K]) => void): Unsubscribe {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set<StoredHandler>();
      this.handlers.set(type, set);
    }
    // One cast at the boundary: `Set` is invariant, so a handler that only
    // accepts E[K] cannot be stored as a handler accepting the union directly.
    set.add(handler as unknown as StoredHandler);
    return () => this.off(type, handler);
  }

  once<K extends keyof E>(type: K, handler: (payload: E[K]) => void): Unsubscribe {
    const off = this.on(type, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  off<K extends keyof E>(type: K, handler: (payload: E[K]) => void): void {
    const set = this.handlers.get(type);
    if (!set) return;
    set.delete(handler as unknown as StoredHandler);
    if (set.size === 0) this.handlers.delete(type);
  }

  emit<K extends keyof E>(type: K, payload: E[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    // Copy first so a handler that unsubscribes mid-emit cannot skip its peers.
    for (const handler of [...set]) {
      (handler as unknown as (p: E[K]) => void)(payload);
    }
  }

  clear(): void {
    this.handlers.clear();
  }

  listenerCount(type: keyof E): number {
    return this.handlers.get(type)?.size ?? 0;
  }
}
