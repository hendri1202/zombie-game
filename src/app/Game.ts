import {
  AnimationClip, Box3, Color, Frustum, Group, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  Object3D, PerspectiveCamera, Quaternion, Scene, Vector3, WebGLRenderTarget,
} from 'three';

import {
  QUALITY_PRESETS, SHOWCASE, STARTING_WEAPON, SURVIVOR_ASSET_ROOT, WEAPON_FEEL, WEAPONS, WORLD,
  type QualityTier, type WeaponId, type ZombieKind,
} from './gameConfig';
import { findCharacter, type CharacterId, type CharacterSpec } from './characters';
import { EventBus } from '../core/EventBus';
import { GameLoop } from '../core/GameLoop';
import { GameState, type GamePhase } from '../core/GameState';
import { AssetManager, disposeObject3D } from '../core/AssetManager';
import { createRenderer, applyQuality } from '../engine/Renderer';
import { createStudioLights, setupLighting, type LightingHandle, type StudioLights } from '../engine/Lighting';
import { InputManager } from '../input/InputManager';
import { PointerLockController } from '../input/PointerLockController';
import { PlayerController } from '../player/PlayerController';
import { showcaseLookYawOffset } from '../player/viewCamera';
import { PlayerHealth } from '../player/PlayerHealth';
import { PlayerAvatar } from '../player/PlayerAvatar';
import { WeaponController } from '../player/WeaponController';
import { DamageSystem } from '../combat/DamageSystem';
import { ZombieFactory } from '../zombies/ZombieFactory';
import { ZombieDirector } from '../zombies/ZombieDirector';
import { NavigationGrid } from '../zombies/NavigationGrid';
import { buildCityLevel, type CityLevelHandle } from '../level/CityLevel';
import { WaveManager } from '../systems/WaveManager';
import { PickupManager } from '../systems/PickupManager';
import { AudioManager } from '../systems/AudioManager';
import { ImpactEffects } from '../systems/ImpactEffects';
import { MuzzleFlash } from '../systems/MuzzleFlash';
import { Tracers } from '../systems/Tracers';
import { HUD } from '../ui/HUD';
import { Menus } from '../ui/Menus';
import { SettingsStore, type SettingsValues } from '../ui/Settings';
import { SeededRandom } from '../utils/math';
import type { GameEvents } from './GameEvents';

const ZOMBIE_KINDS: ZombieKind[] = ['walker', 'runner', 'tank'];
/** Reference up axis for working out which way "right of the weapon" points. */
const WORLD_UP = new Vector3(0, 1, 0);
const VIEW_MODEL_LENGTH = 0.42;

export interface GameBootstrap {
  canvas: HTMLCanvasElement;
}

export interface DebugInfo {
  phase: string;
  loadingFailures: string[];
  zombieKinds: ZombieKind[];
  clipInventory: Array<{
    kind: ZombieKind;
    clips: string[];
    mapping: Record<string, string | null>;
    motion: Array<{ name: string; duration: number; horizontalTravel: number; verticalRange: number; cadence: number }>;
  }>;
  activeZombies: number;
  pooledZombies: number;
  engagedZombies: number;
  zombieStates: string[];
  zombiePositions: Array<[number, number, number]>;
  wave: number;
  wavePhase: string;
  remainingInWave: number;
  stragglersRecalled: number;
  kills: number;
  hitsLanded: number;
  headshots: number;
  playerHealth: number;
  playerAlive: boolean;
  playerPosition: [number, number];
  playerYaw: number;
  playerPitch: number;
  /** World-space hitbox count and heights per zombie, for hit-detection debugging. */
  hitboxReport: Array<{ kind: string; alive: boolean; hitboxes: number; headY: number | null; rootY: number }>;
  weapon: string;
  magazine: number;
  reserve: number;
  reloading: boolean;
  ownedWeapons: WeaponId[];
  characterId: string;
  /** Facing handed to the avatar, and the angle the player is actually aiming at. */
  avatarFacing: number | null;
  gearAttached: string[];
  gearSkipped: string[];
  playerFacing: number;
  avatarFacingSource: string;
  characterName: string;
  characterFile: string;
  characterPending: string | null;
  characterMaxHealth: number;
  playerWalkSpeed: number;
  playerSprintSpeed: number;
  cameraPosition: [number, number, number] | null;
  avatarVisible: boolean;
  avatarState: string;
  avatarClips: { idle: string | null; walk: string | null; run: string | null };
  avatarPosition: [number, number, number] | null;
  viewMode: string;
  weaponViewModelVisible: boolean;
  showcaseActive: boolean;
  sensitivity: number;
  masterVolume: number;
  shadowMapEnabled: boolean;
  activeZombieCap: number;
  debugOverlayVisible: boolean;
  pickups: number;
  activeImpacts: number;
  activeCasings: number;
  muzzleFlashActive: number;
  muzzleSmokeActive: number;
  muzzleFlashSpawned: number;
  tracersActive: number;
  tracersSpawned: number;
  collisionBoxes: number;
  walkableRatio: number;
  fps: number;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
}

export interface DebugSnapshot {
  fps: number;
  activeZombies: number;
  engagedZombies: number;
  pooledZombies: number;
  wave: number;
  phase: string;
  collisionBoxes: number;
  walkableRatio: number;
  drawCalls: number;
  triangles: number;
}

/**
 * Application orchestrator.
 *
 * It owns the subsystems and the phase machine, and is the only place that
 * knows how they fit together; the systems themselves know nothing about each
 * other. Everything is created in `init()` after the renderer check, so a device
 * without WebGL2 gets a readable message instead of a black canvas.
 */
export class Game {
  private readonly canvas: HTMLCanvasElement;
  private readonly events = new EventBus<GameEvents>();
  private readonly state = new GameState();
  private readonly assets = new AssetManager();
  private readonly settings = new SettingsStore();
  /** Reused so ejecting a casing per shot allocates nothing. */
  private readonly casingOrigin = new Vector3();
  private readonly casingDirection = new Vector3();
  private readonly casingRight = new Vector3();
  private readonly random = new SeededRandom(0x5eed);

  private renderer: ReturnType<typeof createRenderer>['renderer'] = null;
  private scene: Scene | null = null;
  private camera: PerspectiveCamera | null = null;
  private lighting: LightingHandle | null = null;
  private navigation: NavigationGrid | null = null;
  private level: CityLevelHandle | null = null;
  private factory: ZombieFactory | null = null;
  private director: ZombieDirector | null = null;
  private damage: DamageSystem | null = null;
  private player: PlayerController | null = null;
  private health: PlayerHealth | null = null;
  private avatar: PlayerAvatar | null = null;
  private studio: StudioLights | null = null;
  private weapons: WeaponController | null = null;
  private waves: WaveManager | null = null;
  private pickups: PickupManager | null = null;
  private audio: AudioManager | null = null;
  private impacts: ImpactEffects | null = null;
  private muzzleFlash: MuzzleFlash | null = null;
  private tracers: Tracers | null = null;
  /** Last point a shot landed on, so a tracer can stop there instead of at max range. */
  private readonly lastHitPoint = new Vector3();
  private hitPointValid = false;
  private shotsFired = 0;
  private readonly aimScratch = new Vector3();
  private readonly muzzleScratch = new Vector3();
  private readonly tracerEnd = new Vector3();
  private hud: HUD | null = null;
  private menus: Menus | null = null;
  private input: InputManager | null = null;
  private pointerLock: PointerLockController | null = null;
  private loop: GameLoop | null = null;
  private unbindAudio: (() => void) | null = null;

  private availableKinds: ZombieKind[] = [];
  private loadFailures: string[] = [];
  /** Survivor currently loaded into the scene. */
  private characterId: CharacterId = 'lis';
  private characterSpec: CharacterSpec | null = null;
  private characterPending: CharacterId | null = null;
  /** Clips of the loaded survivor, kept for diagnostics. */
  private characterClips: AnimationClip[] = [];
  /** Advance of the title-screen showcase orbit, seconds. */
  private showcaseTime = 0;
  private fps = 0;
  /** Seconds since the last FPS sample; the divisor for the frame count. */
  private frameAccumulator = 0;
  private frameCount = 0;
  private kills = 0;
  private hitsLanded = 0;
  private headshots = 0;
  private waveReached = 1;
  private runSeconds = 0;
  private debugVisible = false;
  private disposed = false;

  constructor(bootstrap: GameBootstrap) {
    this.canvas = bootstrap.canvas;
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  async init(): Promise<void> {
    const values = this.settings.current;
    const quality = QUALITY_PRESETS[values.quality];

    const rendererResult = createRenderer(this.canvas, quality);
    if (!rendererResult.renderer) {
      // Actionable failure, never a blank screen.
      this.failBeforeUi(rendererResult.failureReason ?? 'WebGL is unavailable.');
      return;
    }
    this.renderer = rendererResult.renderer;
    console.info(`[renderer] created in "${rendererResult.mode}" mode`);

    this.scene = new Scene();
    this.camera = new PerspectiveCamera(76, this.canvas.clientWidth / this.canvas.clientHeight || 1.6, 0.08, 420);
    this.scene.add(this.camera);
    this.resize();

    this.lighting = setupLighting(this.scene, quality, quality.fogFar);
    this.navigation = new NavigationGrid(WORLD.playArea);

    // --- UI ---------------------------------------------------------------
    this.hud = new HUD(this.events);
    this.menus = new Menus({
      onStart: () => this.startRun(),
      onResume: () => this.resume(),
      onRestart: () => this.restartRun(),
      onExitToTitle: () => this.exitToTitle(),
      onOpenSettings: () => this.menus?.showScreen('settings'),
      onCloseSettings: () => this.menus?.showScreen(this.state.phase === 'paused' ? 'pause' : 'title'),
      onQualityChange: (tier) => this.changeQuality(tier),
      onSettingsChange: (change) => this.applySettingChange(change),
      onCharacterSelect: (id) => this.selectCharacter(id),
    });
    this.menus.setCreditsHtml(this.buildCreditsHtml());
    this.menus.paintSettings(values);
    this.menus.onPointerOverUi((over) => this.input?.setPointerOverUi(over));
    this.state.onChange((phase) => this.onPhaseChange(phase));

    // --- assets -----------------------------------------------------------
    this.assets.onProgress = ({ loaded, total, currentUrl }) => {
      const name = currentUrl.split('/').pop() ?? currentUrl;
      this.menus?.setLoading(total > 0 ? loaded / total : 0, `Loading ${name} (${loaded}/${total})`);
    };

    this.menus.setLoading(0.02, 'Building the city block…');
    this.level = await buildCityLevel({
      scene: this.scene,
      assets: this.assets,
      quality,
      navigation: this.navigation,
    });

    this.menus.setLoading(0.3, 'Loading character models…');
    this.factory = new ZombieFactory({ assets: this.assets });
    const loadResult = await this.factory.load(ZOMBIE_KINDS);
    this.availableKinds = loadResult.loaded;
    for (const kind of loadResult.failed) {
      this.loadFailures.push(`character "${kind}" could not be loaded`);
    }
    for (const failure of this.assets.failures) {
      this.loadFailures.push(`${failure.url.split('/').pop()}: ${failure.message}`);
    }
    for (const entry of this.factory.clipInventory) {
      console.info(`[anim] ${entry.kind} clip mapping:`, JSON.stringify(entry.mapping));
    }

    if (loadResult.loaded.length === 0) {
      this.menus.setLoading(1, 'Character models failed to load.');
      this.menus.showLoadError(
        'No zombie character model could be loaded from public/assets/characters/zombies/. '
        + 'The game cannot start without them. Check that the files exist and that the dev server serves /assets.',
      );
      this.menus.setTitleNote('Character models missing — see the loading screen for details.');
      this.menus.showScreen('loading');
      return;
    }

    // --- view models ------------------------------------------------------
    this.menus.setLoading(0.75, 'Preparing weapons…');
    const viewModels = await this.loadViewModels();

    // --- systems ----------------------------------------------------------
    this.menus.setLoading(0.9, 'Starting systems…');
    this.player = new PlayerController({ camera: this.camera, collision: this.level.collision });
    this.health = new PlayerHealth();
    this.director = new ZombieDirector({
      scene: this.scene,
      factory: this.factory,
      collision: this.level.collision,
      navigation: this.navigation,
      events: this.events,
      random: this.random,
    });
    this.damage = new DamageSystem({
      director: this.director,
      collision: this.level.collision,
      events: this.events,
      random: this.random,
    });
    this.weapons = new WeaponController({
      camera: this.camera,
      events: this.events,
      damage: this.damage,
      player: this.player,
      viewModels,
    });
    this.waves = new WaveManager({
      events: this.events,
      spawner: this.director,
      random: this.random,
      activeCap: quality.zombieCap,
      availableKinds: this.availableKinds,
    });
    this.pickups = new PickupManager({
      scene: this.scene,
      events: this.events,
      random: this.random,
      collision: this.level.collision,
    });
    this.audio = new AudioManager();
    this.unbindAudio = this.audio.bind(this.events);
    this.impacts = new ImpactEffects({
      scene: this.scene,
      budget: quality.particleBudget,
      random: this.random,
    });
    // The flash and tracers are never gated on the particle budget: they are the
    // feedback that tells the player a shot happened at all, and eight quads cost
    // less than the draw calls already in the frame.
    this.muzzleFlash = new MuzzleFlash({
      scene: this.scene,
      camera: this.camera,
      budget: WEAPON_FEEL.flashQuads,
      random: this.random,
    });
    this.tracers = new Tracers({ scene: this.scene, camera: this.camera, budget: 8 });

    this.input = new InputManager(this.canvas);
    this.input.attach();
    this.pointerLock = new PointerLockController(this.canvas);
    this.pointerLock.attach();
    this.pointerLock.onChange((status) => this.onPointerLockChange(status));

    this.events.on('zombie:killed', ({ kind }) => {
      this.kills += 1;
      void kind;
    });
    this.events.on('combat:hit', ({ zone }) => {
      this.hitsLanded += 1;
      if (zone === 'head') this.headshots += 1;
    });
    this.events.on('wave:started', ({ wave }) => {
      this.waveReached = Math.max(this.waveReached, wave);
    });
    this.events.on('combat:hit', ({ killed, zone, point }) => {
      // Head hits get a distinct flare so the headshot multiplier is visible.
      this.impacts?.spawn(point[0], point[1], point[2], zone === 'head' ? 2 : 1);
      this.lastHitPoint.set(point[0], point[1], point[2]);
      this.hitPointValid = true;
      if (killed) this.rollDrop(point[0], point[2]);
    });
    this.events.on('weapon:fired', ({ origin, direction, weaponId }) => {
      // Eject from slightly right of and below the muzzle, along the shot.
      this.casingDirection.set(direction[0], direction[1], direction[2]).normalize();
      this.casingRight.crossVectors(this.casingDirection, WORLD_UP).normalize();
      this.casingOrigin
        .set(origin[0], origin[1], origin[2])
        .addScaledVector(this.casingDirection, 0.55)
        .addScaledVector(this.casingRight, 0.17);
      this.casingOrigin.y -= 0.07;
      this.impacts?.spawnCasing(this.casingOrigin, this.casingRight, this.casingDirection);
      this.spawnShotEffects(direction, weaponId);
    });
    this.events.on('combat:world-hit', ({ point }) => {
      this.impacts?.spawn(point[0], point[1], point[2], 0);
      this.lastHitPoint.set(point[0], point[1], point[2]);
      this.hitPointValid = true;
    });
    this.events.on('player:died', ({ cause }) => this.handlePlayerDeath(cause));

    // --- survivor + title showcase ----------------------------------------
    this.studio = createStudioLights();
    this.studio.focusOn(0, 0, 0);
    if (this.scene) this.scene.add(this.studio.group);

    this.menus.setLoading(0.95, 'Loading survivor…');
    await this.loadCharacter(values.characterId);
    this.warmShaderCache();
    this.player.setViewMode(values.viewMode);
    this.menus.paintCharacterSelection(this.characterId, this.characterPending);

    window.addEventListener('resize', this.onResize);
    window.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('visibilitychange', this.onVisibilityChange);

    this.loop = new GameLoop({
      update: (delta) => this.update(delta),
      render: (frameDelta) => this.render(frameDelta),
    });

    this.applyQualitySettings(quality);
    this.hud.setFlashEffects(values.flashEffects);
    this.hud.setDebugVisible(values.debugOverlay);
    this.debugVisible = values.debugOverlay;

    if (this.loadFailures.length > 0) {
      this.menus.setTitleNote(`Some assets failed to load: ${this.loadFailures.join('; ')}`);
    }

    this.assets.onProgress = null;
    this.menus.setLoading(1, 'Ready');
    this.state.set('title');
    this.menus.showScreen('title');
    this.loop.start();
  }

  private failBeforeUi(reason: string): void {
    const screen = document.getElementById('screen-loading');
    const status = document.getElementById('loading-status');
    const error = document.getElementById('loading-error');
    if (status) status.textContent = 'Cannot start';
    if (error) {
      error.textContent = reason;
      error.classList.remove('hidden');
    }
    screen?.classList.remove('hidden');
    console.error('[game]', reason);
  }

  private async loadViewModels(): Promise<Map<WeaponId, Object3D>> {
    const models = new Map<WeaponId, Object3D>();
    for (const id of Object.keys(WEAPONS) as WeaponId[]) {
      const config = WEAPONS[id];
      try {
        const loaded = await this.assets.loadModel(config.modelPath);
        const object = this.normalizeViewModel(loaded.scene);
        models.set(id, object);
      } catch (error) {
        console.warn(`[weapons] view model for ${id} unavailable, continuing without it`, error);
        this.loadFailures.push(`weapon model for ${id}`);
      }
    }
    return models;
  }

  /**
   * Scales a weapon mesh to a consistent on-screen length and makes it readable.
   *
   * The dusk lighting leaves a small dark-plastic weapon nearly silhouetted
   * against the street, so its materials get a small emissive lift. This is
   * deliberately done on the view model's own materials (they come from their own
   * FBX files and are shared with nothing else) rather than by adding a light,
   * which would also brighten the level.
   */
  private normalizeViewModel(model: Group): Object3D {
    const box = new Box3();
    const size = new Vector3();
    box.setFromObject(model);
    box.getSize(size);
    const longest = Math.max(size.x, size.y, size.z, 1e-4);
    const scale = VIEW_MODEL_LENGTH / longest;
    model.scale.multiplyScalar(scale);
    const emissiveLift = new Color(0x2a2a30);
    model.traverse((child) => {
      child.castShadow = false;
      child.receiveShadow = false;
      const mesh = child as Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        const standard = material as MeshStandardMaterial & { emissive?: Color };
        if (standard.emissive) {
          standard.emissive.copy(emissiveLift);
          standard.emissiveIntensity = 1;
        }
      }
    });
    return model;
  }

  // -------------------------------------------------------------------------
  // Phases
  // -------------------------------------------------------------------------

  private startRun(): void {
    if (!this.player || !this.health || !this.weapons || !this.waves || !this.director) return;
    this.kills = 0;
    this.hitsLanded = 0;
    this.headshots = 0;
    this.waveReached = 1;
    this.runSeconds = 0;
    this.impacts?.clear();
    this.muzzleFlash?.clear();
    this.tracers?.clear();
    this.player.reset();
    this.health.reset();
    this.weapons.reset();
    this.director.clear();
    this.pickups?.clear();
    this.waves.reset();
    this.waves.start();
    this.endShowcase();
    this.state.set('playing');
    this.audio?.resume();
    this.audio?.play('ui-click');
    this.pointerLock?.request();
    this.events.emit('game:started', {});
  }

  private resume(): void {
    if (this.state.phase !== 'paused') return;
    this.state.set('playing');
    this.audio?.resumeFromSuspend();
    this.pointerLock?.request();
    this.events.emit('game:resumed', {});
  }

  private restartRun(): void {
    if (this.director) this.director.clear();
    this.pickups?.clear();
    this.player?.reset();
    this.health?.reset();
    this.weapons?.reset();
    this.kills = 0;
    this.hitsLanded = 0;
    this.headshots = 0;
    this.waveReached = 1;
    this.runSeconds = 0;
    this.impacts?.clear();
    this.muzzleFlash?.clear();
    this.tracers?.clear();
    this.waves?.reset();
    this.waves?.start();
    this.endShowcase();
    this.state.set('playing');
    this.audio?.resume();
    this.pointerLock?.request();
    this.events.emit('game:restarted', {});
  }

  private exitToTitle(): void {
    this.pointerLock?.exit();
    this.director?.clear();
    this.pickups?.clear();
    this.waves?.reset();
    // Back to the survivor showcase. The orbit resumes from where it stopped so the
    // character does not snap to a new angle the moment the menu reappears.
    this.showcaseTime = 0;
    this.state.set('title');
    this.menus?.showScreen('title');
  }

  /**
   * Muzzle flash, smoke and tracer for one shot, all in world space.
   *
   * Third person fires from the weapon in the character's hands and first person from
   * the view model; they are different objects, and drawing the flash in the wrong one
   * puts it either behind the character or floating in front of the camera.
   */
  private spawnShotEffects(direction: readonly [number, number, number], weaponId: WeaponId): void {
    const config = WEAPONS[weaponId as WeaponId] ?? WEAPONS[STARTING_WEAPON];
    this.aimScratch.set(direction[0], direction[1], direction[2]).normalize();
    const muzzle = this.resolveMuzzle(this.muzzleScratch);
    this.muzzleFlash?.spawn(muzzle, this.aimScratch, WEAPON_FEEL.flashIntensity, config.muzzleFlashSeconds);

    this.shotsFired += 1;
    if (this.shotsFired % Math.max(1, config.tracerEvery) !== 0) return;
    const end = this.hitPointValid
      ? this.tracerEnd.copy(this.lastHitPoint)
      : this.tracerEnd.copy(muzzle).addScaledVector(this.aimScratch, Math.min(config.range, 80));
    this.tracers?.spawn(muzzle, end, WEAPON_FEEL.tracerWidth, WEAPON_FEEL.tracerSeconds);
    this.hitPointValid = false;
  }

  /** Where the current shot leaves the weapon: the character's barrel or the view model. */
  private resolveMuzzle(out: Vector3): Vector3 {
    if (this.player?.mode === 'third' && this.avatar?.heldWeaponMuzzle(out)) return out;
    return out.copy(this.weapons?.muzzleWorldPosition ?? out);
  }

  private handlePlayerDeath(cause: string): void {
    if (this.state.phase === 'gameOver') return;
    this.state.set('gameOver');
    this.pointerLock?.exit();
    this.menus?.showGameOver({
      cause,
      kills: this.kills,
      wave: this.waveReached,
      survivedSeconds: this.runSeconds,
    });
  }

  private onPhaseChange(phase: GamePhase): void {
    const playing = phase === 'playing';
    this.input?.setEnabled(playing);
    this.player?.setEnabled(playing);
    if (phase === 'paused') this.events.emit('game:paused', {});
    if (phase === 'playing') this.hud?.show();
    else this.hud?.hide();

    if (playing) this.menus?.showScreen('none');
    else if (phase === 'paused') this.menus?.showScreen('pause');
    else if (phase === 'title') this.menus?.showScreen('title');
    // gameOver screen is shown by handlePlayerDeath with its summary.
  }

  private onPointerLockChange(status: 'unlocked' | 'locked' | 'denied' | 'unsupported'): void {
    if (status === 'denied' && this.state.phase === 'playing') {
      this.events.emit('toast', {
        text: this.pointerLock?.errorReason ?? 'Pointer lock was refused by the browser.',
        tone: 'warn',
      });
      return;
    }
    // Esc releases the pointer, which is the pause gesture players expect.
    if (status === 'unlocked' && this.state.phase === 'playing') {
      this.state.set('paused');
    }
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------


  // -------------------------------------------------------------------------
  // Survivor
  // -------------------------------------------------------------------------

  /**
   * Compiles the scene's materials for both menu and gameplay lighting.
   *
   * three.js keys a compiled program on the number of lights, so switching the
   * studio rig off at the start of a run would otherwise rebuild every material at
   * the exact moment the player presses Start, which reads as a stall. Both
   * variants are compiled while the loading screen is still up instead.
   */
  private warmShaderCache(): void {
    const renderer = this.renderer;
    if (!renderer || !this.scene || !this.camera || !this.studio) return;
    try {
      this.studio.setEnabled(true);
      renderer.compile(this.scene, this.camera);
      this.studio.setEnabled(false);
      renderer.compile(this.scene, this.camera);
    } catch (error) {
      console.warn('[renderer] shader pre-warm skipped', error);
    } finally {
      this.studio.setEnabled(this.state.phase === 'title');
    }
  }

  /** Renderer anisotropy limit, so character textures are as sharp as the GPU allows. */
  private get maxAnisotropy(): number {
    try {
      return this.renderer?.capabilities.getMaxAnisotropy() ?? 1;
    } catch {
      return 1;
    }
  }

  /**
   * Loads a survivor and swaps it in.
   *
   * Called on boot and whenever the player picks a different card. The previous
   * avatar is disposed first so a swap cannot leak a mixer, skeleton or materials,
   * and a failed load leaves the previous character in place with the reason on
   * screen rather than an empty scene.
   */
  private async loadCharacter(id: CharacterId): Promise<boolean> {
    if (!this.scene) return false;
    const spec = findCharacter(id);
    if (this.avatar && this.characterSpec?.id === spec.id) {
      this.applyCharacterStats(spec);
      return true;
    }

    this.characterPending = spec.id;
    this.menus?.paintCharacterSelection(this.characterId, this.characterPending);
    this.menus?.setCharacterStatus(`Loading ${spec.name}…`);

    let model;
    try {
      model = await this.assets.loadModel(`${SURVIVOR_ASSET_ROOT}${spec.file}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.characterPending = null;
      this.menus?.paintCharacterSelection(this.characterId, null);
      this.menus?.setCharacterStatus(`${spec.name} could not be loaded: ${message}`, 'error');
      this.loadFailures.push(`survivor ${spec.file}: ${message}`);
      return false;
    }

    this.avatar?.dispose();
    this.characterClips = model.animations;
    this.avatar = new PlayerAvatar({ model: { scene: model.scene, animations: model.animations }, spec, anisotropy: this.maxAnisotropy });
    this.scene.add(this.avatar.root);
    this.characterSpec = spec;
    this.characterId = spec.id;
    this.characterPending = null;
    this.applyCharacterStats(spec);
    this.settings.update({ characterId: spec.id });
    this.menus?.paintCharacterSelection(this.characterId, null);
    const clips = this.avatar.clipReport;
    console.info(`[survivor] ${spec.name} clips:`, JSON.stringify(clips));
    const missing = (['idle', 'walk', 'run'] as const).filter((state) => clips[state] === null);
    this.menus?.setCharacterStatus(
      missing.length === 0
        ? `${spec.name} siap — ${spec.stats.maxHealth} HP, lari ${spec.stats.sprintSpeed} m/s`
        : `${spec.name} loaded, but no clip for: ${missing.join(', ')}`,
      missing.length === 0 ? 'muted' : 'error',
    );
    if (this.state.phase !== 'playing') this.showcaseCamera(0);
    return true;
  }

  /** Applies a survivor's stats to movement, health and weapons. */
  private applyCharacterStats(spec: CharacterSpec): void {
    this.player?.setSpeeds(spec.stats.walkSpeed, spec.stats.sprintSpeed);
    this.health?.setMaxHealth(spec.stats.maxHealth);
    this.weapons?.setCharacterModifiers(spec.stats.reloadMultiplier, spec.stats.damageMultiplier);
  }

  /** Menu callback: player picked a different survivor. */
  private selectCharacter(id: CharacterId): void {
    if (this.characterPending) return;
    void this.loadCharacter(id);
  }

  /**
   * Poses the character and the camera for the title screen.
   *
   * The character stands a few metres down the street with its own three-point rig
   * and a slow orbit, because the night level is far too dark to judge a model by
   * and a static shot hides whether it is actually lit.
   */
  private showcaseCamera(delta: number): void {
    const avatar = this.avatar;
    const camera = this.camera;
    const player = this.player;
    if (!avatar || !camera || !player) return;

    this.showcaseTime += delta;
    // The first-person weapon is parented to this very camera, so on the menu it
    // floats half a metre in front of the lens and lands on top of the showcased
    // character, reading as a giant gun or a distorted limb.
    this.weapons?.setViewModelVisible(false);
    // Pickups are gameplay items that otherwise hover in the middle of the shot.
    this.pickups?.setVisible(false);
    const base = player.position;
    const forwardX = -Math.sin(player.yaw);
    const forwardZ = -Math.cos(player.yaw);
    const standX = base.x + forwardX * SHOWCASE.standAhead;
    const standZ = base.z + forwardZ * SHOWCASE.standAhead;

    // Face back towards the menu camera's starting side so the face is visible.
    const orbit = Math.sin(this.showcaseTime * SHOWCASE.orbitSpeed) * SHOWCASE.orbitArc;
    const facing = player.yaw + Math.PI + orbit * 0.35;
    avatar.setVisible(true);
    avatar.place({ x: standX, z: standZ }, facing);
    avatar.update(0, { x: standX, z: standZ }, facing, 0);

    const cameraAngle = player.yaw + Math.PI + orbit;
    const distance = SHOWCASE.distance;
    const camX = standX + Math.sin(cameraAngle) * distance;
    const camZ = standZ + Math.cos(cameraAngle) * distance;
    const targetY = avatar.height * SHOWCASE.aimHeight;
    const camY = avatar.height * 0.58 + SHOWCASE.heightOffset;

    camera.rotation.set(0, 0, 0);
    camera.rotation.order = 'YXZ';
    camera.position.set(camX, camY, camZ);

    // Aim at the subject, then rotate the camera off that axis by exactly the angle
    // that lands the subject at the configured fraction of the frame width.
    const dirX = standX - camX;
    const dirY = targetY - camY;
    const dirZ = standZ - camZ;
    const length = Math.max(Math.hypot(dirX, dirY, dirZ), 1e-4);
    const aspect = Math.max(0.1, (this.canvas.clientWidth || 1) / (this.canvas.clientHeight || 1));
    camera.rotation.y = Math.atan2(-(dirX / length), -(dirZ / length))
      + showcaseLookYawOffset(SHOWCASE.frameFraction, camera.fov, aspect);
    camera.rotation.x = Math.asin(Math.max(-1, Math.min(1, dirY / length)));
    camera.updateMatrixWorld();

    this.studio?.focusOn(standX, 0, standZ);
    this.studio?.setEnabled(true);
  }

  /** Leaves the showcase behind and hands the camera back to the player. */
  private endShowcase(): void {
    this.studio?.setEnabled(false);
    this.pickups?.setVisible(true);
    this.applyViewModeVisibility();
  }

  /**
   * Decides what the camera should see in the current view mode.
   *
   * Third person renders the character itself, weapon in hand, so the separate view
   * model stands down. First person hides the body and shows the view model: putting
   * the camera inside the head and culling front faces was tried and reverted — the
   * character's third-person gun pose keeps its arms below the frame, so first person
   * came out with no visible weapon at all. Hands for first person need a dedicated
   * arms model, not a camera trick.
   */
  private applyViewModeVisibility(): void {
    const third = this.player?.mode === 'third';
    this.avatar?.setVisible(third);
    this.weapons?.setViewModelVisible(!third);
  }

  private update(delta: number): void {
    if (!this.player || !this.health || !this.weapons || !this.director || !this.waves || !this.pickups) return;

    const playing = this.state.isSimulationActive;
    const input = playing ? this.input?.consume() ?? null : null;

    if (!playing) {
      // Settle camera/recoil but never advance gameplay.
      this.player.update(delta, null);
      this.weapons.update(0, null, false);
      // The title screen shows the chosen survivor instead of a frozen viewpoint.
      if (this.state.phase === 'title') this.showcaseCamera(delta);
      return;
    }

    this.runSeconds += delta;
    this.player.update(delta, input);
    // The character follows the controller; its cycle rate comes from ground speed,
    // so the feet keep up with however fast the player is actually moving.
    // `facingAngle`, not `yaw`: the pack's models face +Z, which is the convention
    // the zombies already use (atan2 of the movement direction). Feeding the camera
    // yaw here rotated the character 180 degrees, so it moonwalked.
    this.avatar?.update(delta, this.player.position, this.player.facingAngle, this.player.speed);
    this.weapons.update(delta, input, true);
    this.health.update(delta);

    const directorResult = this.director.update(delta, this.player.position, this.health.isAlive);
    if (directorResult.damageToPlayer > 0) {
      this.applyPlayerDamage(directorResult.damageToPlayer);
    }

    // No navigation grid means no map to place zombies on; the wave director needs the
    // grid itself now that spawning checks connectivity, so it simply does not run.
    if (!this.navigation) return;
    this.waves.update(delta, {
      playerX: this.player.position.x,
      playerZ: this.player.position.z,
      playerYaw: this.player.facingAngle,
      surface: this.navigation,
    });

    const pickupResult = this.pickups.update(delta, {
      playerX: this.player.position.x,
      playerZ: this.player.position.z,
      playerHealthFraction: this.health.fraction,
      ownedWeapons: this.weapons.ownedWeapons,
    });
    if (pickupResult.healed > 0) {
      const healed = this.health.heal(pickupResult.healed);
      if (healed > 0) {
        this.events.emit('player:healed', { amount: healed, health: this.health.current });
      }
    }
    for (const entry of pickupResult.ammo) this.weapons.addReserve(entry.weaponId, entry.amount);
    if (pickupResult.weapon) {
      this.weapons.unlock(pickupResult.weapon);
      this.weapons.addReserve(pickupResult.weapon, WEAPONS[pickupResult.weapon].startingReserve);
    }

    this.impacts?.update(delta, this.player.eyePosition);
    this.muzzleFlash?.update(delta);
    this.tracers?.update(delta);
    this.updateHud(delta);
  }

  private applyPlayerDamage(amount: number): void {
    if (!this.health) return;
    const applied = this.health.applyDamage(amount);
    if (applied <= 0) return;
    this.events.emit('player:damaged', {
      amount: applied,
      health: this.health.current,
      maxHealth: this.health.max,
    });
    if (!this.health.isAlive) {
      this.events.emit('player:died', {
        cause: 'Overrun by the horde.',
        kills: this.kills,
        wave: this.waveReached,
        survivedSeconds: this.runSeconds,
      });
    }
  }

  private rollDrop(x: number, z: number): void {
    if (!this.pickups || !this.health || !this.weapons) return;
    this.pickups.rollDrop(x, z, this.health.fraction, this.weapons.ownedWeapons, this.waves?.currentWave ?? 1);
  }

  private updateHud(delta: number): void {
    if (!this.hud || !this.health || !this.weapons || !this.waves) return;
    const snapshot = this.weapons.snapshot;
    this.hud.update(delta, {
      health: this.health.current,
      ammo: snapshot.magazine,
      reserve: snapshot.reserve,
      weaponName: snapshot.name,
      kills: this.kills,
      wave: this.waves.currentWave,
      remaining: this.waves.remainingInWave,
      reloading: snapshot.reloading,
      spread: snapshot.spread,
    });
  }

  private render(frameDeltaSeconds = 1 / 60): void {
    if (!this.renderer || !this.scene || !this.camera) return;
    this.renderer.render(this.scene, this.camera);

    // Frame timing for the debug overlay and the FPS readout. The window is time
    // based, not frame based: dividing frames by a counter that is incremented
    // once per frame reported a constant, meaningless number.
    this.frameCount += 1;
    this.frameAccumulator += Math.min(Math.max(frameDeltaSeconds, 1e-5), 1);
    if (this.frameAccumulator >= 0.5) {
      this.fps = Math.round(this.frameCount / this.frameAccumulator);
      this.frameCount = 0;
      this.frameAccumulator = 0;
    }
    if (this.debugVisible) this.updateDebugOverlay();
  }

  private updateDebugOverlay(): void {
    if (!this.hud || !this.director || !this.level) return;
    const info = this.renderer?.info;
    const snapshot: DebugSnapshot = {
      fps: this.fps,
      activeZombies: this.director.count,
      engagedZombies: this.director.engagedCount,
      pooledZombies: this.director.pooledCount,
      wave: this.waves?.currentWave ?? 0,
      phase: this.state.phase,
      collisionBoxes: this.level.collision.count,
      walkableRatio: this.navigation?.walkableRatio ?? 0,
      drawCalls: info?.render.calls ?? 0,
      triangles: info?.render.triangles ?? 0,
    };
    this.hud.setDebugText([
      `fps ${snapshot.fps}`,
      `phase ${snapshot.phase}`,
      `wave ${snapshot.wave}`,
      `zombies ${snapshot.activeZombies} (engaged ${snapshot.engagedZombies}, pooled ${snapshot.pooledZombies})`,
      `collision boxes ${snapshot.collisionBoxes}`,
      `nav walkable ${(snapshot.walkableRatio * 100).toFixed(1)}%`,
      `draw calls ${snapshot.drawCalls}  tris ${snapshot.triangles}`,
      'F3 toggles this overlay · H toggles hitboxes',
    ].join('\n'));
  }

  // -------------------------------------------------------------------------
  // Input / settings plumbing
  // -------------------------------------------------------------------------

  private readonly onResize = (): void => {
    if (!this.renderer || !this.camera) return;
    this.resize();
    this.renderer.setSize(this.canvas.clientWidth || window.innerWidth, this.canvas.clientHeight || window.innerHeight, false);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === 'F3') {
      event.preventDefault();
      this.setDebugVisible(!this.debugVisible);
      this.settings.update({ debugOverlay: this.debugVisible });
      this.menus?.paintSettings(this.settings.current);
      return;
    }
    if (event.code === 'KeyH' && this.debugVisible) {
      this.toggleHitboxes();
    }
    if (event.code === 'KeyV') {
      event.preventDefault();
      const mode = this.player?.toggleViewMode();
      if (mode) {
        this.applyViewModeVisibility();
        this.settings.update({ viewMode: mode });
        this.events.emit('toast', {
          text: mode === 'third' ? 'Third person (V to switch)' : 'First person (V to switch)',
          tone: 'info',
        });
      }
    }
  };

  private readonly onVisibilityChange = (): void => {
    if (document.hidden && this.state.phase === 'playing') this.state.set('paused');
  };

  private setDebugVisible(visible: boolean): void {
    this.debugVisible = visible;
    this.hud?.setDebugVisible(visible);
  }

  private toggleHitboxes(): void {
    const director = this.director;
    if (!director) return;
    // Debug affordance from the brief: hitboxes can be shown for tuning.
    const next = !(director.list[0]?.hitboxes[0]?.visible ?? false);
    for (const zombie of director.list) {
      for (const hitbox of zombie.hitboxes) hitbox.visible = next;
    }
  }

  private resize(): void {
    if (!this.camera || !this.renderer) return;
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  private applySettingChange(change: Partial<SettingsValues> & { quality?: QualityTier }): void {
    const values = this.settings.update(change);
    if (change.volume !== undefined) this.audio?.setVolume(change.volume);
    if (change.sensitivity !== undefined && this.player) this.player.sensitivity = change.sensitivity;
    if (change.flashEffects !== undefined) this.hud?.setFlashEffects(change.flashEffects);
    if (change.debugOverlay !== undefined) this.setDebugVisible(change.debugOverlay);
    if (change.shadows !== undefined && this.renderer && this.lighting) {
      const tier = values.quality;
      const preset = { ...QUALITY_PRESETS[tier], shadows: change.shadows };
      this.renderer.shadowMap.enabled = change.shadows;
      this.lighting.applyQuality(preset);
    }
  }

  private changeQuality(tier: QualityTier): void {
    const preset = QUALITY_PRESETS[tier];
    this.settings.update({ quality: tier, shadows: preset.shadows });
    if (this.renderer) applyQuality(this.renderer, preset);
    this.lighting?.applyQuality(preset);
    this.waves?.setActiveCap(preset.zombieCap);
    this.menus?.paintSettings(this.settings.current);
    this.events.emit('toast', {
      text: 'Quality updated. Reload the page to change antialiasing.',
      tone: 'info',
    });
  }

  private applyQualitySettings(preset: typeof QUALITY_PRESETS[QualityTier]): void {
    if (this.renderer) applyQuality(this.renderer, preset);
    this.lighting?.applyQuality(preset);
    this.waves?.setActiveCap(preset.zombieCap);
  }

  private buildCreditsHtml(): string {
    return [
      '<h3>Dead District — Horde Survival</h3>',
      '<p>An original browser horde-survival FPS built with Three.js, Vite and TypeScript.</p>',
      '<h4>Third-party assets</h4>',
      '<ul>',
      '<li><strong>Zombie Apocalypse Kit</strong> by Quaternius — CC0 1.0 (characters, props, vehicles, weapons). ',
      'Source: <code>quaternius.com/packs/zombieapocalypsekit.html</code></li>',
      '</ul>',
      '<h4>Generated in code</h4>',
      '<p>City layout, building facades, road and dirt textures, pickups, muzzle flash and all sound effects are generated ',
      'procedurally by the game itself.</p>',
      '<p>Inspiration for the genre only; no assets, code, levels or names from any commercial game are used.</p>',
    ].join('');
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loop?.stop();
    this.loop = null;

    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKeyDown);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);

    this.unbindAudio?.();
    this.unbindAudio = null;
    this.audio?.dispose();
    this.pointerLock?.dispose();
    this.input?.dispose();
    this.hud?.dispose();
    this.events.clear();

    this.impacts?.dispose();
    this.muzzleFlash?.dispose();
    this.tracers?.dispose();
    this.pickups?.dispose();
    this.director?.dispose();
    this.weapons?.dispose();
    this.factory?.dispose();
    this.level?.dispose();
    this.lighting?.dispose();
    this.assets.clear();
    this.state.dispose();

    if (this.scene && this.camera) this.scene.remove(this.camera);
    if (this.scene) disposeObject3D(this.scene);
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
    this.renderer = null;
    this.scene = null;
  }

  /**
   * Automation hooks for `tools/smoke.mjs`.
   *
   * The headless browser used for verification does not always fire
   * requestAnimationFrame, so the harness advances the simulation by hand and
   * needs to read real internal state instead of inferring it from the DOM.
   */
  debugInfo(): DebugInfo {
    const factory = this.factory;
    return {
      phase: this.state.phase,
      loadingFailures: [...this.loadFailures],
      zombieKinds: this.availableKinds,
      clipInventory: factory ? factory.clipInventory : [],
      activeZombies: this.director?.count ?? 0,
      pooledZombies: this.director?.pooledCount ?? 0,
      engagedZombies: this.director?.engagedCount ?? 0,
      zombieStates: (this.director?.list ?? []).map((zombie) => `${zombie.kind}:${zombie.state}:${zombie.health.toFixed(0)}`),
      zombiePositions: (this.director?.list ?? []).map((zombie) => [
        Number(zombie.position.x.toFixed(2)),
        Number(zombie.position.z.toFixed(2)),
        Number(zombie.yaw.toFixed(2)),
      ]),
      wave: this.waves?.currentWave ?? 0,
      wavePhase: this.waves?.currentPhase ?? 'idle',
      remainingInWave: this.waves?.remainingInWave ?? 0,
      stragglersRecalled: this.waves?.stragglerRecalls ?? 0,
      kills: this.kills,
      hitsLanded: this.hitsLanded,
      headshots: this.headshots,
      playerHealth: this.health?.current ?? 0,
      playerAlive: this.health?.isAlive ?? false,
      playerPosition: [Number((this.player?.position.x ?? 0).toFixed(2)), Number((this.player?.position.z ?? 0).toFixed(2))],
      playerYaw: Number((this.player?.yaw ?? 0).toFixed(3)),
      playerPitch: Number((this.player?.pitch ?? 0).toFixed(3)),
      hitboxReport: (this.director?.list ?? []).map((zombie) => {
        const head = zombie.hitboxes.find((box) => box.userData.hitZone === 'head') ?? null;
        const headPosition = new Vector3();
        head?.getWorldPosition(headPosition);
        return {
          kind: zombie.kind,
          alive: zombie.isAlive,
          hitboxes: zombie.hitboxes.length,
          headY: head ? Number(headPosition.y.toFixed(2)) : null,
          rootY: Number(zombie.root.position.y.toFixed(2)),
        };
      }),
      weapon: this.weapons?.snapshot.weaponId ?? 'none',
      magazine: this.weapons?.snapshot.magazine ?? 0,
      reserve: this.weapons?.snapshot.reserve ?? 0,
      reloading: this.weapons?.snapshot.reloading ?? false,
      ownedWeapons: this.weapons?.ownedWeapons ?? [],
      characterId: this.characterId,
      avatarFacing: this.avatar ? Number(this.avatar.facingReport.facing.toFixed(4)) : null,
      playerFacing: Number((this.player?.facingAngle ?? 0).toFixed(4)),
      avatarFacingSource: this.avatar?.facingReport.source ?? 'none',
      gearAttached: this.avatar?.gearReport.attached ?? [],
      gearSkipped: this.avatar?.gearReport.skipped ?? [],
      characterName: this.characterSpec?.name ?? 'none',
      characterFile: this.characterSpec?.file ?? 'none',
      characterPending: this.characterPending,
      characterMaxHealth: this.health?.max ?? 0,
      playerWalkSpeed: Number((this.player?.walkSpeedValue ?? 0).toFixed(2)),
      playerSprintSpeed: Number((this.player?.sprintSpeedValue ?? 0).toFixed(2)),
      cameraPosition: this.camera
        ? [
          Number(this.camera.position.x.toFixed(2)),
          Number(this.camera.position.y.toFixed(2)),
          Number(this.camera.position.z.toFixed(2)),
        ]
        : null,
      avatarVisible: this.avatar?.visible ?? false,
      avatarState: this.avatar?.state ?? 'none',
      avatarClips: this.avatar?.clipReport ?? { idle: null, walk: null, run: null },
      avatarPosition: this.avatar?.root.visible
        ? [
          Number(this.avatar.root.position.x.toFixed(2)),
          Number(this.avatar.root.position.y.toFixed(2)),
          Number(this.avatar.root.position.z.toFixed(2)),
        ]
        : null,
      viewMode: this.player?.mode ?? 'none',
      weaponViewModelVisible: this.weapons?.viewModelVisible ?? false,
      showcaseActive: this.studio?.group.visible ?? false,
      sensitivity: Number((this.player?.sensitivity ?? 0).toFixed(3)),
      masterVolume: Number((this.audio?.currentVolume ?? 0).toFixed(3)),
      shadowMapEnabled: this.renderer?.shadowMap.enabled ?? false,
      activeZombieCap: this.waves ? this.director?.maxActive ?? 0 : 0,
      debugOverlayVisible: this.hud?.debugVisibleState ?? false,
      pickups: this.pickups?.count ?? 0,
      activeImpacts: this.impacts?.activeCount ?? 0,
      activeCasings: this.impacts?.activeCasingCount ?? 0,
      muzzleFlashActive: this.muzzleFlash?.activeCount ?? 0,
      muzzleSmokeActive: this.muzzleFlash?.activeSmokeCount ?? 0,
      muzzleFlashSpawned: this.muzzleFlash?.spawnCount ?? 0,
      tracersActive: this.tracers?.activeCount ?? 0,
      tracersSpawned: this.tracers?.spawnCount ?? 0,
      collisionBoxes: this.level?.collision.count ?? 0,
      walkableRatio: Number((this.navigation?.walkableRatio ?? 0).toFixed(3)),
      fps: this.fps,
      drawCalls: this.renderer?.info.render.calls ?? 0,
      triangles: this.renderer?.info.render.triangles ?? 0,
      geometries: this.renderer?.info.memory.geometries ?? 0,
      textures: this.renderer?.info.memory.textures ?? 0,
    };
  }

  /** Advances one frame without a browser animation loop (headless harness). */
  debugTick(deltaSeconds: number, options: { render?: boolean } = {}): void {
    this.update(deltaSeconds);
    if (options.render !== false) this.render();
  }

  /**
   * Renders and returns the frame as a PNG data URL.
   *
   * The read happens in the same task as the render, which is the only reliable
   * way to get pixels from a non-preserving WebGL context on a display-less
   * machine. The returned image contains the 3D scene only; HUD values are DOM
   * and are asserted separately from the DOM itself.
   */
  debugCaptureDataUrl(): string {
    this.render();
    return this.canvas.toDataURL('image/png');
  }

  /**
   * Renders one frame and reads it back from the GPU in the same task,
   * reporting coarse image statistics. A flat frame (low contrast) means the
   * camera is inside geometry or facing a single surface, which a plain
   * data-URL capture cannot tell you.
   */
  debugFrameStats(): { mean: number; contrast: number; max: number; brightFraction: number } {
    this.render();
    const renderer = this.renderer;
    if (!renderer) return { mean: 0, contrast: 0, max: 0, brightFraction: 0 };
    const gl = renderer.getContext();
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let sum = 0;
    let sumSquares = 0;
    let max = 0;
    let bright = 0;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 16) {
      const luminance = pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114;
      sum += luminance;
      sumSquares += luminance * luminance;
      if (luminance > max) max = luminance;
      if (luminance > 90) bright += 1;
      count += 1;
    }
    const mean = sum / count;
    const variance = Math.max(0, sumSquares / count - mean * mean);
    return {
      mean: Number(mean.toFixed(2)),
      contrast: Number(Math.sqrt(variance).toFixed(2)),
      max: Number(max.toFixed(0)),
      brightFraction: Number((bright / count).toFixed(3)),
    };
  }

  /** Camera position and facing, for the visual harness. */
  debugCameraState(): {
    position: [number, number];
    yaw: number;
    pitch: number;
    phase: string;
    aspect: number;
    fov: number;
    near: number;
    far: number;
    canvasCss: [number, number];
    drawingBuffer: [number, number];
    rendererSize: [number, number];
    pixelRatio: number;
    cameraRotation: [number, number, number];
    cameraRotationOrder: string;
    worldDirection: [number, number, number];
    recoilPitch: number;
  } {
    const camera = this.camera;
    const renderer = this.renderer;
    const size = renderer?.getSize(new Vector3() as never) ?? null;
    return {
      position: [
        Number((this.player?.position.x ?? 0).toFixed(2)),
        Number((this.player?.position.z ?? 0).toFixed(2)),
      ],
      yaw: Number((this.player?.yaw ?? 0).toFixed(3)),
      pitch: Number((this.player?.pitch ?? 0).toFixed(3)),
      phase: this.state.phase,
      aspect: Number((camera?.aspect ?? 0).toFixed(4)),
      fov: camera?.fov ?? 0,
      near: camera?.near ?? 0,
      far: camera?.far ?? 0,
      canvasCss: [this.canvas.clientWidth, this.canvas.clientHeight],
      drawingBuffer: [
        renderer?.getContext().drawingBufferWidth ?? 0,
        renderer?.getContext().drawingBufferHeight ?? 0,
      ],
      rendererSize: size ? [Math.round(size.x), Math.round(size.y)] : [0, 0],
      pixelRatio: renderer?.getPixelRatio() ?? 0,
      cameraRotation: camera
        ? [
          Number(camera.rotation.x.toFixed(3)),
          Number(camera.rotation.y.toFixed(3)),
          Number(camera.rotation.z.toFixed(3)),
        ]
        : [0, 0, 0],
      cameraRotationOrder: camera?.rotation.order ?? 'XYZ',
      worldDirection: camera
        ? (() => {
          const direction = camera.getWorldDirection(new Vector3());
          return [
            Number(direction.x.toFixed(3)),
            Number(direction.y.toFixed(3)),
            Number(direction.z.toFixed(3)),
          ] as [number, number, number];
        })()
        : [0, 0, 0],
      recoilPitch: Number((this.player?.currentRecoilPitch ?? 0).toFixed(4)),
    };
  }

  /** Objects the last render actually drew, and whether the camera sees anything. */
  debugRenderAudit(): {
    inFrustum: number;
    total: number;
    cameraWorld: [number, number, number];
    largest: Array<{ name: string; radius: number; y: number }>;
  } {
    if (!this.scene || !this.camera) {
      return { inFrustum: 0, total: 0, cameraWorld: [0, 0, 0], largest: [] };
    }
    this.camera.updateMatrixWorld(true);
    const frustum = new Frustum().setFromProjectionMatrix(
      new Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse),
    );
    let inFrustum = 0;
    let total = 0;
    const position = new Vector3();
    this.scene.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh) return;
      total += 1;
      mesh.getWorldPosition(position);
      if (frustum.containsPoint(position)) inFrustum += 1;
    });
    // Largest meshes in world space: an oversized prop would swallow the level
    // and leave the camera inside a single surface.
    const largest: Array<{ name: string; radius: number; y: number }> = [];
    this.scene.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
      const sphere = mesh.geometry.boundingSphere;
      if (!sphere) return;
      const scale = mesh.getWorldScale(new Vector3());
      const radius = sphere.radius * Math.max(scale.x, scale.y, scale.z);
      largest.push({ name: mesh.name || object.type, radius: Number(radius.toFixed(2)), y: Number(mesh.getWorldPosition(position).y.toFixed(2)) });
    });
    largest.sort((a, b) => b.radius - a.radius);

    return {
      inFrustum,
      total,
      cameraWorld: [
        Number(this.camera.getWorldPosition(new Vector3()).x.toFixed(2)),
        Number(this.camera.getWorldPosition(new Vector3()).y.toFixed(2)),
        Number(this.camera.getWorldPosition(new Vector3()).z.toFixed(2)),
      ],
      largest: largest.slice(0, 8),
    };
  }

  /**
   * Points the camera at an explicit yaw/pitch.
   * `yaw` follows the same convention as the rest of the project:
   * forward = (-sin yaw, -cos yaw), so yaw = 0 looks towards -Z.
   */
  debugSetLook(yaw: number, pitch: number): void {
    if (!this.player) return;
    this.player.yaw = yaw;
    this.player.pitch = pitch;
    const camera = this.camera;
    if (camera) {
      camera.rotation.order = 'YXZ';
      camera.rotation.set(pitch, yaw, 0);
      camera.position.set(this.player.position.x, 1.62, this.player.position.z);
      camera.updateMatrixWorld(true);
    }
  }

  /** Renders the current frame once (headless harness helper). */
  debugRenderFrame(): void {
    this.render();
  }

  /**
   * Renders the scene into an offscreen target and reads it back.
   *
   * This is the decisive check for "is the game actually drawing the world":
   * `readRenderTargetPixels` reads a buffer three.js owns, so it cannot be
   * confused by the headless compositor reusing a stale default framebuffer.
   */
  debugOffscreenStats(): { mean: number; contrast: number; max: number; brightFraction: number } {
    const renderer = this.renderer;
    const scene = this.scene;
    const camera = this.camera;
    if (!renderer || !scene || !camera) return { mean: 0, contrast: 0, max: 0, brightFraction: 0 };

    const width = 320;
    const height = 180;
    const target = new WebGLRenderTarget(width, height);
    const previousTarget = renderer.getRenderTarget();
    const previousAspect = camera.aspect;
    try {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      const pixels = new Uint8Array(width * height * 4);
      renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);

      let sum = 0;
      let sumSquares = 0;
      let max = 0;
      let bright = 0;
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const luminance = pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114;
        sum += luminance;
        sumSquares += luminance * luminance;
        if (luminance > max) max = luminance;
        if (luminance > 90) bright += 1;
        count += 1;
      }
      const mean = sum / count;
      const variance = Math.max(0, sumSquares / count - mean * mean);
      return {
        mean: Number(mean.toFixed(2)),
        contrast: Number(Math.sqrt(variance).toFixed(2)),
        max: Number(max.toFixed(0)),
        brightFraction: Number((bright / count).toFixed(3)),
      };
    } finally {
      camera.aspect = previousAspect;
      camera.updateProjectionMatrix();
      renderer.setRenderTarget(previousTarget);
      target.dispose();
    }
  }

  /**
   * Renders with an unlit override material and no background.
   *
   * Separates "no geometry is rasterised" (uniform clear colour) from "geometry
   * rasterises but is invisible" (uniform override colour), which is the
   * difference between a camera/render problem and a lighting/material problem.
   */
  debugOverrideProbe(): { mean: number; contrast: number; max: number; brightFraction: number } {
    const scene = this.scene;
    if (!scene) return { mean: 0, contrast: 0, max: 0, brightFraction: 0 };
    const previousBackground = scene.background;
    const previousFog = scene.fog;
    const previousOverride = scene.overrideMaterial;
    const probe = new MeshBasicMaterial({ color: 0xff00ff });
    scene.background = null;
    scene.fog = null;
    scene.overrideMaterial = probe;
    try {
      return this.debugOffscreenStats();
    } finally {
      scene.overrideMaterial = previousOverride;
      scene.background = previousBackground;
      scene.fog = previousFog;
      probe.dispose();
    }
  }

  /**
   * Projects the avatar's world bounding box into canvas pixels.
   *
   * Framing is otherwise guesswork: an offset that looks right at one window size is
   * wrong at another, so the harness asserts the subject's centre and size as
   * fractions of the canvas instead of trusting a screenshot.
   */
  debugProjectAvatar(): {
    centreX: number; centreY: number; widthFraction: number; heightFraction: number;
    viewport: [number, number];
  } | null {
    const avatar = this.avatar;
    const camera = this.camera;
    if (!avatar || !camera) return null;
    const box = new Box3().setFromObject(avatar.root);
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    camera.updateMatrixWorld();
    const xs: number[] = [];
    const ys: number[] = [];
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) {
          const projected = new Vector3(x, y, z).project(camera);
          xs.push((projected.x * 0.5 + 0.5) * width);
          ys.push((1 - (projected.y * 0.5 + 0.5)) * height);
        }
      }
    }
    const left = Math.min(...xs);
    const right = Math.max(...xs);
    const top = Math.min(...ys);
    const bottom = Math.max(...ys);
    return {
      centreX: Number((((left + right) / 2) / width).toFixed(3)),
      centreY: Number((((top + bottom) / 2) / height).toFixed(3)),
      widthFraction: Number(((right - left) / width).toFixed(3)),
      heightFraction: Number(((bottom - top) / height).toFixed(3)),
      viewport: [width, height],
    };
  }

  /**
   * Mean and peak luminance of a rectangle of the current frame, in canvas pixels.
   *
   * Used to measure how well a subject is actually lit, rather than arguing about it.
   */
  debugRegionStats(x0: number, y0: number, x1: number, y1: number): { mean: number; max: number; contrast: number; pixels: number } {
    this.render();
    const renderer = this.renderer;
    if (!renderer) return { mean: 0, max: 0, contrast: 0, pixels: 0 };
    const gl = renderer.getContext();
    const bufferWidth = gl.drawingBufferWidth;
    const bufferHeight = gl.drawingBufferHeight;
    const cssWidth = this.canvas.clientWidth || bufferWidth;
    const cssHeight = this.canvas.clientHeight || bufferHeight;
    const scaleX = bufferWidth / cssWidth;
    const scaleY = bufferHeight / cssHeight;
    const left = Math.max(0, Math.floor(x0 * scaleX));
    const right = Math.min(bufferWidth, Math.ceil(x1 * scaleX));
    const top = Math.max(0, Math.floor(y0 * scaleY));
    const bottom = Math.min(bufferHeight, Math.ceil(y1 * scaleY));
    const w = Math.max(1, right - left);
    const h = Math.max(1, bottom - top);
    const pixels = new Uint8Array(w * h * 4);
    gl.readPixels(left, bufferHeight - bottom, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let sum = 0;
    let sumSquares = 0;
    let max = 0;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const luminance = pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114;
      sum += luminance;
      sumSquares += luminance * luminance;
      if (luminance > max) max = luminance;
      count += 1;
    }
    const mean = sum / count;
    return {
      mean: Number(mean.toFixed(2)),
      max: Number(max.toFixed(0)),
      contrast: Number(Math.sqrt(Math.max(0, sumSquares / count - mean * mean)).toFixed(2)),
      pixels: count,
    };
  }

  /**
   * Offscreen render summarised as a coarse luminance grid.
   *
   * A harness can diff two grids (before and after a shot) to prove that an
   * effect actually reached the framebuffer, instead of trusting a look at a
   * screenshot or the mere existence of an object in the scene graph.
   */
  debugFrameGrid(cells = 8): { grid: number[]; mean: number; max: number } {
    const renderer = this.renderer;
    const scene = this.scene;
    const camera = this.camera;
    if (!renderer || !scene || !camera) return { grid: [], mean: 0, max: 0 };

    const width = 160;
    const height = 90;
    const target = new WebGLRenderTarget(width, height);
    const previousTarget = renderer.getRenderTarget();
    const previousAspect = camera.aspect;
    try {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      const pixels = new Uint8Array(width * height * 4);
      renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);

      const grid = new Array<number>(cells * cells).fill(0);
      const counts = new Array<number>(cells * cells).fill(0);
      let max = 0;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const i = (y * width + x) * 4;
          const luminance = pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114;
          const cell = Math.min(cells - 1, Math.floor((y / height) * cells)) * cells
            + Math.min(cells - 1, Math.floor((x / width) * cells));
          grid[cell] += luminance;
          counts[cell] += 1;
          if (luminance > max) max = luminance;
        }
      }
      const normalised = grid.map((sum, index) => (counts[index] > 0 ? sum / counts[index] : 0));
      const mean = normalised.reduce((total, value) => total + value, 0) / normalised.length;
      return {
        grid: normalised.map((value) => Number(value.toFixed(2))),
        mean: Number(mean.toFixed(2)),
        max: Number(max.toFixed(0)),
      };
    } finally {
      camera.aspect = previousAspect;
      camera.updateProjectionMatrix();
      renderer.setRenderTarget(previousTarget);
      target.dispose();
    }
  }

  /** Live scene memory counters, used to detect leaks across restarts. */
  debugMemory(): { geometries: number; textures: number; programs: number; objects: number } {
    const memory = this.renderer?.info.memory;
    let objects = 0;
    this.scene?.traverse(() => { objects += 1; });
    return {
      geometries: memory?.geometries ?? 0,
      textures: memory?.textures ?? 0,
      programs: this.renderer?.info.programs?.length ?? 0,
      objects,
    };
  }

  /** Points the player at the nearest live zombie. Returns false if there is none. */
  debugAimAtNearestZombie(): boolean {
    const director = this.director;
    const player = this.player;
    const camera = this.camera;
    if (!director || !player || !camera || director.count === 0) return false;

    let nearest: { x: number; y: number; z: number; distance: number } | null = null;
    for (const zombie of director.list) {
      if (!zombie.isAlive) continue;
      const dx = zombie.position.x - player.position.x;
      const dz = zombie.position.z - player.position.z;
      const distance = Math.hypot(dx, dz);
      if (nearest && distance >= nearest.distance) continue;
      nearest = { x: zombie.position.x, y: zombie.stats.height * 0.86, z: zombie.position.z, distance };
    }
    if (!nearest) return false;

    const dx = nearest.x - player.position.x;
    const dz = nearest.z - player.position.z;
    // yaw = atan2(x, z) so that forward = (sin yaw, cos yaw); the camera's
    // rotation is that yaw (three looks down -Z, which is what yaw already means
    // for the camera in this project).
    player.yaw = Math.atan2(dx, dz) + Math.PI;
    const horizontal = Math.hypot(dx, dz);
    player.pitch = Math.atan2(nearest.y - 1.62, horizontal);
    camera.rotation.order = 'YXZ';
    camera.rotation.set(player.pitch, player.yaw, 0);
    camera.position.set(player.position.x, 1.62, player.position.z);
    camera.updateMatrixWorld(true);
    return true;
  }

  /** Fires the equipped weapon once, bypassing the input layer. */
  debugFireOnce(): boolean {
    return this.weapons?.tryFire() !== null && this.weapons !== null;
  }

  /** Fires once and reports what the ray hit (headless verification). */
  /**
   * World orientation of each attached gear weapon and of the hand holding it.
   *
   * The pack's grip transform is authored for its gun-holding clips (arms raised,
   * weapon pointing forward); Jack uses the plain cycles with the arms down, so the
   * weapons need a corrective rotation that can only be derived from the pose the rig
   * is actually in. This reports the numbers that derivation needs.
   */
  debugGearAxes(): Array<{ weapon: string; hand: string; handQuaternion: number[]; weaponQuaternion: number[] }> {
    const root = this.avatar?.root;
    if (!root) return [];
    const report: Array<{ weapon: string; hand: string; handQuaternion: number[]; weaponQuaternion: number[] }> = [];
    root.updateMatrixWorld(true);
    root.traverse((child) => {
      if (child.name !== 'GearAxe' && child.name !== 'GearBat') return;
      const hand = child.parent;
      if (!hand) return;
      report.push({
        weapon: child.name,
        hand: hand.name,
        handQuaternion: hand.getWorldQuaternion(new Quaternion()).toArray(),
        weaponQuaternion: child.getWorldQuaternion(new Quaternion()).toArray(),
      });
    });
    return report;
  }

  /**
   * Stretches the muzzle flash, smoke and tracer lifetimes by `scale`.
   *
   * For capturing frames only: this host rasterises in software, a screenshot costs a
   * frame, and a frame can be a second long, so an effect that lives 55 ms can never
   * appear in a capture at its real length. Pass 1 to restore.
   */
  debugProlongShotEffects(scale: number): number {
    this.muzzleFlash?.setLifeScale(scale);
    this.tracers?.setLifeScale(scale);
    return scale;
  }

  /**
   * Where the first-person hands ended up, for diagnosing a floating weapon.
   *
   * Answers the three questions that matter: were they built, where are they in view-model
   * space, and are they actually visible on screen.
   */
  debugHandsReport(): {
    parts: number; visible: boolean; position: [number, number, number] | null;
    screen: [number, number] | null; distance: number | null;
  } {
    return this.weapons?.handsReport
      ?? { parts: 0, visible: false, position: null, screen: null, distance: null };
  }

  /**
   * World-space bounding boxes of the avatar's gear groups.
   *
   * A tool strapped inside the backpack's own volume is built, attached and reported by
   * every other check while being invisible on screen, so the boxes are printed rather
   * than trusted.
   */
  debugGearBoxes(): Array<{ name: string; min: number[]; max: number[] }> {
    const root = this.avatar?.root;
    if (!root) return [];
    root.updateMatrixWorld(true);
    const boxes: Array<{ name: string; min: number[]; max: number[] }> = [];
    root.traverse((child) => {
      if (!child.name.startsWith('Gear')) return;
      const box = new Box3().setFromObject(child);
      boxes.push({
        name: child.name,
        min: box.min.toArray().map((value) => Number(value.toFixed(2))),
        max: box.max.toArray().map((value) => Number(value.toFixed(2))),
      });
    });
    return boxes;
  }

  debugFireReport(): { target: string; zone: string; killed: boolean; distance: number; damage: number } | null {
    const report = this.weapons?.tryFire() ?? null;
    if (!report) return null;
    return {
      target: report.target,
      zone: report.zone,
      killed: report.killed,
      distance: Number(report.distance.toFixed(2)),
      damage: Number(report.damage.toFixed(1)),
    };
  }

  /**
   * Spawns up to `count` extra walkers near the block edges.
   *
   * Benchmark hook: measures how the simulation cost scales with the number of
   * live zombies, which is the number the PRD asks to tune from profiling rather
   * than from a guess.
   */
  debugFillHorde(count: number): number {
    const director = this.director;
    const navigation = this.navigation;
    if (!director || !navigation || !this.player) return 0;

    let spawned = 0;
    let attempts = 0;
    while (spawned < count && attempts < count * 20) {
      attempts += 1;
      const angle = this.random.range(0, Math.PI * 2);
      const radius = this.random.range(24, 52);
      const x = this.player.position.x + Math.cos(angle) * radius;
      const z = this.player.position.z + Math.sin(angle) * radius;
      if (!navigation.isWalkableWorld(x, z)) continue;
      if (director.spawn('walker', x, z, angle) !== null) spawned += 1;
    }
    return director.count;
  }

  /**
   * Times the zombie simulation in isolation, with the player pinned alive.
   *
   * Measuring through the normal tick is misleading: a dead player freezes the
   * simulation (by design), so a bench that lets the horde win measures a stopped
   * world. This calls the director directly with `playerAlive` forced true, which
   * is also the expensive case — every zombie keeps chasing and pathing. The
   * player's own update is trivial and deliberately excluded.
   */
  debugBenchmarkDirector(steps: number): { msPerStep: number; zombies: number; engaged: number } {
    const director = this.director;
    const player = this.player;
    if (!director || !player) return { msPerStep: 0, zombies: 0, engaged: 0 };

    const position = player.position.clone();
    for (let i = 0; i < 60; i += 1) director.update(1 / 60, position, true);
    const started = performance.now();
    for (let i = 0; i < steps; i += 1) director.update(1 / 60, position, true);
    const elapsed = performance.now() - started;
    return {
      msPerStep: elapsed / steps,
      zombies: director.count,
      engaged: director.engagedCount,
    };
  }

  /** Directly sets the active-zombie ceiling, for benchmark sweeps. */
  debugSetActiveCap(cap: number): void {
    if (this.director) this.director.maxActive = cap;
    this.waves?.setActiveCap(cap);
  }

  /** Selects a survivor by id and resolves once its model is in the scene. */
  async debugSelectCharacter(id: string): Promise<boolean> {
    return this.loadCharacter(findCharacter(id).id);
  }

  /** Toggles the player avatar, for isolation checks on captured frames. */
  debugSetAvatarVisible(visible: boolean): boolean {
    this.avatar?.setVisible(visible);
    return this.avatar?.visible ?? false;
  }

  /** Toggles the first-person view model, for isolation checks on captured frames. */
  debugSetWeaponModelVisible(visible: boolean): boolean {
    this.weapons?.setViewModelVisible(visible);
    return this.weapons?.viewModelVisible ?? false;
  }

  /** Switches camera mode the same way the V key does. */
  debugToggleView(): string {
    const mode = this.player?.toggleViewMode();
    if (!mode) return 'none';
    this.applyViewModeVisibility();
    return mode;
  }

  /** Geometry/material/shadow facts about the loaded character, for assertions. */
  debugAvatarAudit(): {
    meshes: number;
    /** Meshes that are actually rendered (the bundled extra weapon meshes are off). */
    visibleMeshes: number;
    skinnedMeshes: number;
    shadowCasters: number;
    materials: number;
    texturedMaterials: number;
    anisotropy: number;
    worldHeight: number;
    clipDurations: { idle: number; walk: number; run: number };
    /** Every mesh in the avatar with its name and world-space size, in metres. */
    meshNames: Array<{
      name: string;
      size: [number, number, number];
      vertices: number;
      visible: boolean;
      /** World position of the mesh, which says whether a held weapon is at the hand. */
      position: [number, number, number];
    }>;
    /** Hand bone world position, to compare against the kept weapon mesh. */
    handPosition: [number, number, number] | null;
    hiddenMeshes: string[];
    boneNames: string[];
  } {
    const avatar = this.avatar;
    if (!avatar) {
      return {
        meshes: 0, visibleMeshes: 0, skinnedMeshes: 0, shadowCasters: 0, materials: 0,
        texturedMaterials: 0, anisotropy: 0, worldHeight: 0,
        clipDurations: { idle: 0, walk: 0, run: 0 }, meshNames: [],
        handPosition: null, hiddenMeshes: [], boneNames: [],
      };
    }
    let meshes = 0;
    let visibleMeshes = 0;
    let skinnedMeshes = 0;
    let shadowCasters = 0;
    let materials = 0;
    let texturedMaterials = 0;
    let anisotropy = 0;
    const meshNames: Array<{
      name: string; size: [number, number, number]; vertices: number; visible: boolean;
      position: [number, number, number];
    }> = [];
    const boneNames: string[] = [];
    let handPosition: [number, number, number] | null = null;
    avatar.root.traverse((child) => {
      const bone = child as { isBone?: boolean; name?: string; getWorldPosition?: (v: Vector3) => Vector3 };
      if (bone.isBone && bone.name) {
        boneNames.push(bone.name);
        // The glTF parents the held weapon to a left-hand finger bone, so its world
        // position is the reference for "is the weapon actually in the hand".
        if (/^(middle1|index1|hand)/i.test(bone.name) && !handPosition) {
          const world = new Vector3();
          bone.getWorldPosition?.(world);
          handPosition = [
            Number(world.x.toFixed(2)), Number(world.y.toFixed(2)), Number(world.z.toFixed(2)),
          ];
        }
      }
      const mesh = child as Mesh & { isSkinnedMesh?: boolean };
      if (!mesh.isMesh) return;
      meshes += 1;
      if (mesh.visible) visibleMeshes += 1;
      const size = new Vector3();
      new Box3().setFromObject(mesh).getSize(size);
      const position = (mesh.geometry as import('three').BufferGeometry).getAttribute('position');
      meshNames.push({
        name: mesh.name || '(unnamed)',
        size: [
          Number(size.x.toFixed(3)),
          Number(size.y.toFixed(3)),
          Number(size.z.toFixed(3)),
        ],
        vertices: position ? position.count : 0,
        visible: mesh.visible,
        position: [
          Number(mesh.getWorldPosition(new Vector3()).x.toFixed(2)),
          Number(mesh.getWorldPosition(new Vector3()).y.toFixed(2)),
          Number(mesh.getWorldPosition(new Vector3()).z.toFixed(2)),
        ],
      });
      if (mesh.isSkinnedMesh) skinnedMeshes += 1;
      // Hidden meshes render nothing at all, shadows included, so counting them
      // here would report twelve shadow casters for a one-mesh character.
      if (mesh.visible && mesh.castShadow) shadowCasters += 1;
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of list) {
        materials += 1;
        const map = (material as MeshStandardMaterial & { map?: { isTexture?: boolean; anisotropy?: number } }).map;
        if (map?.isTexture) {
          texturedMaterials += 1;
          anisotropy = Math.max(anisotropy, map.anisotropy ?? 0);
        }
      }
    });
    const box = new Box3().setFromObject(avatar.root);
    const size = new Vector3();
    box.getSize(size);
    const durationOf = (state: 'idle' | 'walk' | 'run'): number => {
      const name = avatar.clipReport[state];
      if (!name) return 0;
      const clip = this.characterClips.find((entry) => entry.name === name);
      return clip ? Number(clip.duration.toFixed(3)) : 0;
    };
    return {
      meshes,
      visibleMeshes,
      skinnedMeshes,
      shadowCasters,
      materials,
      texturedMaterials,
      anisotropy: Number(anisotropy.toFixed(1)),
      worldHeight: Number(size.y.toFixed(3)),
      clipDurations: { idle: durationOf('idle'), walk: durationOf('walk'), run: durationOf('run') },
      meshNames: meshNames.sort((a, b) => b.vertices - a.vertices),
      handPosition,
      hiddenMeshes: avatar.hiddenMeshes,
      boneNames: boneNames.sort(),
    };
  }

  /** Unlocks every weapon, for weapon-switch coverage in the smoke test. */
  debugUnlockAllWeapons(): void {
    this.weapons?.unlock('rifle');
  }

  /** Teleports the player, used to check collision from a known position. */
  debugTeleport(x: number, z: number): void {
    if (!this.player) return;
    this.player.position.set(x, 0, z);
    this.level?.collision.resolveCircle(this.player.position, 0.42);
  }

  /** Test/debug hook: advances the simulation without a browser animation loop. */
  get testHooks(): {
    state: GameState;
    events: EventBus<GameEvents>;
    step: (delta: number) => void;
    snapshot: () => { kills: number; wave: number; activeZombies: number };
  } {
    return {
      state: this.state,
      events: this.events,
      step: (delta: number) => this.update(delta),
      snapshot: () => ({
        kills: this.kills,
        wave: this.waves?.currentWave ?? 0,
        activeZombies: this.director?.count ?? 0,
      }),
    };
  }
}
