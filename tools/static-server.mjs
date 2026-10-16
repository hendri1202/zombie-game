// Minimal static file server for the production build.
//
// Used instead of `npm run preview` because the Vite dev/preview server's
// dependency optimiser exceeded this sandbox's 1 GiB memory cgroup. Serving
// dist/ is also closer to how the game is actually deployed.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', 'dist');
const PORT = Number(process.env.PORT || 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.fbx': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.wav': 'audio/wav',
  '.bin': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
};

if (!existsSync(ROOT)) {
  console.error(`dist/ not found at ${ROOT}; run \`npm run build\` first.`);
  process.exit(1);
}

createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';
  // normalize() collapses '..'; the startsWith check below is the real guard.
  const target = join(ROOT, normalize(pathname));

  if (!target.startsWith(ROOT) || !existsSync(target) || !statSync(target).isFile()) {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end(`404 ${pathname}`);
    return;
  }

  const size = statSync(target).size;
  response.writeHead(200, {
    'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'content-length': size,
    'cache-control': 'no-store',
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(target).pipe(response);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}/`);
});
