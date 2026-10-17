import {
  AnimationClip, Box3, Frustum, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  Object3D, PerspectiveCamera, Quaternion, Scene, Vector3, WebGLRenderTarget,
} from 'three';

import {
  CODE_BUILT_MELEE, DEFAULT_GRENADE, GRENADES, MELEE, MISSION, QUALITY_PRESETS, SHOWCASE, STARTING_WEAPON,
  SURVIVOR_ASSET_ROOT, WEAPON_FEEL, WEAPONS, WORLD,
  type MeleeId, type QualityTier, type WeaponId, type ZombieKind,
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
import { normalizeViewModel } from '../player/viewModel';
import { DamageSystem } from '../combat/DamageSystem';
import { MeleeSystem } from '../combat/MeleeSystem';
import { GrenadeSystem } from '../combat/GrenadeSystem';
import { ZombieFactory } from '../zombies/ZombieFactory';
import { ZombieDirector } from '../zombies/ZombieDirector';
import { NavigationGrid } from '../zombies/NavigationGrid';
import { buildCityLevel, type CityLevelHandle } from '../level/CityLevel';
import { WaveManager } from '../systems/WaveManager';
import { MissionObjectives } from '../systems/MissionObjectives';
import { PickupManager } from '../systems/PickupManager';
import { AudioManager } from '../systems/AudioManager';
import { ImpactEffects } from '../systems/ImpactEffects';
import { BloodEffects } from '../systems/BloodEffects';
import { MuzzleFlash } from '../systems/MuzzleFlash';
import { Tracers } from '../systems/Tracers';
import { BloomPostProcessing, type BloomQuality } from '../engine/Post';
import { HUD, hudVisibleFor } from '../ui/HUD';
import { Menus } from '../ui/Menus';
import { Store, type StoreSnapshot } from '../ui/Store';
import { SettingsStore, type SettingsValues } from '../ui/Settings';
import { ProfileStore, canAfford, ownsItem } from '../economy/ProfileStore';
import { pointsForKill, pointsForWaveCleared } from '../economy/rewards';
import { STORE_ITEMS, findStoreItem, type StoreItem } from '../economy/storeItems';
import { SeededRandom } from '../utils/math';
import { isDrawn } from '../utils/characterGeometry';
import type { GameEvents } from './GameEvents';

const ZOMBIE_KINDS: ZombieKind[] = ['walker', 'runner', 'tank'];
/** Reference up axis for working out which way "right of the weapon" points. */
const WORLD_UP = new Vector3(0, 1, 0);

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
  /** Distance from the player to the current marked objective, metres; 0 when there is none. */
  objectiveDistance: number;
  /** True when the player is inside the objective's completion radius right now. */
  objectiveReached: boolean;
  /** Objectives reached so far this run. */
  objectivesCompleted: number;
  /** True once every objective is reached and the run is won. */
  missionComplete: boolean;
  kills: number;
  hitsLanded: number;
  headshots: number;
  playerHealth: number;
  playerAlive: boolean;
  playerPosition: [number, number];
  playerYaw: number;
  playerPitch: number;
  /** Height of the player's feet above the ground, metres; 0 while walking (see §14.2). */
  playerY: number;
  /** True while the player is on the ground; false for the length of a jump. */
  playerGrounded: boolean;
  /** Air pose the character is holding: 'rise', 'hang', 'land', or null when on its feet. */
  playerJumpPhase: string | null;
  /** Clip names the survivor resolved for each air pose, or null for a rig without them. */
  avatarJumpClips: { rise: string | null; hang: string | null; land: string | null } | null;
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
  /** Melee weapons the avatar has a code-built hand mesh for, and the bone it hangs from. */
  meleeHandMeshes: MeleeId[];
  meleeHandBone: string | null;
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
  /** Grenades left in the pouch and in the air, for the ordnance checks. */
  grenades: number;
  grenadeLive: number;
  activeImpacts: number;
  activeBlood: number;
  activeCasings: number;
  audioSamplesLoaded: number;
  audioSampleShots: number;
  audioSynthShots: number;
  audioFailures: string[];
  muzzleFlashActive: number;
  muzzleSmokeActive: number;
  muzzleFlashSpawned: number;
  tracersActive: number;
  tracersSpawned: number;
  /**
   * F2: what each weapon's slide/bolt/pump is doing. Null when no weapon controller exists
   * yet (the loading screen), which is a different state from "a controller with no
   * mechanisms in it" — that one reports an empty weapon list.
   */
  weaponMechanisms: {
    enabled: boolean;
    running: WeaponId | null;
    weapons: Array<{
      weaponId: WeaponId; kind: string; parts: number;
      travel: number; offset: number; distance: number;
      yawDeg: number; bodyLength: number;
    }>;
  } | null;
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
  /** Points, owned gear and lifetime counters, persisted in this browser. */
  private readonly profile = new ProfileStore();
  /** Reused so ejecting a casing per shot allocates nothing. */
  private readonly casingOrigin = new Vector3();
  private readonly casingDirection = new Vector3();
  private readonly casingRight = new Vector3();
  private readonly random = new SeededRandom(0x5eed);

  private renderer: ReturnType<typeof createRenderer>['renderer'] = null;
  private bloom: BloomPostProcessing | null = null;
  private scene: Scene | null = null;
  private camera: PerspectiveCamera | null = null;
  private lighting: LightingHandle | null = null;
  private navigation: NavigationGrid | null = null;
  private level: CityLevelHandle | null = null;
  private factory: ZombieFactory | null = null;
  private director: ZombieDirector | null = null;
  private damage: DamageSystem | null = null;
  private melee: MeleeSystem | null = null;
  /** Thrown grenades: flight, fuse, blast and the pouch count the HUD shows. */
  private grenades: GrenadeSystem | null = null;
  private player: PlayerController | null = null;
  private health: PlayerHealth | null = null;
  private avatar: PlayerAvatar | null = null;
  private studio: StudioLights | null = null;
  private weapons: WeaponController | null = null;
  private waves: WaveManager | null = null;
  private objectives: MissionObjectives | null = null;
  private pickups: PickupManager | null = null;
  private audio: AudioManager | null = null;
  private impacts: ImpactEffects | null = null;
  private blood: BloodEffects | null = null;
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
  private store: Store | null = null;
  /** True while the store is what put the game in `paused`, so closing it resumes the run. */
  private storePausedGame = false;
  /** View models kept after boot so the store preview can borrow a copy of each mesh. */
  private viewModels = new Map<WeaponId, Object3D>();
  private meleeViewModels = new Map<MeleeId, Object3D>();
  /** The grenade's first-person mesh, painted while slot 4 has it in hand. */
  private grenadeViewModel: Object3D | null = null;
  /**
   * Code-built melee meshes for the character's hand, by weapon id.
   *
   * Separate from `meleeViewModels` on purpose: those are normalised to a fixed on-screen
   * length and parented to the camera for first person, while these are pasted onto the
   * hand bone at their real size for third person (see PlayerAvatar). One loaded copy serves
   * every avatar; the avatar reparents it on its own.
   */
  private meleeHandMeshes: Partial<Record<MeleeId, Object3D>> = {};
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
  /**
   * Whether the last landed shot or swing hit a head. `DamageSystem` emits `combat:hit`
   * immediately before `zombie:killed` for the same blow, so this is what lets the kill
   * payout know a headshot finished it without a second event.
   */
  private lastHitWasHeadshot = false;
  private waveReached = 1;
  private runSeconds = 0;
  /** Points earned during the current run, for the results screen; the balance persists. */
  private runPoints = 0;
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
    this.bloom = new BloomPostProcessing(this.renderer, values.quality as BloomQuality);
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
    this.viewModels = await this.loadViewModels();
    this.meleeViewModels = await this.loadMeleeViewModels();
    this.meleeHandMeshes = await this.loadMeleeHandMeshes();
    this.grenadeViewModel = await this.loadGrenadeViewModel();

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
    this.melee = new MeleeSystem({
      director: this.director,
      collision: this.level.collision,
      events: this.events,
    });
    this.grenades = new GrenadeSystem({
      scene: this.scene,
      director: this.director,
      collision: this.level.collision,
      events: this.events,
    });
    this.weapons = new WeaponController({
      camera: this.camera,
      events: this.events,
      damage: this.damage,
      player: this.player,
      melee: this.melee,
      viewModels: this.viewModels,
      meleeViewModels: this.meleeViewModels,
      grenades: this.grenades,
      grenadeViewModel: this.grenadeViewModel,
      // From the preset, not hard-coded: F2 cost a mesh per weapon and a transform a frame,
      // and which tier can afford that is the preset's decision, not the weapon code's.
      weaponMechanisms: quality.weaponMechanisms,
    });
    this.waves = new WaveManager({
      events: this.events,
      spawner: this.director,
      random: this.random,
      activeCap: quality.zombieCap,
      availableKinds: this.availableKinds,
    });
    // Objectives need the very same grid the waves spawn on: the marked point is chosen
    // from the player's connected region, so a reachable objective rests on the same
    // labelling that keeps unreachable zombies out of a wave.
    if (this.scene && this.navigation) {
      this.objectives = new MissionObjectives({
        scene: this.scene,
        events: this.events,
        grid: this.navigation,
        random: this.random,
      });
    }
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
    // Blood carries no budget: the preset may cap its pools but must never blank the one
    // cue that says a blow connected. See BloodEffects.
    this.blood = new BloodEffects({ scene: this.scene, random: this.random });
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

    // The store only needs the canvas from index.html and a way to read the economy; the
    // rules themselves live in src/economy so they can be tested without a DOM.
    this.store = new Store({
      snapshot: () => this.storeSnapshot(),
      purchase: (itemId) => this.buyStoreItem(itemId),
      onClose: () => this.closeStore(),
      previewModel: (item) => this.previewModelFor(item),
    });

    this.input = new InputManager(this.canvas);
    this.input.attach();
    this.pointerLock = new PointerLockController(this.canvas);
    this.pointerLock.attach();
    this.pointerLock.onChange((status) => this.onPointerLockChange(status));

    this.events.on('zombie:killed', ({ kind }) => {
      this.kills += 1;
      // Paid from the kill event, not the hit: a shotgun pellet that kills emits several
      // hits but exactly one kill, so the payout cannot be counted twice.
      const headshot = this.lastHitWasHeadshot;
      this.awardPoints(pointsForKill(kind, headshot), headshot ? 'headshot' : 'kill');
    });
    this.events.on('combat:hit', ({ zone }) => {
      this.hitsLanded += 1;
      if (zone === 'head') this.headshots += 1;
      // The kill for this blow arrives in the same call, hit first, so this is what tells
      // the payout above that a headshot finished it.
      this.lastHitWasHeadshot = zone === 'head';
    });
    this.events.on('wave:started', ({ wave }) => {
      this.waveReached = Math.max(this.waveReached, wave);
    });
    this.events.on('wave:cleared', ({ wave }) => {
      // Once per wave, and only because the wave is actually over: the bonus is for
      // finishing, not for the last straggler.
      this.awardPoints(pointsForWaveCleared(wave), 'wave');
    });
    this.events.on('combat:hit', ({ killed, zone, point }) => {
      // The zone picks the blood: a headshot throws more, brighter blood than a body hit,
      // and a killing blow throws more than either. Blood is its own system again (F6);
      // world hits keep their per-material sparks in ImpactEffects (F5).
      this.blood?.spawn(point[0], point[1], point[2], zone, killed);
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
    this.events.on('combat:world-hit', ({ tag, point }) => {
      // The collision world already labels what was hit; the spark profile is chosen
      // from that tag, and an unrecognised tag takes the default dust (F5).
      this.impacts?.spawn(point[0], point[1], point[2], 0, tag);
      this.lastHitPoint.set(point[0], point[1], point[2]);
      this.hitPointValid = true;
    });
    this.events.on('melee:equipped', ({ meleeId }) => {
      this.events.emit('toast', {
        text: `${MELEE[meleeId].name} drawn — click or F to swing, 1/2/4 for a firearm or a grenade`,
        tone: 'info',
      });
    });
    this.events.on('melee:swung', ({ clip, swingSeconds }) => {
      // Third person sees the character, not the view model, so the rig's own swing clip
      // is the only thing that shows the attack there. Stretched to the weapon's swing
      // length so a knife and an axe are not the same speed.
      this.avatar?.playMeleeAttack(clip, swingSeconds);
    });
    this.events.on('player:died', ({ cause }) => this.handlePlayerDeath(cause));
    // The objectives system owns the win condition; the orchestrator owns the screen that
    // reports it, the same split as the wave events above.
    this.events.on('mission:complete', () => this.handleMissionComplete());

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
        const object = normalizeViewModel(loaded.scene);
        models.set(id, object);
      } catch (error) {
        console.warn(`[weapons] view model for ${id} unavailable, continuing without it`, error);
        this.loadFailures.push(`weapon model for ${id}`);
      }
    }
    return models;
  }

  /**
   * Loads the melee view models.
   *
   * Separate from `loadViewModels` only because the tables are separate; the meshes get
   * exactly the same normalisation, so a spear drawn in first person is scaled and lit
   * like a rifle rather than by a second set of rules.
   */
  private async loadMeleeViewModels(): Promise<Map<MeleeId, Object3D>> {
    const models = new Map<MeleeId, Object3D>();
    for (const id of Object.keys(MELEE) as MeleeId[]) {
      const config = MELEE[id];
      try {
        const loaded = await this.assets.loadModel(config.modelPath);
        // A clone, not the loaded scene: AssetManager caches by URL, so `loaded.scene` is a
        // shared original, and `loadMeleeHandMeshes` clones the same original for the
        // character's hand. Normalising in place would shrink the hand copy to the
        // first-person length.
        models.set(id, normalizeViewModel(loaded.scene.clone(true)));
      } catch (error) {
        console.warn(`[melee] view model for ${id} unavailable, continuing without it`, error);
        this.loadFailures.push(`melee model for ${id}`);
      }
    }
    return models;
  }

  /**
   * Loads the meshes that go in the character's hand in third person.
   *
   * Only the melee weapons the survivor bundle does not ship (`CODE_BUILT_MELEE`): the four
   * the bundle does ship are switched on inside the character file and need nothing loaded.
   * these are deliberately NOT run through `normalizeViewModel`, which would shrink a katana
   * to the same on-screen length as a knife and lift its materials for a camera a metre away:
   * a weapon in the character's hand is sized in metres like the body it hangs from, exactly
   * as the code-built gear is.
   *
   * Each is a clone of the cached load rather than the load itself: the first-person view
   * model comes from the same URL, and one Object3D cannot hang on two parents. The materials
   * are shared with that view model, so the small emissive lift it gets for a camera at arm's
   * length shows here too, which only makes the weapon a little more readable in the dusk.
   */
  private async loadMeleeHandMeshes(): Promise<Partial<Record<MeleeId, Object3D>>> {
    const meshes: Partial<Record<MeleeId, Object3D>> = {};
    for (const id of CODE_BUILT_MELEE) {
      try {
        const loaded = await this.assets.loadModel(MELEE[id].modelPath);
        meshes[id] = loaded.scene.clone(true);
      } catch (error) {
        console.warn(`[melee] hand mesh for ${id} unavailable, third person shows no weapon`, error);
        this.loadFailures.push(`melee hand mesh for ${id}`);
      }
    }
    return meshes;
  }

  /**
   * Loads the grenade's first-person mesh.
   *
   * The same normalisation as a firearm or melee view model, so a grenade held in one hand is
   * scaled and lit by one rule rather than by a second one. A clone of the cached load, because
   * `previewModelFor` hands the store its own copy and the same Object3D cannot hang on two
   * parents.
   */
  private async loadGrenadeViewModel(): Promise<Object3D | null> {
    const config = GRENADES[DEFAULT_GRENADE];
    try {
      const loaded = await this.assets.loadModel(config.modelPath);
      return normalizeViewModel(loaded.scene.clone(true));
    } catch (error) {
      console.warn(`[grenade] view model for ${config.id} unavailable, slot 4 draws nothing`, error);
      this.loadFailures.push(`grenade model for ${config.id}`);
      return null;
    }
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
    this.runPoints = 0;
    this.impacts?.clear();
    this.blood?.clear();
    this.muzzleFlash?.clear();
    this.tracers?.clear();
    this.player.reset();
    this.health.reset();
    this.weapons.reset();
    // A fresh pouch of grenades for the run, and nothing left in the air from the last one.
    this.grenades?.reset();
    // Gear bought in earlier runs is re-granted here, so a run starts with everything owned.
    this.applyProfileLoadout();
    this.director.clear();
    this.pickups?.clear();
    this.waves.reset();
    this.waves.start();
    // The first objective is placed from the spawn point, so the marker is a real walk away
    // rather than something the player is already standing on.
    this.objectives?.start(this.player.position.x, this.player.position.z);
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
    this.grenades?.reset();
    this.applyProfileLoadout();
    this.kills = 0;
    this.hitsLanded = 0;
    this.headshots = 0;
    this.waveReached = 1;
    this.runSeconds = 0;
    this.runPoints = 0;
    this.impacts?.clear();
    this.blood?.clear();
    this.muzzleFlash?.clear();
    this.tracers?.clear();
    this.waves?.reset();
    this.waves?.start();
    if (this.player) this.objectives?.start(this.player.position.x, this.player.position.z);
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
    this.grenades?.clear();
    this.waves?.reset();
    // Drop the objective marker too: the title screen shows the survivor, not a lit point
    // left over from the last run.
    this.objectives?.stop();
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
    // The run is over, so the objective marker stops being something to chase. Hiding it
    // here, not only on reset, keeps a lit point from hovering over the death screen.
    this.objectives?.stop();
    // Points survive the run; the run's counters are what get recorded.
    this.profile.recordRun(this.kills, this.waveReached);
    this.menus?.showGameOver({
      cause,
      kills: this.kills,
      wave: this.waveReached,
      survivedSeconds: this.runSeconds,
    });
  }

  /**
   * Shows the results screen when the last objective is reached.
   *
   * Reuses the `gameOver` phase deliberately: it already means "the simulation stops and the
   * HUD comes down", which is exactly what a won run needs, and it is an allowed transition
   * from `playing`. What differs is the screen — and it must, because showing "You died" to
   * a player who finished the mission would be a lie. The guard mirrors the death path so
   * the two endings can never both fire.
   */
  private handleMissionComplete(): void {
    if (this.state.phase === 'gameOver') return;
    this.state.set('gameOver');
    this.pointerLock?.exit();
    this.profile.recordRun(this.kills, this.waveReached);
    this.menus?.showMissionComplete({
      objectives: this.objectives?.completed ?? MISSION.objectiveCount,
      kills: this.kills,
      points: this.runPoints,
      survivedSeconds: this.runSeconds,
    });
  }

  private onPhaseChange(phase: GamePhase): void {
    const playing = phase === 'playing';
    // The store lives only on the pause phase: any other transition (resume, death, exit to
    // title) closes it, so it can never be left on screen over a live run.
    if (this.store?.isOpen && phase !== 'paused') {
      this.store.close();
      this.storePausedGame = false;
    }
    this.input?.setEnabled(playing);
    this.player?.setEnabled(playing);
    if (phase === 'paused') this.events.emit('game:paused', {});
    // One rule, read from the phase, in both directions (see `hudVisibleFor`): the HUD is the
    // in-run readout, so only a live run may show it. Every other phase — including the two
    // endings, which both pass through `gameOver` — takes it down.
    if (hudVisibleFor(phase)) this.hud?.show();
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
    this.avatar = new PlayerAvatar({
      model: { scene: model.scene, animations: model.animations },
      spec,
      anisotropy: this.maxAnisotropy,
      meleeHandMeshes: this.meleeHandMeshes,
    });
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
    // The jump's two cues come from what the controller actually did, not from the key:
    // a press while airborne does nothing, so it must not be heard.
    const motion = this.player.consumeMotionEvents();
    if (motion.jumped) this.events.emit('player:jumped', {});
    if (motion.landed) this.events.emit('player:landed', {});
    // The character follows the controller; its cycle rate comes from ground speed,
    // so the feet keep up with however fast the player is actually moving.
    // `facingAngle`, not `yaw`: the pack's models face +Z, which is the convention
    // the zombies already use (atan2 of the movement direction). Feeding the camera
    // yaw here rotated the character 180 degrees, so it moonwalked.
    this.avatar?.update(delta, this.player.position, this.player.facingAngle, this.player.speed);
    // Air pose after the position: the rig plays Jump/Jump_Idle/Jump_Land for as long as the
    // controller reports it is off the ground, and hands the body back on landing.
    this.avatar?.setJumpPhase(this.player.jumpPhase);
    // The melee mesh in the character's hand follows the weapon in hand; its slung twin on
    // the pack is hidden while it is drawn, so the tool is never in two places at once.
    this.avatar?.setMeleeWeapon(this.weapons.isMeleeDrawn ? this.weapons.activeMelee.id : null);
    this.weapons.update(delta, input, true);
    this.health.update(delta);
    // Flight, fuse and blast on the same run clock as everything else: a grenade in the air
    // freezes when the game is paused along with the world.
    this.grenades?.update(delta);

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

    // Objectives ride on the same player position and clock as the waves. If reaching the
    // last point fires mission:complete, the phase flips to gameOver on this line and the
    // results screen appears; the rest of the frame is harmless.
    this.objectives?.update(delta, {
      playerX: this.player.position.x,
      playerZ: this.player.position.z,
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
    if (pickupResult.grenades > 0) this.grenades?.add(pickupResult.grenades);
    if (pickupResult.weapon) {
      this.weapons.unlock(pickupResult.weapon);
      this.weapons.addReserve(pickupResult.weapon, WEAPONS[pickupResult.weapon].startingReserve);
    }

    this.impacts?.update(delta, this.player.eyePosition);
    this.blood?.update(delta, this.player.eyePosition);
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
    // Derived from the live player position every frame, never cached: the distance and the
    // arrow must match where the player actually is, not where it was when the point was set.
    const objectives = this.objectives;
    const playerX = this.player?.position.x ?? 0;
    const playerZ = this.player?.position.z ?? 0;
    const playerYaw = this.player?.facingAngle ?? 0;
    this.hud.update(delta, {
      health: this.health.current,
      ammo: snapshot.magazine,
      reserve: snapshot.reserve,
      weaponName: snapshot.name,
      // The melee weapon has no magazine, so the HUD shows its name and a plain marker
      // instead of the last firearm's ammunition (see HUD.hudWeaponReadout).
      melee: this.weapons.isMeleeDrawn,
      meleeName: this.weapons.activeMelee.name,
      ordnance: this.weapons.isOrdnanceSelected,
      ordnanceName: this.weapons.activeGrenade.name,
      grenades: this.grenades?.available ?? 0,
      kills: this.kills,
      wave: this.waves.currentWave,
      remaining: this.waves.remainingInWave,
      points: this.profile.current.points,
      reloading: snapshot.reloading,
      spread: snapshot.spread,
      objective: objectives?.instructionFrom(playerX, playerZ) ?? '',
      objectiveAngle: objectives?.bearingFrom(playerX, playerZ, playerYaw) ?? 0,
      objectiveActive: objectives ? objectives.point !== null : false,
    });
  }

  private render(frameDeltaSeconds = 1 / 60): void {
    if (!this.renderer || !this.scene || !this.camera) return;
    if (this.bloom) this.bloom.render(this.scene, this.camera);
    else this.renderer.render(this.scene, this.camera);
    // The store owns a second, small renderer; it draws only while the shop is open.
    this.store?.render(frameDeltaSeconds);

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
      `objective ${this.objectives ? `${this.objectives.completed}/${this.objectives.total}` : '—'}`,
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
    if (event.code === 'KeyB' && !event.repeat) {
      // B is free elsewhere: F is melee, V the camera, F3 the overlay, 1/2 the slots.
      event.preventDefault();
      this.toggleStore();
      return;
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
    this.bloom?.dispose();
    this.bloom = this.renderer
      ? new BloomPostProcessing(this.renderer, tier as BloomQuality)
      : null;
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
    // Post-processing follows the same quality tier as the rest of the renderer;
    // low is an explicit no-bloom path for SwiftShader and weaker devices.
    this.bloom?.dispose();
    this.bloom = this.renderer
      ? new BloomPostProcessing(this.renderer, this.settings.current.quality as BloomQuality)
      : null;
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
  // Economy and store
  // -------------------------------------------------------------------------

  /**
   * Adds points and tells the HUD.
   *
   * Refused unless the simulation is actually running: a straggler finished off after the
   * wave was cleared, or a kill landing as the player dies, must not pay. The balance itself
   * is persisted by `ProfileStore`, so points carry between runs.
   */
  private awardPoints(amount: number, reason: 'kill' | 'headshot' | 'wave'): void {
    if (amount <= 0 || !this.state.isSimulationActive) return;
    const total = this.profile.award(amount);
    // The run's own earnings, kept beside the persistent balance: the results screen shows
    // what this run scored, not the lifetime total that carried in from other runs.
    this.runPoints += amount;
    this.events.emit('points:awarded', { amount, total, reason });
  }

  /**
   * Re-grants everything in the profile at the start of a run.
   *
   * A run reset returns the loadout to the sidearm; without this, gear bought in an earlier
   * run would be owned but not in hand. Uses the quiet grant rather than `unlock` so no
   * "new weapon" toast fires for a weapon bought several runs ago, and the run still starts
   * with the sidearm in hand (which is what the reset left there).
   */
  private applyProfileLoadout(): void {
    if (!this.weapons) return;
    const profile = this.profile.current;
    for (const id of profile.ownedFirearms) {
      if (id === STARTING_WEAPON) continue;
      this.weapons.grantWeapon(id);
    }
    // Every owned melee weapon, not just the carried one: slot 3 rotates through what the
    // player owns, so a weapon left out of this list would be unreachable until it was bought
    // again. The last one owned is what F draws.
    for (const id of profile.ownedMelee) this.weapons.grantMelee(id);
    const melee = profile.ownedMelee[profile.ownedMelee.length - 1];
    if (melee) this.weapons.setCarriedMelee(melee);
  }

  /**
   * Whether the store may be opened right now.
   *
   * Two windows, both of them "nothing is hunting you": while the game is paused, and during
   * the wave director's `break` phase — the seconds between one wave being cleared and the
   * next arriving. It is deliberately not reachable mid-wave: a shop you can be eaten in is
   * not a shop, and pausing to shop mid-fight would be a free damage stop.
   */
  private canOpenStore(): boolean {
    if (this.state.phase === 'paused') return true;
    return this.state.phase === 'playing' && this.waves?.currentPhase === 'break';
  }

  private toggleStore(): void {
    const store = this.store;
    if (!store) return;
    if (store.isOpen) {
      this.closeStore();
      return;
    }
    if (!this.canOpenStore()) {
      this.events.emit('toast', {
        text: 'The trade post opens between waves, or while paused.',
        tone: 'warn',
      });
      return;
    }
    if (this.state.phase === 'playing') {
      // Shopping during the between-wave break stops the world too: one rule for both doors,
      // and the wave director does not tick while paused.
      //
      // The pointer is released first. A locked pointer has no cursor, so the buttons would
      // render but not be clickable, and the store is meant to be usable with a mouse.
      this.pointerLock?.exit();
      if (this.state.phase === 'playing') this.state.set('paused');
      this.storePausedGame = true;
    }
    this.menus?.showScreen('none');
    store.open();
  }

  private closeStore(): void {
    const store = this.store;
    if (!store?.isOpen) return;
    store.close();
    if (this.storePausedGame && this.state.phase === 'paused') {
      // Opened mid-run: hand the player straight back to the fight.
      this.storePausedGame = false;
      this.resume();
      return;
    }
    this.storePausedGame = false;
    if (this.state.phase === 'paused') this.menus?.showScreen('pause');
  }

  /** Current economy state, derived from the profile through the shared pure rules. */
  private storeSnapshot(): StoreSnapshot {
    const profile = this.profile.current;
    const owned: string[] = [];
    const purchasable: string[] = [];
    for (const item of STORE_ITEMS) {
      if (ownsItem(profile, item)) {
        owned.push(item.id);
        continue;
      }
      if (canAfford(profile, item)) purchasable.push(item.id);
    }
    return { points: profile.points, earnedTotal: profile.earnedTotal, owned, purchasable };
  }

  /** Buys one item: the rules live in ProfileStore, the arming of it lives here. */
  private buyStoreItem(itemId: string): { ok: boolean; reason: string } {
    const item = findStoreItem(itemId);
    if (!item) return { ok: false, reason: 'unknown' };
    const outcome = this.profile.buy(item);
    if (!outcome.ok) {
      this.events.emit('toast', {
        text: outcome.reason === 'owned'
          ? `${item.name} is already yours.`
          : `Not enough points for ${item.name}.`,
        tone: 'warn',
      });
      return { ok: false, reason: outcome.reason };
    }
    this.grantStoreItem(item);
    this.events.emit('store:purchased', {
      itemId: item.id,
      price: item.price,
      points: outcome.profile.points,
    });
    this.events.emit('toast', { text: `${item.name} bought — ${item.price} points.`, tone: 'info' });
    this.store?.refresh();
    return { ok: true, reason: 'ok' };
  }

  /** Puts a bought item in the player's hands, through the existing weapon APIs. */
  private grantStoreItem(item: StoreItem): void {
    if (!this.weapons) return;
    if (item.category === 'firearm') {
      // unlock() also adds it to the loadout and switches to it.
      this.weapons.unlock(item.id);
      return;
    }
    if (item.category === 'ordnance') {
      // A grenade is spent when thrown, so a purchase tops up the pouch rather than arming a
      // weapon: it is the one row that can be bought again and again.
      this.grenades?.add(item.quantity);
      return;
    }
    // Melee has no ownership list of its own: the carried melee id *is* the ownership, so
    // setting it and drawing it is the whole grant. It also joins the slot-3 rotation.
    this.weapons.setCarriedMelee(item.id);
    this.weapons.equipMelee(item.id);
  }

  /**
   * A copy of an item's mesh for the store preview.
   *
   * A clone rather than the model itself: the originals are parented to the game camera as
   * first-person view models, and moving one into the preview scene would leave the player
   * holding nothing.
   */
  private previewModelFor(item: StoreItem): Object3D | null {
    const source = item.category === 'firearm'
      ? this.viewModels.get(item.id)
      : item.category === 'melee'
        ? this.meleeViewModels.get(item.id)
        : this.grenadeViewModel;
    return source ? source.clone(true) : null;
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
    this.store?.dispose();
    this.bloom?.dispose();
    this.bloom = null;
    this.events.clear();

    this.impacts?.dispose();
    this.blood?.dispose();
    this.muzzleFlash?.dispose();
    this.tracers?.dispose();
    this.pickups?.dispose();
    this.objectives?.dispose();
    this.director?.dispose();
    this.grenades?.dispose();
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
      // Objective state is read live from where the player is right now, which is what makes
      // it checkable without a browser: teleport, read these, step, read them again.
      objectiveDistance: Number((this.objectives?.distanceTo(
        this.player?.position.x ?? 0,
        this.player?.position.z ?? 0,
      ) ?? 0).toFixed(2)),
      objectiveReached: this.objectives?.isReached(
        this.player?.position.x ?? 0,
        this.player?.position.z ?? 0,
      ) ?? false,
      objectivesCompleted: this.objectives?.completed ?? 0,
      missionComplete: this.objectives?.isComplete ?? false,
      kills: this.kills,
      hitsLanded: this.hitsLanded,
      headshots: this.headshots,
      playerHealth: this.health?.current ?? 0,
      playerAlive: this.health?.isAlive ?? false,
      playerPosition: [Number((this.player?.position.x ?? 0).toFixed(2)), Number((this.player?.position.z ?? 0).toFixed(2))],
      playerYaw: Number((this.player?.yaw ?? 0).toFixed(3)),
      playerPitch: Number((this.player?.pitch ?? 0).toFixed(3)),
      playerY: Number((this.player?.position.y ?? 0).toFixed(3)),
      playerGrounded: this.player?.grounded ?? false,
      playerJumpPhase: this.player?.jumpPhase ?? null,
      avatarJumpClips: this.avatar?.jumpClipReport ?? null,
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
      meleeHandMeshes: this.avatar?.meleeWeaponReport.handMeshes ?? [],
      meleeHandBone: this.avatar?.meleeWeaponReport.handBone ?? null,
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
      grenades: this.grenades?.available ?? 0,
      grenadeLive: this.grenades?.liveCount ?? 0,
      activeImpacts: this.impacts?.activeCount ?? 0,
      activeBlood: this.blood?.activeCount ?? 0,
      activeCasings: this.impacts?.activeCasingCount ?? 0,
      audioSamplesLoaded: this.audio?.statistics.loaded ?? 0,
      audioSampleShots: this.audio?.statistics.sampleShots ?? 0,
      audioSynthShots: this.audio?.statistics.synthShots ?? 0,
      audioFailures: this.audio?.statistics.failures ?? [],
      muzzleFlashActive: this.muzzleFlash?.activeCount ?? 0,
      muzzleSmokeActive: this.muzzleFlash?.activeSmokeCount ?? 0,
      muzzleFlashSpawned: this.muzzleFlash?.spawnCount ?? 0,
      tracersActive: this.tracers?.activeCount ?? 0,
      tracersSpawned: this.tracers?.spawnCount ?? 0,
      // F2: what the weapons' slides/bolts/pumps are doing. Per weapon, with the part count,
      // because "the part did not move" and "there is no part" have to be told apart, and
      // because the part is the one piece of this that cannot be checked from a boolean.
      weaponMechanisms: this.weapons?.mechanismReport ?? null,
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
      // Eye height off the player's own feet height, so a captured frame of a jump shows the
      // camera up where the player actually is.
      camera.position.set(this.player.position.x, this.player.position.y + 1.62, this.player.position.z);
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
    player.pitch = Math.atan2(nearest.y - (player.position.y + 1.62), horizontal);
    camera.rotation.order = 'YXZ';
    camera.rotation.set(player.pitch, player.yaw, 0);
    camera.position.set(player.position.x, player.position.y + 1.62, player.position.z);
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
    arms: Array<{
      name: string; screen: [number, number]; box: [number, number, number, number];
      handScreen: [number, number]; handBox: [number, number, number, number];
      distance: number; occludedBy: string | null;
    }>;
  } {
    return this.weapons?.handsReport
      ?? { parts: 0, visible: false, position: null, screen: null, distance: null, arms: [] };
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
   * State of the melee weapon, for the verification harness.
   *
   * Reports the swing rather than the weapon table: whether a melee is actually out,
   * whether a swing is in the air, and what the last landed blow did. `damage` and
   * `lastTarget` describe that blow, not the config, so they stay 0 until a swing lands.
   */
  debugMeleeReport(): {
    equipped: MeleeId | null;
    swinging: boolean;
    cooldown: number;
    lastTarget: number | null;
    damage: number;
  } {
    return this.weapons?.meleeReport
      ?? { equipped: null, swinging: false, cooldown: 0, lastTarget: null, damage: 0 };
  }

  /** Draws the melee weapon, as the F key does. */
  debugEquipMelee(id: MeleeId | null = null): MeleeId | null {
    if (!this.weapons) return null;
    this.weapons.equipMelee(id ?? undefined);
    return this.weapons.meleeReport.equipped;
  }

  /** Swings the melee weapon once, bypassing the input layer. */
  debugSwingMelee(): boolean {
    return this.weapons?.tryMelee() ?? false;
  }

  /** Selects the grenade, as the 4 key does. */
  debugSelectOrdnance(): boolean {
    return this.weapons?.equipOrdnance() ?? false;
  }

  /** Throws a grenade, as a left click with the grenade in hand does. */
  debugThrowGrenade(): boolean {
    return this.weapons?.tryThrowGrenade() ?? false;
  }

  /** Live ordnance state: the pouch, the projectiles in flight, and the total thrown this run. */
  debugGrenadeReport(): { count: number; live: number; thrown: number } {
    return this.grenades?.report() ?? { count: 0, live: 0, thrown: 0 };
  }

  /**
   * Buys a store item as the buy button does. Returns the outcome and the new balance, so a
   * harness can assert the exact deduction without reading the DOM.
   */
  debugPurchase(itemId: string): { ok: boolean; reason: string; points: number } {
    const result = this.buyStoreItem(itemId);
    return { ...result, points: this.profile.current.points };
  }

  /** Spendable balance. Persisted between runs, which is the whole point of it. */
  debugPoints(): number {
    return this.profile.current.points;
  }

  /**
   * Current directional objective, for the verification harness.
   *
   * Reports the marked point's coordinates as well as the player's standing relative to it,
   * so a headless harness can teleport the player onto the point (see `debugTeleport`), step
   * once, and watch `completed` rise — all without a browser or a rendered frame.
   */
  debugObjectiveReport(): {
    index: number;
    total: number;
    x: number | null;
    z: number | null;
    distance: number | null;
    reached: boolean;
    completed: number;
    missionComplete: boolean;
    instruction: string;
  } {
    const objectives = this.objectives;
    const playerX = this.player?.position.x ?? 0;
    const playerZ = this.player?.position.z ?? 0;
    const point = objectives?.point ?? null;
    const distance = objectives?.distanceTo(playerX, playerZ) ?? null;
    return {
      index: objectives ? Math.min(objectives.completed + 1, objectives.total) : 0,
      total: objectives?.total ?? MISSION.objectiveCount,
      x: point ? Number(point.x.toFixed(2)) : null,
      z: point ? Number(point.z.toFixed(2)) : null,
      distance: distance === null ? null : Number(distance.toFixed(2)),
      reached: objectives?.isReached(playerX, playerZ) ?? false,
      completed: objectives?.completed ?? 0,
      missionComplete: objectives?.isComplete ?? false,
      instruction: objectives?.instructionFrom(playerX, playerZ) ?? '',
    };
  }

  /**
   * What the store shows right now: whether it is open, what it can sell, what is already
   * owned, and the balances. Read from the same pure rules the overlay uses.
   */
  debugStoreReport(): {
    open: boolean;
    purchasable: string[];
    owned: string[];
    points: number;
    earnedTotal: number;
  } {
    return { open: this.store?.isOpen ?? false, ...this.storeSnapshot() };
  }

  /** Toggles the store the way the B key does. Returns whether it is now open. */
  debugToggleStore(): boolean {
    this.toggleStore();
    return this.store?.isOpen ?? false;
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
    /**
     * Meshes that are actually drawn — the mesh's own `visible` flag *and* every ancestor's.
     *
     * Effective visibility, not the flag alone: the code-built melee weapon groups hang off
     * the hand switched off, and their children keep `visible === true` locally, so counting
     * flags reported 37 meshes that are not on screen as drawn geometry.
     */
    visibleMeshes: number;
    skinnedMeshes: number;
    shadowCasters: number;
    materials: number;
    texturedMaterials: number;
    anisotropy: number;
    worldHeight: number;
    clipDurations: { idle: number; walk: number; run: number };
    /**
     * The character's own geometry only: drawn meshes that are not one of the weapons hung on
     * it (see `weaponMeshes`). This is what "is the survivor textured and casting a shadow"
     * is about, and it is what the smoke check asserts on.
     */
    bodyMeshes: number;
    /** Of `bodyMeshes`, those in the shadow pass. Must equal `bodyMeshes`. */
    bodyShadowCasters: number;
    /** Of `bodyMeshes`, those carrying at least one texture map. At least one should. */
    bodyTexturedMeshes: number;
    /** Meshes under a known weapon attachment: the firearm in hand and the melee meshes. */
    weaponMeshes: number;
    /** Of `weaponMeshes`, the ones the avatar is actually holding right now. */
    weaponDrawnMeshes: number;
    /** Of `weaponDrawnMeshes`, those in the shadow pass. Must equal `weaponDrawnMeshes`. */
    weaponDrawnShadowCasters: number;
    /** Every mesh in the avatar with its name and world-space size, in metres. */
    meshNames: Array<{
      name: string;
      size: [number, number, number];
      vertices: number;
      visible: boolean;
      /** True when the mesh is drawn, ancestors included. */
      drawn: boolean;
      /** True when the mesh is part of a weapon attachment rather than the body. */
      attachment: boolean;
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
        bodyMeshes: 0, bodyShadowCasters: 0, bodyTexturedMeshes: 0,
        weaponMeshes: 0, weaponDrawnMeshes: 0, weaponDrawnShadowCasters: 0,
      };
    }
    let meshes = 0;
    let visibleMeshes = 0;
    let skinnedMeshes = 0;
    let shadowCasters = 0;
    let materials = 0;
    let texturedMaterials = 0;
    let anisotropy = 0;
    let bodyMeshes = 0;
    let bodyShadowCasters = 0;
    let bodyTexturedMeshes = 0;
    let weaponMeshes = 0;
    let weaponDrawnMeshes = 0;
    let weaponDrawnShadowCasters = 0;
    /**
     * The weapons the avatar hung on the character, by identity, taken from its own registries
     * rather than from mesh names: the packed file names its weapons `Rifle`, `Axe`, `Spear`…,
     * the code-built ones are glTF groups named `WeaponKatana` and so on, and the character's
     * geometry is named after the survivor, so no one pattern covers the attachments while
     * leaving the body alone (see `PlayerAvatar.weaponAttachmentRoots`).
     */
    const attachmentRoots = new Set<Object3D>(avatar.weaponAttachmentRoots);
    const isAttachment = (mesh: Object3D): boolean => {
      for (let node: Object3D | null = mesh; node && node !== avatar.root; node = node.parent) {
        if (attachmentRoots.has(node)) return true;
      }
      return false;
    };
    const meshNames: Array<{
      name: string; size: [number, number, number]; vertices: number; visible: boolean;
      drawn: boolean; attachment: boolean; position: [number, number, number];
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
      // Drawn, not merely flagged: a weapon group switched off hides its children at render
      // time whatever their own flag says, so the flag alone over-reports what is on screen.
      const drawn = isDrawn(mesh, avatar.root);
      const attachment = isAttachment(mesh);
      if (drawn) visibleMeshes += 1;
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
        drawn,
        attachment,
        position: [
          Number(mesh.getWorldPosition(new Vector3()).x.toFixed(2)),
          Number(mesh.getWorldPosition(new Vector3()).y.toFixed(2)),
          Number(mesh.getWorldPosition(new Vector3()).z.toFixed(2)),
        ],
      });
      if (mesh.isSkinnedMesh) skinnedMeshes += 1;
      // Hidden meshes render nothing at all, shadows included, so counting them
      // here would report twelve shadow casters for a one-mesh character.
      if (drawn && mesh.castShadow) shadowCasters += 1;
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      let textured = false;
      for (const material of list) {
        materials += 1;
        const map = (material as MeshStandardMaterial & { map?: { isTexture?: boolean; anisotropy?: number } }).map;
        if (map?.isTexture) {
          textured = true;
          texturedMaterials += 1;
          anisotropy = Math.max(anisotropy, map.anisotropy ?? 0);
        }
      }
      if (attachment) {
        weaponMeshes += 1;
        if (!drawn) return;
        weaponDrawnMeshes += 1;
        if (mesh.castShadow) weaponDrawnShadowCasters += 1;
        return;
      }
      // Body geometry that is not drawn at all is not part of the question either: the
      // character files ship their own inventory of weapons alongside the body mesh, all of
      // them switched off at construction (see PlayerAvatar.hiddenMeshes).
      if (!drawn) return;
      bodyMeshes += 1;
      if (mesh.castShadow) bodyShadowCasters += 1;
      if (textured) bodyTexturedMeshes += 1;
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
      bodyMeshes,
      bodyShadowCasters,
      bodyTexturedMeshes,
      weaponMeshes,
      weaponDrawnMeshes,
      weaponDrawnShadowCasters,
      meshNames: meshNames.sort((a, b) => b.vertices - a.vertices),
      handPosition,
      hiddenMeshes: avatar.hiddenMeshes,
      boneNames: boneNames.sort(),
    };
  }

  /** The weapon table as the game sees it, so harnesses stop hardcoding its numbers. */
  debugWeaponConfig(): typeof WEAPONS {
    return WEAPONS;
  }

  /**
   * The melee table, for the same reason: the harness was hardcoding reach and arc, and a
   * stand-off of 2.0 m against an axe whose reach is also 2.0 m is a measurement with no
   * margin, which reads as "the weapon does not work".
   */
  debugMeleeConfig(): typeof MELEE {
    return MELEE;
  }

  /**
   * Unlocks every weapon, for weapon-switch coverage in the smoke test.
   *
   * Ends with the rifle in hand on purpose: unlocking a weapon also equips it, so a loop
   * over the config leaves whichever is declared last — the shotgun — and the smoke's
   * two-weapon check then reads the wrong weapon and fails on a hook rather than a bug.
   */
  debugUnlockAllWeapons(): void {
    for (const id of Object.keys(WEAPONS) as WeaponId[]) this.weapons?.unlock(id);
    this.weapons?.switchTo('rifle');
  }

  /**
   * Puts a named weapon in the player's hands, unlocking it first.
   *
   * Used by the capture tool to photograph each view model: a weapon whose mesh failed to
   * load still fires, so the only way to see that a model is missing is to look at it.
   */
  debugSelectWeapon(id: WeaponId): boolean {
    if (!this.weapons) return false;
    this.weapons.unlock(id);
    return this.weapons.switchTo(id);
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
