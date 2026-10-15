import { ACESFilmicToneMapping, PCFSoftShadowMap, WebGLRenderer } from 'three';
import type { QualityPreset } from '../app/gameConfig';

export interface RendererResult {
  renderer: WebGLRenderer | null;
  /** Human-readable reason when `renderer` is null. */
  failureReason: string | null;
  /** Which attempt succeeded, for the debug overlay. */
  mode: 'antialiased' | 'fallback' | 'none';
}

/**
 * Creates the WebGL renderer, retrying with weaker settings before declaring the
 * device unsupported: some drivers reject the first antialiased context request
 * even though a plain one succeeds, and reporting "WebGL unsupported" for that
 * would be wrong.
 */
export function createRenderer(canvas: HTMLCanvasElement, quality: QualityPreset): RendererResult {
  const attempts: Array<{ antialias: boolean; label: RendererResult['mode'] }> = [
    { antialias: quality.antialias, label: 'antialiased' },
    { antialias: false, label: 'fallback' },
  ];

  let lastError = '';
  for (const attempt of attempts) {
    try {
      const renderer = new WebGLRenderer({
        canvas,
        antialias: attempt.antialias,
        powerPreference: attempt.antialias ? 'high-performance' : 'default',
        stencil: false,
      });
      renderer.outputColorSpace = 'srgb';
      renderer.toneMapping = ACESFilmicToneMapping;
      // ACES pulls midtones down hard; at 1.05 the night level measured a mean
      // luminance of 12/255, which hid silhouettes and the road surface.
      renderer.toneMappingExposure = 1.35;
      renderer.shadowMap.enabled = quality.shadows;
      renderer.shadowMap.type = PCFSoftShadowMap;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatioCap));
      return {
        renderer,
        failureReason: null,
        mode: attempt.label,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      console.warn(`[renderer] attempt "${attempt.label}" failed:`, lastError);
    }
  }

  const hasWebgl2 = (() => {
    try {
      const probe = document.createElement('canvas');
      return probe.getContext('webgl2') !== null;
    } catch {
      return false;
    }
  })();

  return {
    renderer: null,
    mode: 'none',
    failureReason: hasWebgl2
      ? `WebGL2 is available but the renderer could not be created (${lastError}).`
      : 'This browser does not expose WebGL2. Dead District needs WebGL2 (Chrome, Edge, Firefox or Safari up to date) with hardware acceleration enabled.',
  };
}

export function applyQuality(renderer: WebGLRenderer, quality: QualityPreset): void {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatioCap));
  renderer.shadowMap.enabled = quality.shadows;
  if (quality.shadows) renderer.shadowMap.type = PCFSoftShadowMap;
  // Antialiasing is baked into the context at creation time; a tier change
  // requires a reload, which the settings screen states explicitly.
}
