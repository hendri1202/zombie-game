import {
  AdditiveBlending, AmbientLight, BufferAttribute, BufferGeometry, CanvasTexture, Color, DirectionalLight,
  DoubleSide, Fog, Group, HemisphereLight, LinearFilter, Mesh, MeshBasicMaterial, PlaneGeometry, Points,
  PointsMaterial, Scene, SRGBColorSpace,
} from 'three';
import type { QualityPreset } from '../app/gameConfig';

export interface LightingHandle {
  sun: DirectionalLight;
  hemi: HemisphereLight;
  ambient: AmbientLight;
  /** Mean luminance of the sky gradient, so a harness can report the mood. */
  skyHorizon: string;
  applyQuality(quality: QualityPreset): void;
  dispose(): void;
}

/** Stars scattered on a dome shell above the fog, so they fade nothing else out. */
function createStarField(count: number): Points {
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    // Upper hemisphere only: a star below the horizon would show through the road.
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(Math.random() * 0.92);
    const radius = 330;
    positions[i * 3] = Math.sin(phi) * Math.cos(theta) * radius;
    positions[i * 3 + 1] = Math.cos(phi) * radius * 0.55 + 30;
    positions[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * radius;
    sizes[i] = 1 + Math.random() * 1.6;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  const material = new PointsMaterial({
    color: 0xd8e2ff,
    size: 1.5,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.75,
    fog: false,
    depthWrite: false,
  });
  const points = new Points(geometry, material);
  points.frustumCulled = false;
  return points;
}

/**
 * Vertical night-sky gradient.
 *
 * A flat `scene.background` colour was the single biggest reason the game read as
 * "everything is black": the whole upper half of every frame was one near-black
 * value, so building silhouettes had nothing to be read against. A gradient gives
 * the rooflines a horizon band to cut into, and costs one small texture and no
 * geometry.
 */
function createSkyTexture(zenith: Color, horizon: Color): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 256;
  const context = canvas.getContext('2d');
  if (!context) return new CanvasTexture(canvas);
  const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, `#${zenith.getHexString()}`);
  gradient.addColorStop(0.55, `#${zenith.clone().lerp(horizon, 0.45).getHexString()}`);
  gradient.addColorStop(0.86, `#${horizon.getHexString()}`);
  gradient.addColorStop(1, `#${horizon.clone().lerp(new Color(0x0b0f18), 0.5).getHexString()}`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Warm pool of light on the road under a street lamp.
 *
 * Emissive sphere + additive ground disc reads as a lit lamp for two draw calls
 * and no dynamic light, which matters because the shadow pass already has to
 * carry dozens of skinned zombies.
 */
function createLampPool(size: number): Mesh {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  if (context) {
    const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, 'rgba(255, 205, 140, 0.82)');
    gradient.addColorStop(0.45, 'rgba(255, 180, 110, 0.3)');
    gradient.addColorStop(0.75, 'rgba(255, 170, 100, 0.11)');
    gradient.addColorStop(1, 'rgba(255, 160, 90, 0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const geometry = new PlaneGeometry(size, size);
  const material = new MeshBasicMaterial({
    map: texture,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    fog: true,
    side: DoubleSide,
  });
  const pool = new Mesh(geometry, material);
  pool.rotation.x = -Math.PI / 2;
  pool.renderOrder = 1;
  const mesh = pool as Mesh & { userData: Record<string, unknown> };
  mesh.userData.texture = texture;
  return mesh;
}

/**
 * Dusk/night city lighting: one shadow-casting directional light plus ambient and
 * hemisphere fill, a gradient sky, a star field and emissive lamp pools.
 *
 * All of it is deliberately light on dynamic lights — the shadow pass has to stay
 * affordable once dozens of animated zombies are on screen.
 */
export function setupLighting(scene: Scene, quality: QualityPreset, fogFar: number): LightingHandle {
  // Moonlit street rather than a black void: the zenith stays deep so the sky still
  // reads as night, but the horizon is lifted enough for silhouettes to register.
  const zenith = new Color(0x0d1626);
  const horizon = new Color(0x2c3d5c);

  const sky = createSkyTexture(zenith, horizon);
  scene.background = sky;
  const fogColor = horizon.clone().lerp(new Color(0x1a2233), 0.55);
  scene.fog = new Fog(fogColor, 30, fogFar);

  const hemi = new HemisphereLight(0x5a6f9c, 0x26282e, 1.25);
  scene.add(hemi);

  const ambient = new AmbientLight(0x3d4a6b, 0.6);
  scene.add(ambient);

  // Low, warm, off-axis sun: long shadows and enough specular to read surfaces.
  const sun = new DirectionalLight(0xffcb92, 1.5);
  sun.position.set(-46, 30, 34);
  sun.castShadow = quality.shadows;
  sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 160;
  const extent = 62;
  sun.shadow.camera.left = -extent;
  sun.shadow.camera.right = extent;
  sun.shadow.camera.top = extent;
  sun.shadow.camera.bottom = -extent;
  sun.shadow.bias = -0.0009;
  sun.shadow.normalBias = 0.03;
  scene.add(sun);
  scene.add(sun.target);

  const stars = createStarField(420);
  scene.add(stars);

  return {
    sun,
    hemi,
    ambient,
    skyHorizon: `#${fogColor.getHexString()}`,
    applyQuality(next: QualityPreset) {
      sun.castShadow = next.shadows;
      if (sun.shadow.map && sun.shadow.mapSize.width !== next.shadowMapSize) {
        // Force three.js to rebuild the shadow map at the new resolution.
        sun.shadow.map.dispose();
        sun.shadow.map = null as unknown as typeof sun.shadow.map;
      }
      sun.shadow.mapSize.set(next.shadowMapSize, next.shadowMapSize);
      if (scene.fog instanceof Fog) {
        scene.fog.far = next.fogFar;
      }
    },
    dispose() {
      scene.remove(sun);
      scene.remove(sun.target);
      scene.remove(hemi);
      scene.remove(ambient);
      scene.remove(stars);
      sun.dispose();
      hemi.dispose();
      ambient.dispose();
      sun.shadow.map?.dispose();
      stars.geometry.dispose();
      (stars.material as PointsMaterial).dispose();
      if (scene.background === sky) scene.background = null;
      sky.dispose();
    },
  };
}

export interface StudioLights {
  group: Group;
  /** Moves the rig to the subject and switches it on. */
  focusOn(x: number, y: number, z: number): void;
  setEnabled(enabled: boolean): void;
  dispose(): void;
}

/**
 * Three-point lighting for the survivor showcase on the title screen.
 *
 * The night level is deliberately dark, which makes it a bad place to judge a
 * character model, so the menu gets its own key/rim/fill rig that is switched off
 * entirely once a run starts. None of the three cast shadows, so they add nothing
 * to the shadow pass.
 */
export function createStudioLights(): StudioLights {
  const group = new Group();
  const key = new DirectionalLight(0xfff2e0, 2.4);
  key.position.set(3.4, 3.6, 4.6);
  /**
   * The key light casts a shadow with a frustum just wide enough for one person.
   * That is what stops the character reading as pasted onto the road: the level's
   * own sun shadow is far too coarse (62 m across a 2048 map) to give a contact
   * shadow under a pair of boots. Menu-only, so it costs nothing during a run.
   */
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 14;
  key.shadow.camera.left = -2.2;
  key.shadow.camera.right = 2.2;
  key.shadow.camera.top = 2.6;
  key.shadow.camera.bottom = -2.6;
  key.shadow.bias = -0.0008;
  key.shadow.normalBias = 0.02;
  const rim = new DirectionalLight(0xa8c8ff, 1.8);
  rim.position.set(-3.8, 3, -4.4);
  const fill = new DirectionalLight(0xd8e4ff, 0.8);
  fill.position.set(-4.4, 1.7, 3.4);
  const lights = [key, rim, fill];
  for (const light of lights) {
    // Only the key casts; a rim and a fill shadow would fight the key's.
    if (light !== key) light.castShadow = false;
    group.add(light);
    group.add(light.target);
  }
  group.visible = false;

  return {
    group,
    focusOn(x, y, z) {
      group.position.set(x, y, z);
    },
    setEnabled(enabled) {
      group.visible = enabled;
    },
    dispose() {
      for (const light of lights) {
        light.dispose();
        light.target.removeFromParent();
      }
      key.shadow.map?.dispose();
      key.shadow.map = null as unknown as typeof key.shadow.map;
      group.removeFromParent();
      group.clear();
    },
  };
}

/** Exported for the level's lamp building, which owns the pool in its dispose list. */
export { createLampPool };
