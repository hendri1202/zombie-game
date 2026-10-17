import { defineConfig, type Plugin } from 'vite';

// Build configuration for the GitHub Pages copy of the game.
//
// The published site lives at https://hendri1202.github.io/zombie-game/, i.e. in
// a repository sub-path, and there is no dev server or rewrite rule in front of
// it. Two things have to line up for that to work:
//
//   1. `base`, so Vite writes index.html's script/link tags as
//      /zombie-game/assets/index-*.js instead of /assets/index-*.js.
//
//   2. The game's own asset paths, which are absolute string literals baked into
//      the sources ('/assets/weapons/Pistol.gltf', `/assets/audio/${file}`, ...).
//      `vite build --base` rewrites index.html only; it does not touch literals
//      inside the bundle. Untransformed, the bundle asks Pages for
//      https://hendri1202.github.io/assets/weapons/Pistol.gltf — a 404, because
//      the files are served from /zombie-game/assets/... The weapons, character
//      models, environment, vehicles and audio never arrive and the site shows an
//      empty menu. The plugin below prefixes those literals, and
//      tools/deploy-pages.sh refuses to publish a bundle that still has a bare
//      /assets/ literal in it.
//
// Only used by `npm run build:pages` / tools/deploy-pages.sh. Dev and tests keep
// using vite.config.ts, which has no base and no transform.
export const PAGES_BASE = '/zombie-game/';

// Vite loads this config through its own transform, where `process` exists. The
// project does not depend on @types/node (tsconfig types is just vite/client), so
// declare the single field used here instead of pulling in a new dependency.
declare const process: { env: Record<string, string | undefined> };

/** Counts occurrences (not lines: the minified bundle is a few very long lines). */
function countLiteral(code: string, quotePattern: string, path: string): number {
  const matches = code.match(new RegExp(`[${quotePattern}]${path}`, 'g'));
  return matches ? matches.length : 0;
}

/**
 * Rewrites absolute `/assets/...` path literals to `<base>assets/...`.
 *
 * Matching the quote that *opens* the literal, instead of `/assets/` anywhere in
 * the file, keeps the bundle's prose intact: one error message mentions
 * "public/assets/characters/zombies/", which must not be turned into a URL. The
 * bundle is minified with template literals (backticks), so all three quote
 * characters are handled.
 *
 * The rewrite runs in renderChunk as well as generateBundle: renderChunk happens
 * before chunk hashes are assigned, so the published filename changes whenever
 * the prefixed bundle changes (otherwise a deploy that only changes asset paths
 * would overwrite a URL the Pages CDN may still have cached). The second pass in
 * generateBundle is a no-op net — it counts what was actually written and fails
 * the build loudly if any bare literal survived minification.
 */
export function prefixAssetLiterals(base: string): Plugin {
  const prefix = base.endsWith('/') ? base.slice(0, -1) : base;
  const assetPattern = /(["'`])\/assets\//g;
  const prefixCode = (code: string) =>
    code.replace(assetPattern, (_match, quote: string) => `${quote}${prefix}/assets/`);

  return {
    name: 'pages-prefix-asset-literals',
    apply: 'build',
    renderChunk(code) {
      return prefixCode(code);
    },
    generateBundle(_options, bundle) {
      let lateFixes = 0;
      let prefixed = 0;
      let bare = 0;
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        const rewritten = prefixCode(output.code);
        if (rewritten !== output.code) {
          output.code = rewritten;
          lateFixes += 1;
        }
        prefixed += countLiteral(output.code, '"\'`', `${prefix}/assets/`);
        bare += countLiteral(output.code, '"\'`', '/assets/');
      }
      console.log(
        `[pages] base ${prefix}: ${prefixed} asset literal(s) prefixed, ${bare} left bare`
        + (lateFixes ? `, ${lateFixes} chunk(s) fixed after hashing (hash does not cover it)` : ''),
      );
      if (bare > 0) {
        throw new Error(
          `[pages] ${bare} absolute /assets/ literal(s) survived minification; `
          + 'the published bundle would request them from the site root and 404.',
        );
      }
      if (prefixed === 0) {
        throw new Error(
          '[pages] no /assets/ literals were found to prefix — the game\'s asset paths '
          + 'changed shape; re-check vite.config.pages.ts before publishing.',
        );
      }
    },
  };
}

export default defineConfig({
  base: PAGES_BASE,
  plugins: [prefixAssetLiterals(PAGES_BASE)],
  build: {
    target: 'es2022',
    // Kept out of `dist/` so a Pages build never overwrites the dev build, and
    // so tools/deploy-pages.sh is the only thing that decides what is published.
    // The script overrides this with PAGES_OUT_DIR to build in its scratch dir.
    outDir: process.env.PAGES_OUT_DIR || 'dist-pages',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
});
