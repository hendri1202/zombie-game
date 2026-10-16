#!/usr/bin/env node
/**
 * Writes the code-built weapon meshes to glTF.
 *
 * `src/player/proceduralWeapons.ts` builds eight extra weapon meshes from primitives. The
 * runtime loads glTF only, and `tests/weapon-assets.test.ts` fails the build unless a real
 * file sits behind every model path, so this script is how those meshes become shippable
 * assets: it builds each one and writes `public/assets/weapons/<File>.gltf`.
 *
 * Run it after any change to `proceduralWeapons.ts`:
 *
 *   node tools/export-weapon-models.mjs
 *
 * The output is self-contained — geometry and materials inline, and the single vertex
 * buffer embedded as a base64 data URI — which matches the pack's own files: nothing to
 * keep in sync and nothing to 404 at runtime.
 *
 * Node version: the script imports a TypeScript module, so it needs Node's built-in type
 * stripping (22.6+, on by default from 23.6). On older Node, run
 * `node --experimental-strip-types tools/export-weapon-models.mjs`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { PROCEDURAL_WEAPONS } from '../src/player/proceduralWeapons.ts';

/**
 * `FileReader` for Node.
 *
 * `GLTFExporter` turns its vertex buffer into a base64 data URI by calling
 * `readAsDataURL` on a `Blob`, and Node has no global `FileReader` (it has `Blob` and
 * `btoa`, just not that class). Fifteen lines here beat hand-assembling glTF JSON, which
 * would be a second implementation of the format to keep correct.
 */
class NodeFileReader {
  result = null;
  onloadend = null;
  onerror = null;

  static async toArrayBuffer(data) {
    if (data && typeof data.arrayBuffer === 'function') return await data.arrayBuffer();
    // A typed-array view: copy out exactly its window, not the whole backing buffer.
    if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    return data;
  }

  readAsDataURL(blob) {
    NodeFileReader.toArrayBuffer(blob)
      .then((buffer) => {
        // The same shape a browser produces for a Blob of this type, which is what the
        // glTF spec expects a buffer URI to look like.
        this.result = `data:application/octet-stream;base64,${Buffer.from(buffer).toString('base64')}`;
        this.onloadend?.();
      })
      .catch((error) => this.onerror?.(error));
  }

  readAsArrayBuffer(blob) {
    NodeFileReader.toArrayBuffer(blob)
      .then((buffer) => {
        this.result = buffer;
        this.onloadend?.();
      })
      .catch((error) => this.onerror?.(error));
  }
}

if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = NodeFileReader;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = join(repoRoot, 'public', 'assets', 'weapons');

const exporter = new GLTFExporter();
let written = 0;

await mkdir(outputDir, { recursive: true });

for (const weapon of PROCEDURAL_WEAPONS) {
  const mesh = weapon.build();
  const json = await exporter.parseAsync(mesh, { binary: false, onlyVisible: true });
  // Pretty-printed on purpose: these files are read in diffs and in the tests much more
  // often than they are downloaded, and the base64 buffer is the only bulky part.
  const text = `${JSON.stringify(json, null, 2)}\n`;
  const target = join(outputDir, `${weapon.file}.gltf`);
  await writeFile(target, text, 'utf8');
  const byteLength = Buffer.byteLength(text, 'utf8');
  console.log(`${weapon.kind.padEnd(7)} ${weapon.id.padEnd(13)} -> assets/weapons/${weapon.file}.gltf (${byteLength} bytes)`);
  written += 1;
}

console.log(`Wrote ${written} of ${PROCEDURAL_WEAPONS.length} weapon meshes to public/assets/weapons/`);
