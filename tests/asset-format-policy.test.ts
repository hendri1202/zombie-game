import { describe, expect, it } from 'vitest';

/**
 * Enforces the glTF-only runtime format policy from `agents.md`.
 *
 * A format rule is easy to state and easy to break with one pasted path, so it is
 * checked mechanically. The files are read through Vite's raw glob rather than
 * `node:fs`, which keeps the test running against the same `vite/client` types the
 * rest of the suite uses instead of pulling in Node type definitions.
 */
const SOURCES = import.meta.glob('/src/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** Matches a quoted string literal whose value is an FBX path. */
const FBX_LITERAL = /["'`][^"'`]*\.fbx["'`]/gi;

describe('runtime asset format policy', () => {
  it('reads the source tree', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(20);
  });

  it('names no FBX path anywhere in src', () => {
    const offenders: string[] = [];
    for (const [file, text] of Object.entries(SOURCES)) {
      // Comments are allowed to talk about FBX being a source format; only quoted
      // literals are paths the loader would be handed.
      for (const match of text.matchAll(FBX_LITERAL)) {
        offenders.push(`${file}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('routes every model through GLTFLoader and offers no FBXLoader', () => {
    const manager = SOURCES['/src/core/AssetManager.ts'];
    expect(manager).toBeTruthy();
    expect(manager).toContain('GLTFLoader');
    expect(manager).not.toContain('FBXLoader');
  });

  it('rejects a non-glTF path instead of falling back to another loader', () => {
    const manager = SOURCES['/src/core/AssetManager.ts'];
    expect(manager).toContain('Unsupported model format');
  });
});
