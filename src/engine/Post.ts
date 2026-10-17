import {
  HalfFloatType,
  Vector2,
  WebGLRenderer,
  WebGLRenderTarget,
  ShaderMaterial,
  Scene,
  Camera,
  Color,
  Mesh,
  PlaneGeometry,
} from 'three';

export type BloomQuality = 'low' | 'medium' | 'high';

export interface BloomSettings {
  enabled: boolean;
  /** Normalized threshold for bright areas. */
  threshold: number;
  /** Strength of the blurred highlight contribution. */
  strength: number;
  /** Blur radius in pixels. */
  radius: number;
  /** Fixed post-scene full-screen draws while enabled. */
  estimatedExtraDrawCalls: number;
}

const QUALITY: Record<BloomQuality, BloomSettings> = {
  low: { enabled: false, threshold: 1, strength: 0, radius: 0, estimatedExtraDrawCalls: 0 },
  medium: { enabled: true, threshold: 0.82, strength: 0.45, radius: 3, estimatedExtraDrawCalls: 2 },
  high: { enabled: true, threshold: 0.78, strength: 0.65, radius: 5, estimatedExtraDrawCalls: 2 },
};

export function getBloomSettings(quality: BloomQuality): BloomSettings {
  return { ...QUALITY[quality] };
}

export function isBloomEnabled(quality: BloomQuality, toggle?: boolean): boolean {
  return toggle ?? QUALITY[quality].enabled;
}

const vertexShader = `varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }`;
const extractShader = `
  uniform sampler2D tInput; uniform float threshold; varying vec2 vUv;
  void main(){ vec3 c=texture2D(tInput,vUv).rgb; float l=max(max(c.r,c.g),c.b); gl_FragColor=vec4(c*max(l-threshold,0.0)/max(l,0.0001),1.0); }
`;
const compositeShader = `
  uniform sampler2D tInput; uniform sampler2D tBloom; uniform float strength; uniform vec2 texel; uniform float radius; varying vec2 vUv;
  void main(){ vec3 b=vec3(0.0); b+=texture2D(tBloom,vUv+texel*vec2(-1.0,0.0)*radius).rgb; b+=texture2D(tBloom,vUv+texel*vec2(1.0,0.0)*radius).rgb; b+=texture2D(tBloom,vUv+texel*vec2(0.0,-1.0)*radius).rgb; b+=texture2D(tBloom,vUv+texel*vec2(0.0,1.0)*radius).rgb; b*=0.25; gl_FragColor=vec4(texture2D(tInput,vUv).rgb+b*strength,1.0); }
`;

/**
 * Optional lightweight two-draw bloom pass. Compose explicitly around a caller-owned
 * scene render; it owns only its render targets/materials and never changes renderer setup.
 * Call render(scene,camera), then dispose() when no longer used.
 */
export class BloomPostProcessing {
  readonly settings: BloomSettings;
  private enabled: boolean;
  private size = new Vector2(1, 1);
  private source = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: true });
  private bloom = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false });
  private quad = new Mesh(new PlaneGeometry(2, 2));
  private scene = new Scene();
  private camera = new Camera();
  private extract: ShaderMaterial;
  private composite: ShaderMaterial;

  constructor(
    private readonly renderer: WebGLRenderer,
    quality: BloomQuality = 'medium',
    enabled?: boolean,
  ) {
    this.settings = getBloomSettings(quality);
    this.enabled = isBloomEnabled(quality, enabled);
    this.extract = new ShaderMaterial({ uniforms: { tInput: { value: this.source.texture }, threshold: { value: this.settings.threshold } }, vertexShader, fragmentShader: extractShader });
    this.composite = new ShaderMaterial({ uniforms: { tInput: { value: this.source.texture }, tBloom: { value: this.bloom.texture }, strength: { value: this.settings.strength }, texel: { value: new Vector2(1, 1) }, radius: { value: this.settings.radius } }, vertexShader, fragmentShader: compositeShader });
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  setEnabled(enabled: boolean): void { this.enabled = enabled; }
  isEnabled(): boolean { return this.enabled; }
  getEstimatedExtraDrawCalls(): number { return this.enabled ? 2 : 0; }

  render(scene: Scene, camera: Camera): void {
    if (!this.enabled) { this.renderer.render(scene, camera); return; }
    this.renderer.getSize(this.size);
    const width = Math.max(1, Math.floor(this.size.x * this.renderer.getPixelRatio()));
    const height = Math.max(1, Math.floor(this.size.y * this.renderer.getPixelRatio()));
    const previousAutoReset = this.renderer.info.autoReset;
    // Three resets `renderer.info` after each render() by default; that would leave only
    // the final composite quad in the diagnostic count. Aggregate the scene + both passes
    // as one frame so the extra two draw calls are measured, not hidden.
    this.renderer.info.reset();
    this.renderer.info.autoReset = false;
    try {
      this.source.setSize(width, height);
      this.bloom.setSize(Math.max(1, width >> 1), Math.max(1, height >> 1));
      this.renderer.setRenderTarget(this.source);
      this.renderer.render(scene, camera);
      this.renderer.setRenderTarget(this.bloom);
      this.quad.material = this.extract;
      this.renderer.render(this.scene, this.camera);
      this.renderer.setRenderTarget(null);
      this.composite.uniforms.texel.value.set(1 / width, 1 / height);
      this.quad.material = this.composite;
      this.renderer.render(this.scene, this.camera);
    } finally {
      this.renderer.info.autoReset = previousAutoReset;
    }
  }

  dispose(): void {
    this.source.dispose(); this.bloom.dispose(); this.extract.dispose(); this.composite.dispose(); this.quad.geometry.dispose();
  }
}

/** Reset the renderer's output color after compositing if caller uses a non-default clear color. */
export function bloomOutputColor(): Color { return new Color(0xffffff); }
