import {
  CanvasTexture, ClampToEdgeWrapping, RepeatWrapping, SRGBColorSpace, Texture,
} from 'three';

/**
 * Procedural canvas textures.
 *
 * Everything visual that is not a downloaded CC0 model is generated here, which
 * keeps the project free of third-party texture licenses and of binary assets
 * that would need checking before every commit.
 */

function makeCanvas(width: number, height: number): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas context unavailable');
  return context;
}

function finish(context: CanvasRenderingContext2D, repeatX = 1, repeatY = 1): Texture {
  const texture = new CanvasTexture(context.canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(repeatX, repeatY);
  texture.anisotropy = 4;
  return texture;
}

/** Wet asphalt with lane paint and patchy grime. */
export function createRoadTexture(repeat = 8): Texture {
  const context = makeCanvas(256, 256);
  context.fillStyle = '#26282d';
  context.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2600; i += 1) {
    const shade = 30 + Math.random() * 26;
    context.fillStyle = `rgba(${shade},${shade + 2},${shade + 6},0.5)`;
    context.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  // dashed centre line
  context.fillStyle = 'rgba(226,220,190,0.55)';
  for (let y = 0; y < 256; y += 64) context.fillRect(126, y + 8, 4, 34);
  // grime streaks
  context.fillStyle = 'rgba(12,12,14,0.35)';
  for (let i = 0; i < 12; i += 1) {
    context.fillRect(Math.random() * 256, 0, 6 + Math.random() * 18, 256);
  }
  return finish(context, repeat, repeat);
}

/** Sidewalk / concrete slabs. */
export function createSidewalkTexture(repeat = 6): Texture {
  const context = makeCanvas(256, 256);
  context.fillStyle = '#41434a';
  context.fillRect(0, 0, 256, 256);
  context.strokeStyle = 'rgba(24,25,28,0.75)';
  context.lineWidth = 3;
  for (let i = 0; i <= 256; i += 64) {
    context.beginPath();
    context.moveTo(i, 0);
    context.lineTo(i, 256);
    context.moveTo(0, i);
    context.lineTo(256, i);
    context.stroke();
  }
  context.fillStyle = 'rgba(90,90,96,0.18)';
  for (let i = 0; i < 900; i += 1) {
    context.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  return finish(context, repeat, repeat);
}

/** Dirty ground outside the streets. */
export function createDirtTexture(repeat = 24): Texture {
  const context = makeCanvas(256, 256);
  context.fillStyle = '#22242a';
  context.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 4000; i += 1) {
    const shade = 26 + Math.random() * 30;
    context.fillStyle = `rgba(${shade},${shade - 2},${shade - 6},0.6)`;
    context.fillRect(Math.random() * 256, Math.random() * 256, 3, 3);
  }
  const texture = finish(context, repeat, repeat);
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  return texture;
}

/**
 * Building facade: a base wall colour plus lit/unlit windows. Emissive maps make
 * the city read at dusk without adding dynamic lights.
 */
export function createFacadeTextures(wallColor: string, seed: number): { map: Texture; emissiveMap: Texture } {
  const width = 256;
  const height = 256;
  const mapCtx = makeCanvas(width, height);
  const emissiveCtx = makeCanvas(width, height);

  mapCtx.fillStyle = wallColor;
  mapCtx.fillRect(0, 0, width, height);
  for (let i = 0; i < 1500; i += 1) {
    mapCtx.fillStyle = `rgba(0,0,0,${Math.random() * 0.14})`;
    mapCtx.fillRect(Math.random() * width, Math.random() * height, 4, 4);
  }

  emissiveCtx.fillStyle = '#000000';
  emissiveCtx.fillRect(0, 0, width, height);

  const columns = 5;
  const rows = 6;
  const cellW = width / columns;
  const cellH = height / rows;
  let seedValue = seed >>> 0;
  const rand = (): number => {
    seedValue = (seedValue * 1664525 + 1013904223) >>> 0;
    return seedValue / 4294967296;
  };

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = column * cellW + cellW * 0.22;
      const y = row * cellH + cellH * 0.2;
      const w = cellW * 0.56;
      const h = cellH * 0.5;

      mapCtx.fillStyle = '#0b0d12';
      mapCtx.fillRect(x, y, w, h);

      if (rand() > 0.66) {
        const glow = rand() > 0.5 ? '#ffd9a0' : '#9fd3ff';
        emissiveCtx.fillStyle = glow;
        emissiveCtx.fillRect(x, y, w, h);
      }
    }
  }

  const map = finish(mapCtx, 2, 2);
  const emissiveMap = finish(emissiveCtx, 2, 2);
  return { map, emissiveMap };
}
