import { defineConfig } from 'vitest/config';

export default defineConfig({
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
  test: {
    // Gameplay logic is tested without a DOM or WebGL context; anything that
    // needs a canvas (renderer, textures) is verified in the browser instead.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The reticle's stylesheet is read as source by tests/optics.test.ts, and Vitest replaces CSS
    // imports with an empty string unless it is told to process them — which would leave that
    // assertion passing on nothing at all.
    css: { include: [/src\/styles\//] },
  },
});
