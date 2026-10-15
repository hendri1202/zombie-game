import { AnimationClip, Group, LoadingManager, Object3D } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export interface LoadedModel {
  /** Root of the loaded hierarchy, owned by the caller after the promise resolves. */
  scene: Group;
  animations: AnimationClip[];
  url: string;
}

/** Single shipped copy of that atlas. */

export interface AssetFailure {
  url: string;
  message: string;
}

export interface AssetProgress {
  loaded: number;
  total: number;
  currentUrl: string;
}

/**
 * Loads the few external models the game needs and reports failure per file.
 *
 * Deliberately small: it is a loader cache with error reporting, not a general
 * asset pipeline. FBX is used because the verified CC0 Quaternius kit is
 * distributed in FBX/OBJ/Blend/glTF and only the FBX mirror was reachable in
 * this environment; GLTF stays supported for .glb/.gltf sources.
 */
export class AssetManager {
  private readonly cache = new Map<string, Promise<LoadedModel>>();
  private readonly manager = new LoadingManager();
  readonly failures: AssetFailure[] = [];
  onProgress: ((progress: AssetProgress) => void) | null = null;

  private inFlight = 0;
  private done = 0;
  private queued = 0;

  constructor() {
    this.manager.onError = (url) => {
      this.failures.push({ url, message: 'Network or decode error while loading asset' });
    };

    // No URL rewriting is needed any more: the FBX build referenced a shared
    // character atlas by bare filename, while every glTF file carries its buffers
    // and textures inline as base64.
  }

  /** Number of models requested so far, used for the loading bar. */
  get totalRequested(): number {
    return this.queued;
  }

  get loadedCount(): number {
    return this.done;
  }

  loadModel(url: string): Promise<LoadedModel> {
    const cached = this.cache.get(url);
    if (cached) return cached;

    this.queued += 1;
    this.inFlight += 1;

    const promise = this.loadFromDisk(url)
      .then((model) => {
        this.done += 1;
        this.inFlight -= 1;
        this.onProgress?.({ loaded: this.done, total: this.queued, currentUrl: url });
        return model;
      })
      .catch((error: unknown) => {
        this.inFlight -= 1;
        const message = error instanceof Error ? error.message : String(error);
        this.failures.push({ url, message });
        this.cache.delete(url);
        throw new Error(`Failed to load ${url}: ${message}`);
      });

    this.cache.set(url, promise);
    return promise;
  }

  private loadFromDisk(url: string): Promise<LoadedModel> {
    const lower = url.toLowerCase();
    if (lower.endsWith('.glb') || lower.endsWith('.gltf')) {
      const loader = new GLTFLoader(this.manager);
      return new Promise((resolve, reject) => {
        loader.load(url, (gltf) => {
          resolve({ scene: gltf.scene, animations: gltf.animations ?? [], url });
        }, undefined, (error) => reject(new Error(String(error))));
      });
    }

    // glTF is the only runtime model format (agents.md): FBX is a source format
    // that gets converted, so reaching here means a path is wrong.
    return Promise.reject(new Error(
      `Unsupported model format for "${url}": runtime assets must be .gltf or .glb.`,
    ));
  }

  /** Loads a list, collecting failures instead of rejecting the whole batch. */
  async loadAll(urls: string[]): Promise<Map<string, LoadedModel>> {
    const results = new Map<string, LoadedModel>();
    await Promise.all(urls.map(async (url) => {
      try {
        results.set(url, await this.loadModel(url));
      } catch (error) {
        console.error('[assets] failed:', url, error);
      }
    }));
    return results;
  }

  get isBusy(): boolean {
    return this.inFlight > 0;
  }

  clear(): void {
    this.cache.clear();
    this.failures.length = 0;
  }
}

/** Frees geometry/material/texture of a loaded hierarchy. */
export function disposeObject3D(root: Object3D): void {
  root.traverse((child) => {
    const mesh = child as Object3D & {
      geometry?: { dispose(): void };
      material?: { dispose(): void } | { dispose(): void }[];
    };
    mesh.geometry?.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) {
      for (const entry of material) entry.dispose();
    } else {
      material?.dispose();
    }
  });
}
