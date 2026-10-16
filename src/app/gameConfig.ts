/**
 * Every balance and tuning value lives here.
 *
 * Gameplay modules import these constants instead of hard-coding numbers, so a
 * balance change is one edit and the values are also readable by tests.
 */

// ---------------------------------------------------------------------------
// World / level
// ---------------------------------------------------------------------------

export const WORLD = {
  /** Ground plane extends this far in both axes (metres). */
  size: 140,
  /** Playable rectangle used by the navigation grid and spawn logic. */
  playArea: { minX: -60, maxX: 60, minZ: -60, maxZ: 60 },
  fogNear: 18,
  fogFar: 120,
  groundLevel: 0,
  ambientZombieCap: 26,
  /** Zombies further than this from the player get cheaper updates. */
  distantUpdateDistance: 32,
};

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

export const NAV = {
  /** Grid cell size in metres; obstacle map must agree with collision geometry. */
  cellSize: 1,
  /** Zombies whose distance to their target exceeds this ask for a new path. */
  repathDistance: 2.5,
  /** Seconds between path requests for a single zombie. */
  repathInterval: 0.85,
  /** Hard cap on A* expansions per request, keeps worst-case cost bounded. */
  maxPathNodes: 2400,
  /** Stagger between zombies asking for a path in the same frame (seconds). */
  pathRequestStagger: 0.04,
  /** Steering: how strongly zombies push away from each other. */
  separationRadius: 1.1,
  separationStrength: 2.4,
} as const;

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

export const PLAYER = {
  radius: 0.42,
  height: 1.8,
  eyeHeight: 1.62,
  walkSpeed: 4.4,
  sprintSpeed: 7.2,
  /** Metres per second squared while accelerating. */
  acceleration: 42,
  groundDamping: 11,
  /**
   * Horizontal acceleration while airborne, m/s². Zero, and deliberately unused: the jump
   * adds vertical motion only, so the air and the ground run through the exact same
   * horizontal code. That is what keeps walk and run speed identical on the ground and in
   * the air (§14.2 requires the jump not to touch either), and it means a wall stops the
   * player in mid-flight for the same reason it stops them on the road.
   */
  airControl: 0,
  maxHealth: 100,
  spawn: { x: 0, y: 0, z: 14 },
  lookSensitivityDefault: 1,
  // -------------------------------------------------------------------------
  // Jump (§14.2)
  // -------------------------------------------------------------------------
  /**
   * Downward acceleration, m/s². Twenty is twice Earth's: a floaty arc reads as low gravity,
   * so the jump is short and lands quickly, which is what a horde shooter wants.
   */
  gravity: 20,
  /**
   * Upward speed at the moment of launch, m/s.
   *
   * With `gravity` above this peaks at `v² / (2g)` = 0.9 m — a little over half the player's
   * 1.8 m height, so the jump is visible without clearing anything it should not. Air time is
   * `2v / g` = 0.6 s. Both are asserted in `tests/jumping.test.ts`.
   */
  jumpSpeed: 6,
  /**
   * Above this upward speed the arc reads as still climbing; at or below it the character
   * holds its hang pose. A threshold rather than `speed > 0` so the apex is not a one-frame
   * flicker between two clips.
   */
  jumpApexSpeed: 0.6,
  /** Seconds the landing pose owns the body after touchdown, before the walk cycle returns. */
  landSeconds: 0.24,
  /** Regen is off by default: medkits are the intended recovery loop. */
  healthRegenPerSecond: 0,
  headBobAmplitude: 0.035,
  headBobFrequency: 8,
  /**
   * Seconds of invulnerability after being hit. This is both an anti-stacking
   * guard (two zombies landing on the same frame must not delete the player) and
   * the main difficulty dial for being surrounded: it caps incoming damage per
   * second regardless of how many zombies are in contact.
   */
  damageCooldown: 0.3,
  deathAnimationSeconds: 1.1,
};

// ---------------------------------------------------------------------------
// Weapons
// ---------------------------------------------------------------------------

export type WeaponId = 'pistol' | 'rifle' | 'smg' | 'shotgun' | 'mp5' | 'p90' | 'lmg';

/**
 * The slot categories the owner fixed in `implementation-plan/2026-10-15-melee-store-poin-v2.md`
 * §14.1. One number key is one category, and pressing the same key again rotates through the
 * weapons owned in it:
 *
 *   1 primary (rifle, shotgun, smg, mp5, p90, lmg) · 2 sidearm (pistol) ·
 *   3 melee · 4 ordnance (grenades)
 *
 * It is the shared vocabulary every weapon table keys on — the firearms here, the melee
 * table in `meleeConfig.ts` and the ordnance table in `grenadeConfig.ts` — so a weapon can
 * never be filed under a category the input layer does not know how to reach.
 */
export type WeaponSlot = 1 | 2 | 3 | 4;

export interface WeaponConfig {
  id: WeaponId;
  name: string;
  /**
   * Firearms are only ever a primary (1) or a sidearm (2): melee (3) and ordnance (4) have
   * their own tables, and a gun filed under either would be unreachable from its own key.
   */
  slot: 1 | 2;
  damage: number;
  /** Multiplier applied when the hit zone is `head`. Only used because separate
   *  hitboxes exist; there is no fake headshot bonus. */
  headshotMultiplier: number;
  /** Projectiles per trigger pull. Absent means one: a shotgun is the exception. */
  pellets?: number;
  /** Rounds per second. */
  fireRate: number;
  automatic: boolean;
  magazineSize: number;
  startingReserve: number;
  maxReserve: number;
  reloadSeconds: number;
  /** Hitscan range in metres. */
  range: number;
  /** Cone half-angle in radians applied to each shot. */
  spread: number;
  /** Vertical camera kick in radians per shot. */
  recoil: number;
  recoilRecovery: number;
  muzzleFlashSeconds: number;
  /**
   * Local placement of the first-person weapon. The model itself is normalised
   * to a fixed length by Game.normalizeViewModel(); `position` is in metres in
   * camera space and `rotation` in radians.
   */
  viewModel: {
    position: [number, number, number];
    rotation: [number, number, number];
    /**
     * Multiplier on the normalised view-model length, the same meaning it has for melee
     * (`MeleeViewPlacement.scale`).
     *
     * `normalizeViewModel` scales every weapon to one on-screen length by its longest axis,
     * which is right for aiming but erases how big a weapon is: a belt-fed gun and a sidearm
     * came out the same size on screen. This factor gives each weapon its real bulk back
     * without touching the normalisation, so the meshes stay one code path.
     *
     * The four original firearms stay at 1, which is the size they were tuned to on captured
     * frames — changing them would be a regression, not a fix. Values below are the extra
     * ones only, and they are relative to that reference.
     *
     * A big value is not a big weapon on screen. The multiplier acts along the model's
     * longest axis, and a view model hangs parallel to the view axis, so for a long thin gun
     * most of the extra length goes *into* the screen and is lost to foreshortening; the
     * hold depth (`position[2]`) then decides what is left. Values here are only sound
     * together with a hold depth that keeps the weapon's projected footprint honest — see
     * the LMG's entry, and `tests/view-model-framing.test.ts`, which measures the drawn
     * silhouette rather than the multiplier.
     */
    scale: number;
  };
  modelPath: string;
  /**
   * Draw a tracer every Nth round. Slow weapons show every one; a fast weapon showing
   * every round turns the screen into a solid bar and costs a quad per shot.
   */
  tracerEvery: number;
  /** Which first-person hand pose holds this weapon (see proceduralArms). */
  grip: 'pistol' | 'rifle' | 'shotgun';
}

export const WEAPONS: Record<WeaponId, WeaponConfig> = {
  pistol: {
    id: 'pistol',
    name: 'Sidearm',
    // Slot 2, the sidearm category: §14.1 gives the handgun a key of its own so it is never
    // in the same rotation as the long guns.
    slot: 2,
    damage: 26,
    headshotMultiplier: 2.5,
    fireRate: 5.5,
    automatic: false,
    magazineSize: 12,
    startingReserve: 60,
    maxReserve: 120,
    reloadSeconds: 1.45,
    range: 90,
    spread: 0.006,
    recoil: 0.019,
    recoilRecovery: 7,
    muzzleFlashSeconds: 0.05,
    viewModel: { position: [0.26, -0.24, -0.5], rotation: [0, Math.PI, 0], scale: 1 },
    modelPath: '/assets/weapons/Pistol.gltf',
    tracerEvery: 1,
    grip: 'pistol',
  },
  rifle: {
    id: 'rifle',
    name: 'Assault rifle',
    // Slot 1, the primary category: everything with a shoulder stock rotates on one key.
    slot: 1,
    damage: 18,
    headshotMultiplier: 2.1,
    fireRate: 9.5,
    automatic: true,
    magazineSize: 30,
    startingReserve: 120,
    maxReserve: 240,
    reloadSeconds: 2.1,
    range: 110,
    spread: 0.012,
    recoil: 0.012,
    recoilRecovery: 9,
    muzzleFlashSeconds: 0.045,
    viewModel: { position: [0.24, -0.22, -0.62], rotation: [0, Math.PI, 0], scale: 1 },
    modelPath: '/assets/weapons/Rifle.gltf',
    tracerEvery: 3,
    grip: 'rifle',
  },
  /**
   * The compact submachine gun.
   *
   * Its mesh is the pack's own, extracted from a survivor file into a standalone glTF
   * (see ASSET_CREDITS.md): the pack ships this weapon parented to a hand bone and a
   * standalone file is what the view model needs. Light per round, fast, and less
   * accurate than the rifle, so it fills the close-quarters role the pistol cannot.
   */
  smg: {
    id: 'smg',
    name: 'Compact SMG',
    // Slot 1, the primary category (§14.1): the close-quarters primary.
    slot: 1,
    damage: 15,
    headshotMultiplier: 2,
    fireRate: 13,
    automatic: true,
    magazineSize: 30,
    startingReserve: 180,
    maxReserve: 360,
    reloadSeconds: 1.75,
    range: 95,
    spread: 0.014,
    recoil: 0.009,
    recoilRecovery: 10,
    muzzleFlashSeconds: 0.04,
    viewModel: { position: [0.24, -0.22, -0.56], rotation: [0, Math.PI, 0], scale: 1 },
    modelPath: '/assets/weapons/SMG.gltf',
    // Every second round: at thirteen a second, one per shot is a solid bar on screen.
    tracerEvery: 2,
    grip: 'rifle',
  },
  /**
   * The pump shotgun.
   *
   * Eight pellets, twelve damage each: ninety-six at contact, so it is the only weapon that
   * kills a walker outright with one shell, and it falls off hard with distance because the
   * cone opens. Slow to cycle and slow to load, which is what keeps that honest.
   */
  shotgun: {
    id: 'shotgun',
    name: 'Pump Shotgun',
    // Slot 1, the primary category: the shotgun is nobody's sidearm.
    slot: 1,
    damage: 12,
    headshotMultiplier: 1.5,
    fireRate: 1.15,
    automatic: false,
    pellets: 8,
    // A wide cone is the whole point of the weapon: at ten metres the pattern covers a
    // doorway, not a dot.
    spread: 0.062,
    magazineSize: 6,
    startingReserve: 48,
    maxReserve: 96,
    reloadSeconds: 2.6,
    range: 40,
    recoil: 0.028,
    recoilRecovery: 6.5,
    muzzleFlashSeconds: 0.075,
    viewModel: { position: [0.27, -0.24, -0.58], rotation: [0, Math.PI, 0], scale: 1 },
    modelPath: '/assets/weapons/Shotgun.gltf',
    tracerEvery: 1,
    grip: 'shotgun',
  },
  /**
   * The three weapons below are the roster from the work order in
   * `implementation-plan/2026-10-15-melee-store-poin-v2.md` §13 (Jalur B). Their damage,
   * magazine, `tracerEvery` and reload come from that section verbatim; the fields it does
   * not fix (fire rate, spread, recoil, reserve, range) follow the weapon each one sits
   * beside, so a heavier weapon is never somehow cheaper to hold than the light one.
   *
   * Their meshes are built in code (`src/player/proceduralWeapons.ts`) and exported to
   * glTF by `tools/export-weapon-models.mjs`; see ASSET_CREDITS.md.
   *
   * Their `viewModel.scale` is the one value the four original firearms could not supply,
   * because they all sit at 1: normalising every mesh to one on-screen length made the
   * belt-fed gun the same size as the sidearm. The numbers follow each weapon's real bulk
   * relative to that reference — the P90 is a bullpup and reads shorter (0.92), the MP5 is
   * a slightly longer, heavier submachine gun (1.12), and the LMG is about twice the
   * bullpup's length (1.9), which is what makes a 150-round belt look like the heaviest
   * thing on the shelf. See `WeaponConfig.viewModel.scale`, and the LMG's own entry for why
   * the scale alone is not enough to make a long gun read big on screen.
   */
  mp5: {
    id: 'mp5',
    name: 'MP5',
    slot: 1,
    damage: 16,
    headshotMultiplier: 2,
    // Slower than the pack's compact SMG, which is the trade for the extra damage: a
    // heavier bolt, not a faster one.
    fireRate: 11,
    automatic: true,
    magazineSize: 30,
    startingReserve: 180,
    maxReserve: 360,
    reloadSeconds: 1.9,
    range: 95,
    spread: 0.012,
    // "recoil rendah" in the work order: the tightest of the automatics, which is what
    // makes a thirty-round burst stay on a target.
    recoil: 0.008,
    recoilRecovery: 10,
    muzzleFlashSeconds: 0.04,
    viewModel: { position: [0.25, -0.23, -0.58], rotation: [0, Math.PI, 0], scale: 1.12 },
    modelPath: '/assets/weapons/MP5.gltf',
    tracerEvery: 2,
    grip: 'rifle',
  },
  p90: {
    id: 'p90',
    name: 'P90',
    slot: 1,
    damage: 18,
    headshotMultiplier: 2,
    fireRate: 13.5,
    automatic: true,
    // Forty rounds in one magazine: the largest of the hand-held weapons, and the reason
    // the reload is the second longest.
    magazineSize: 40,
    startingReserve: 200,
    maxReserve: 400,
    reloadSeconds: 2.3,
    range: 100,
    // A bullpup is short and points quickly but is less steady at distance than a rifle.
    spread: 0.016,
    recoil: 0.01,
    recoilRecovery: 9,
    muzzleFlashSeconds: 0.04,
    viewModel: { position: [0.24, -0.2, -0.52], rotation: [0, Math.PI, 0], scale: 0.92 },
    modelPath: '/assets/weapons/P90.gltf',
    tracerEvery: 2,
    grip: 'rifle',
  },
  lmg: {
    id: 'lmg',
    name: 'Belt-Fed LMG',
    slot: 1,
    damage: 22,
    headshotMultiplier: 2,
    fireRate: 12,
    automatic: true,
    // The owner's "100-200 rounds" request, read as the belt: 150, the middle of the range.
    magazineSize: 150,
    startingReserve: 150,
    maxReserve: 300,
    // 4.5 s, from the work order: without a reload this long, 150 rounds at 22 damage would
    // simply be the best weapon in the game rather than a heavy one.
    reloadSeconds: 4.5,
    range: 120,
    spread: 0.022,
    recoil: 0.02,
    // Heavier kick than anything else, and it settles slower: the weapon fights the aim.
    recoilRecovery: 7,
    muzzleFlashSeconds: 0.06,
    // /!\ This pair is load-bearing, and it was wrong.
    //
    // `scale` multiplies the model's *normalised longest axis*, and a view model hangs
    // parallel to the view axis (`rotation [0, PI, 0]`), so for the LMG — whose longest
    // axis is its barrel — the multiplier mostly grows the gun *into* the screen, where
    // foreshortening eats it. On top of that the holder sat at z = -0.66, the deepest of
    // the roster (the P90 sits at -0.52), which shrinks the projected size again. At
    // scale 1.6 / -0.66 the LMG was physically the longest firearm in the game (0.417 m
    // against the P90's 0.240 m) and still covered *less* screen than the P90 — 1410 px
    // against 2220 px of the 900x363 harness frame. That is how "the heaviest thing on the
    // shelf" came to be reported as "the LMG model is not rendered": it was drawn, but
    // smaller than the weapon it is supposed to dwarf, and dark.
    //
    // 1.9 at -0.58 puts the drawn gun at 0.495 m and 2905 px of that same frame — 1.31x the
    // P90 — with every vertex still on screen and clear of the near plane, and with the
    // fixed muzzle-flash offset (0.36 m ahead of the holder) still past the barrel tip
    // (0.909 m) instead of inside the barrel. Longer would put the flash inside the muzzle;
    // closer would drop the stock and the ammo box off the bottom of the frame.
    viewModel: { position: [0.26, -0.24, -0.58], rotation: [0, Math.PI, 0], scale: 1.9 },
    modelPath: '/assets/weapons/LMG.gltf',
    // Every round, unlike every other automatic: a belt-fed gun reads as a stream, and at
    // 150 rounds a magazine the quad cost is part of what makes it feel heavy.
    tracerEvery: 1,
    grip: 'rifle',
  },
};

export const STARTING_WEAPON: WeaponId = 'pistol';
/** Weapons the player owns from the first wave: the sidearm. Primaries arrive as pickups or from the store. */
export const STARTING_LOADOUT: WeaponId[] = ['pistol'];

/**
 * The melee table lives in its own module (`meleeConfig.ts`) because it shares almost
 * nothing with the firearms, and is re-exported here so callers still have one import for
 * weapon data. Ordnance (`grenadeConfig.ts`) is the same arrangement for the grenades.
 */
export * from './meleeConfig';
export * from './grenadeConfig';
export const RIFLE_UNLOCK_WAVE = 2;
/** The SMG arrives later than the rifle: it is the better close-quarters weapon. */
export const SMG_UNLOCK_WAVE = 4;
/** The shotgun last of the three: it is the strongest thing you can pick up. */
export const SHOTGUN_UNLOCK_WAVE = 6;

// ---------------------------------------------------------------------------
// Zombies
// ---------------------------------------------------------------------------

export type ZombieKind = 'walker' | 'runner' | 'tank';

export interface ZombieStats {
  kind: ZombieKind;
  displayName: string;
  maxHealth: number;
  /** Metres per second. */
  walkSpeed: number;
  chaseSpeed: number;
  attackDamage: number;
  /** Centre-to-centre distance at which an attack can land. */
  attackRange: number;
  /** Seconds between the start of one attack and the next. */
  attackCooldown: number;
  /** Seconds into the attack animation when damage is applied. */
  attackImpactDelay: number;
  /** Collision/steering radius in metres. */
  radius: number;
  /** Scaled model height in metres, used for the hitbox layout. */
  height: number;
  /** How tall the head hitbox is, in metres. */
  headHeight: number;
  /** Degrees per second the body can turn. */
  turnSpeed: number;
  /** Point value for the score/kill counter. */
  score: number;
  /** Relative spawn weight, adjusted per wave. */
  spawnWeight: number;
  /** Seconds the death animation plays before the entity is despawned. */
  deathSeconds: number;
  /** Model used for this kind. */
  modelPath: string;
  /** Optional material tint so two variants using one model stay readable. */
  tint: number | null;
  /** Extra scale applied on top of the normalisation to the configured height. */
  scaleMultiplier: number;
  /** Animation playback multiplier. */
  animationSpeed: number;
}

const ZOMBIES_ROOT = '/assets/characters/zombies/';

export const ZOMBIE_TYPES: Record<ZombieKind, ZombieStats> = {
  walker: {
    kind: 'walker',
    displayName: 'Walker',
    maxHealth: 100,
    walkSpeed: 1.05,
    chaseSpeed: 1.9,
    attackDamage: 12,
    attackRange: 1.75,
    attackCooldown: 1.5,
    attackImpactDelay: 0.45,
    radius: 0.42,
    height: 1.8,
    headHeight: 0.3,
    turnSpeed: 240,
    score: 1,
    spawnWeight: 1,
    deathSeconds: 1.6,
    modelPath: `${ZOMBIES_ROOT}Zombie_Basic.gltf`,
    tint: null,
    scaleMultiplier: 1,
    animationSpeed: 1,
  },
  runner: {
    kind: 'runner',
    displayName: 'Runner',
    maxHealth: 60,
    walkSpeed: 1.4,
    chaseSpeed: 3.9,
    attackDamage: 8,
    attackRange: 1.6,
    attackCooldown: 1.1,
    attackImpactDelay: 0.32,
    radius: 0.36,
    height: 1.68,
    headHeight: 0.28,
    turnSpeed: 420,
    score: 2,
    spawnWeight: 0.35,
    deathSeconds: 1.3,
    // Shares the Walker's rig on purpose. The other candidate in this pack
    // (Zombie_Ribcage) is a fragmentary mesh missing head, forearms and fingers,
    // so no clip from the shared rig can drive it: measured binding was 25.5% of
    // tracks. Using it left the Runner swinging its walk cycle when attacking,
    // which reads as broken in melee. Tint + scale + a 2x speed difference keep
    // the two variants distinguishable in motion.
    modelPath: `${ZOMBIES_ROOT}Zombie_Basic.gltf`,
    tint: 0x9fd3a0,
    scaleMultiplier: 0.9,
    animationSpeed: 1.35,
  },
  tank: {
    kind: 'tank',
    displayName: 'Brute',
    maxHealth: 420,
    walkSpeed: 0.95,
    chaseSpeed: 1.55,
    attackDamage: 34,
    attackRange: 2.15,
    attackCooldown: 2.4,
    attackImpactDelay: 0.7,
    radius: 0.62,
    height: 2.12,
    headHeight: 0.32,
    turnSpeed: 170,
    score: 5,
    spawnWeight: 0.18,
    deathSeconds: 2.2,
    modelPath: `${ZOMBIES_ROOT}Zombie_Chubby.gltf`,
    tint: 0xc9a06a,
    scaleMultiplier: 1.08,
    animationSpeed: 0.85,
  },
};

/**
 * Yaw offset applied to a character model so its own front matches the entity's
 * logical forward (sin(yaw), cos(yaw)).
 *
 * 0 means the exported model already faces +Z in its local space. This value is
 * NOT a guess: it is confirmed by looking at a rendered frame of a zombie
 * walking toward a fixed camera (tools/smoke.mjs writes that frame). If a model
 * ever faces the other way, this is the single value to change.
 */
export const MODEL_FORWARD_YAW_OFFSET = 0;

/**
 * How a shot feels, kept in one place so it can be tuned without touching logic.
 *
 * A hit that only removes hit points reads as a spreadsheet; the kick, the flash
 * and the ejected casing are what make it read as a gun.
 */
export const WEAPON_FEEL = {
  /** How far the weapon is pushed back towards the shoulder on a shot, metres. */
  kickBack: 0.052,
  /** Upward displacement on a shot, metres. */
  kickUp: 0.02,
  /** Muzzle rise on a shot, radians. */
  kickPitch: 0.115,
  /** Slight sideways twist on a shot, radians. */
  kickRoll: 0.04,
  /** How quickly the weapon settles back, per second. */
  kickRecover: 14,
  /** Peak muzzle light intensity on a shot, candela. */
  flashIntensity: 26,
  /** How long the muzzle light lasts, seconds. */
  flashSeconds: 0.055,
  /** Flash quad pool size. Two quads are drawn per shot, so this is four shots' worth. */
  flashQuads: 8,
  /** Tracer life and width. A slow fade reads as a tracer; a long one reads as a laser. */
  tracerSeconds: 0.07,
  tracerWidth: 0.026,
  /**
   * Muzzle position in view-model space, metres. The old flash sphere was drawn here,
   * so this is the offset that was tuned against captured frames, kept as data.
   */
  muzzleOffset: [0, 0.03, -0.36] as [number, number, number],
  /** Ejection port in view-model space: where brass leaves, not where the round exits. */
  ejectionPortOffset: [0.05, 0.02, -0.12] as [number, number, number],
  /** Ejected casing life and pool size. */
  casingSeconds: 1.8,
  casingPool: 12,
} as const;

/**
 * Aiming down the sights (F3).
 *
 * A separate table rather than more fields on each weapon: aiming is one piece of
 * handling shared by every firearm, and a per-weapon copy of it would be six chances to
 * drift apart. The two numbers that *are* per weapon stay where they belong — the aim
 * cone comes from `WeaponConfig.spread` and the kick from `WeaponConfig.recoil` — so this
 * only ever scales them.
 */
export const ADS = {
  /**
   * Vertical field of view, degrees, with the sights up.
   *
   * The game's hip FOV is 76; 58 is a light pull-in that reads as aiming without turning
   * the fight into a scope. Anything much tighter hides the horde, which is the whole
   * threat in this game.
   */
  fovDegrees: 58,
  /** Seconds for the sights to come up, and the same again to drop back. */
  seconds: 0.15,
  /** The aim cone is multiplied by this while the sights are up. */
  spreadMultiplier: 0.4,
  /**
   * Where the view model is held while aiming, in camera space: x dead centre, y up
   * towards the crosshair line. The hip hold is right and low (a pistol sits at
   * [0.26, -0.24]), so this is what moves the weapon into the middle of the screen.
   *
   * There is no depth here on purpose. Pulling the weapon in would move the muzzle the
   * flash and the tracer leave from, and this feature is not allowed to touch that; the
   * hold depth is left exactly as the weapon configures it.
   */
  viewModelPosition: [0, -0.06] as [number, number],
} as const;

/**
 * Third-person camera. Distances are metres and were tuned against captured
 * frames: closer than ~2.6 m the character fills the lower half of the screen,
 * further than ~4 m the crosshair sits so far off the muzzle that shots read as
 * coming from nowhere.
 */
export const THIRD_PERSON = {
  distance: 3.4,
  minDistance: 1.1,
  /**
   * High enough that the character sits in the lower third of the frame instead of
   * under the crosshair, low enough that it does not read as a top-down camera.
   */
  heightOffset: 1.02,
  floorClearance: 0.45,
} as const;

/** Folder holding the playable survivor models (see src/app/characters.ts). */
export const SURVIVOR_ASSET_ROOT = '/assets/characters/survivors/';

/**
 * Title-screen survivor showcase.
 *
 * The camera orbits a small arc in front of the character, and the look target is
 * pushed sideways so the model sits clear of the centred menu panel instead of
 * behind it.
 */
export const SHOWCASE = {
  /** Metres in front of the spawn point where the character stands. */
  standAhead: 3.8,
  /**
   * Boom length. At 2.7 m with the game's 76 degree field of view the character
   * fills roughly half the frame height, which is close enough to read its
   * clothing and face without the perspective distorting the body.
   */
  distance: 2.7,
  /** Camera height relative to 58% of the character's height. */
  heightOffset: 0.12,
  /**
   * Where the subject sits across the frame, 0 (left edge) to 1 (right edge). The
   * menu panel owns the left ~45% of the title screen, so the character is framed
   * at 0.72 to stand clear of it. Converted to a camera yaw offset from the field of
   * view, so it holds at any aspect ratio.
   */
  frameFraction: 0.72,
  /** Fraction of the character's height the camera looks at. */
  aimHeight: 0.52,
  /** Slow enough to read as a hold, not a turntable. */
  orbitSpeed: 0.09,
  /** Half-width of the orbit arc, radians. */
  orbitArc: 0.34,
} as const;

/** Candidate clip names, matched case-insensitively; missing clips fall back. */
export const ANIMATION_CLIP_NAMES = {
  idle: ['idle', 'idle1', 'breathing'],
  walk: ['walk', 'walking', 'walkforward'],
  run: ['run', 'running', 'jog'],
  attack: ['attack', 'punch', 'bite', 'swipe', 'claw', 'slash', 'scratch', 'attack1'],
  hit: ['hit', 'hit1', 'reaction', 'flinch', 'hitreact'],
  death: ['death', 'die', 'dying', 'death1'],
} as const;

export type AnimationState = keyof typeof ANIMATION_CLIP_NAMES;

/**
 * Locomotion playback tuning.
 *
 * The character clips are authored in place, so the visible walking speed is
 * decided entirely by how fast the AI moves the entity. Playing the cycle at a
 * fixed rate while the entity moves at a different speed is what makes feet
 * slide — the single most obvious tell of cheap character animation. These
 * reference speeds are the ground speeds each clip was authored to look right
 * at; `ZombieAnimator` scales the playback rate by speed / reference.
 */
export const ANIMATION = {
  /**
   * Ground speed at which the walk cycle looks natural, metres per second.
   * Chosen to match the Walker's own walk speed, so wandering plays at ~1.0x.
   */
  walkReferenceSpeed: 1.1,
  /**
   * Ground speed at which the run cycle looks natural. Sits between the Walker's
   * 1.9 m/s chase and the Runner's 3.9 m/s sprint: the Walker then jogs at ~0.8x
   * (right for a shambler) while the Runner sprints at ~1.6x.
   */
  runReferenceSpeed: 2.4,
  /** Below this speed the entity is treated as standing (no locomotion clip). */
  movingThreshold: 0.18,
  /**
   * Clamp on the speed match. The floor must stay below the slowest real case
   * (a Walker chasing at 1.9 m/s needs 0.79x) or the clamp silently reintroduces
   * the foot sliding it exists to remove.
   */
  minTimeScale: 0.45,
  maxTimeScale: 1.9,
  /** Crossfade times in seconds. */
  fadeLocomotion: 0.25,
  fadeOneShot: 0.08,
  fadeDeath: 0.12,
};

export const ZOMBIE_AI = {
  /** Distance at which a zombie notices the player. */
  sightRange: 48,
  /** Distance at which a chase reverts to wandering if line of sight is lost. */
  loseTargetRange: 60,
  maxTargetRange: 90,
  wanderRadius: 6,
  wanderPauseMin: 1.2,
  wanderPauseMax: 3.5,
  /** Seconds the HIT reaction plays before returning to the previous state. */
  hitReactionSeconds: 0.42,
  /** Corpse removal distance; far corpses are despawned immediately. */
  despawnDistance: 120,
} as const;

// ---------------------------------------------------------------------------
// Waves
// ---------------------------------------------------------------------------

export interface WaveComposition {
  walker: number;
  runner: number;
  tank: number;
}

export const WAVES = {
  firstWaveDelay: 6,
  /** Seconds of breathing room between waves. */
  breakSeconds: 8,
  baseCount: 8,
  /** Additional zombies per wave. */
  countPerWave: 3,
  maxCountPerWave: 46,
  maxActive: 16,
  /** Active cap grows by this much per wave, up to WORLD.ambientZombieCap. */
  maxActiveGrowth: 1,
  /** Seconds between individual spawns inside a wave. */
  spawnIntervalMin: 1.1,
  spawnIntervalMax: 2.4,
  /** Spawns closer than this to the player are rejected. */
  minSpawnDistance: 18,
  /** Spawns inside the player's view cone closer than this are rejected too. */
  minSpawnDistanceInView: 30,
  /** Width of the player's "in view" rejection cone, radians. */
  viewConeHalfAngle: 0.9,
  /** Wave is considered cleared when no zombie has been alive for this long. */
  clearSettleSeconds: 2.5,
  /**
   * How long a wave may sit in its clearing phase before the zombies still out of the
   * fight are moved back into it, seconds.
   *
   * A wave with living zombies that nobody can reach is a hard stall: the HUD counts them,
   * the player cannot find them, and the run never continues. Recalling them is a cheat in
   * the player's favour, which beats a run that cannot be finished.
   */
  stragglerRecallSeconds: 25,
  /** Recalls per wave, so a broken map cannot loop forever. */
  maxStragglerRecalls: 4,
  /** Only zombies further than this from the player are recalled, metres. */
  recallOnlyBeyond: 14,
  /** Ring around the player that a recalled zombie is placed in, metres. */
  recallMinDistance: 11,
  recallMaxDistance: 24,
  /** Standing wave composition before per-wave scaling. */
  composition: { walker: 0.72, runner: 0.2, tank: 0.08 } as const,
  runnerUnlockWave: 2,
  tankUnlockWave: 3,
} as const;

export function waveComposition(wave: number, total: number): WaveComposition {
  const runnerShare = wave < WAVES.runnerUnlockWave ? 0 : Math.min(0.2 + (wave - 2) * 0.03, 0.36);
  const tankShare = wave < WAVES.tankUnlockWave ? 0 : Math.min(0.06 + (wave - 3) * 0.02, 0.22);
  const runners = Math.round(total * runnerShare);
  const tanks = Math.round(total * tankShare);
  return {
    walker: Math.max(0, total - runners - tanks),
    runner: runners,
    tank: tanks,
  };
}

export function waveTotalCount(wave: number): number {
  return Math.min(WAVES.baseCount + (wave - 1) * WAVES.countPerWave, WAVES.maxCountPerWave);
}

export function waveActiveCap(wave: number): number {
  return Math.min(WAVES.maxActive + (wave - 1) * WAVES.maxActiveGrowth, WORLD.ambientZombieCap);
}

// ---------------------------------------------------------------------------
// Mission objectives
// ---------------------------------------------------------------------------

/**
 * Directional objectives: the player is sent to one marked point per wave, and the run is
 * won after all of them are reached.
 *
 * The objectives ride on top of the wave cycle rather than replacing it — waves keep
 * spawning and clearing as they always did, and the marked points are an extra thing the
 * player has to do while the horde is coming. That is why none of the wave tuning below is
 * touched by this feature.
 */
export const MISSION = {
  /** Marked points to reach before the mission is complete — one per wave of the run. */
  objectiveCount: 8,
  /** Reaching within this of the marked point completes that objective, metres. */
  reachRadius: 1.5,
  /** A new point is placed this far from the player, so reaching it is a real journey. */
  minDistance: 12,
  maxDistance: 45,
  /**
   * Never placed within this of the player, so the objective is never already underfoot.
   * Deliberately larger than `reachRadius`: the rule being enforced is "not already
   * complete", not merely "not touching".
   */
  clearRadius: 4,
  /** Random samples tried before the deterministic whole-region fallback runs. */
  attempts: 32,
  /** Height of the marker's light beam above the ground, metres. */
  beamHeight: 7,
} as const;

// ---------------------------------------------------------------------------
// Pickups
// ---------------------------------------------------------------------------

export const PICKUPS = {
  /** Fraction of waves that drop a medkit per kill. */
  medkitChance: 0.06,
  ammoChance: 0.2,
  /** Grenades are rarer than ammunition: they are the crowd answer the store also sells. */
  grenadeChance: 0.05,
  grenadeAmount: 1,
  medkitHeal: 35,
  ammoAmount: 24,
  pickupRadius: 1.2,
  lifetimeSeconds: 60,
  maxActive: 12,
} as const;

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

export const AUDIO = {
  masterVolumeDefault: 0.7,
  /** Web Audio synthesised effects; no external audio files are shipped. */
  maxVoices: 24,
};

// ---------------------------------------------------------------------------
// Quality presets
// ---------------------------------------------------------------------------

export type QualityTier = 'low' | 'medium' | 'high';

export interface QualityPreset {
  tier: QualityTier;
  pixelRatioCap: number;
  shadows: boolean;
  shadowMapSize: number;
  /** Max active zombies; the wave director clamps to this. */
  zombieCap: number;
  propDensity: number;
  fogFar: number;
  /** Antialiasing is fixed at renderer creation: changing tier needs a reload. */
  antialias: boolean;
  particleBudget: number;
  /**
   * Animate the slide/bolt/pump on the first-person weapon (F2).
   *
   * On at every tier today, and that is a measured decision rather than an oversight: the
   * mechanism is one extra mesh on the weapon already being drawn and one matrix write a
   * frame, so it is cheaper than the muzzle flash quads and the ejected casings, both of
   * which are deliberately never gated (the flash is the feedback that says a shot
   * happened, and a gun that ejects no brass is the clearest "this is fake" cue there is).
   * The field exists so that a machine where it does cost something — it is a per-frame
   * transform on a part that is always on screen — can turn it off by flipping one word in
   * this table, without hunting through the weapon code for a switch that does not exist.
   */
  weaponMechanisms: boolean;
}

export const QUALITY_PRESETS: Record<QualityTier, QualityPreset> = {
  low: {
    tier: 'low', pixelRatioCap: 1, shadows: false, shadowMapSize: 512,
    zombieCap: 12, propDensity: 0.45, fogFar: 80, antialias: false, particleBudget: 0,
    // The mechanism is part of what a shot *is*, not a decoration like a particle, so it
    // stays on even here — see QualityPreset.weaponMechanisms for the reasoning and for the
    // one word that turns it off.
    weaponMechanisms: true,
  },
  medium: {
    tier: 'medium', pixelRatioCap: 1.25, shadows: true, shadowMapSize: 1024,
    zombieCap: 20, propDensity: 0.75, fogFar: 110, antialias: true, particleBudget: 24,
    weaponMechanisms: true,
  },
  high: {
    tier: 'high', pixelRatioCap: 2, shadows: true, shadowMapSize: 2048,
    zombieCap: 28, propDensity: 1, fogFar: 140, antialias: true, particleBudget: 48,
    weaponMechanisms: true,
  },
};

export const DEFAULT_QUALITY: QualityTier = 'medium';

// ---------------------------------------------------------------------------
// Crosshair / feedback
// ---------------------------------------------------------------------------

export const FEEDBACK = {
  hitmarkerSeconds: 0.12,
  damageVignetteSeconds: 0.45,
  toastSeconds: 2.4,
  /** Camera shake magnitude per damage point; scaled by the accessibility switch. */
  shakePerDamage: 0.006,
} as const;

// ---------------------------------------------------------------------------
// Impact effects per material (F5 in 2026-10-15-realisme-efek-menembak.md)
// ---------------------------------------------------------------------------

/**
 * What a bullet hit is made of, as far as the spark is concerned.
 *
 * The collision world already labels every box it hands back from a raycast
 * (`CollisionWorld.RaycastHit.tag`), and that label already reaches the game on
 * `combat:world-hit`. So this is *not* a second material system: concrete, metal,
 * wood and glass are read straight off the existing tag, and anything the tag does
 * not name — plastic crates, rubber, a grenade's own detonation point — falls back
 * to `default`. The fallback is a first-class profile, not an absence: an unknown
 * surface must still throw dust, because a hit that renders nothing reads as a
 * broken gun.
 */
export type MaterialKind = 'metal' | 'concrete' | 'wood' | 'glass' | 'default';

export interface MaterialImpactProfile {
  kind: MaterialKind;
  /** Spark colour. Additive if `glowing`, plain if not. */
  color: number;
  /** How many spark quads one hit throws. */
  particles: number;
  /** Width of a single spark quad at spawn, metres. */
  size: number;
  /** How far sparks scatter off the hit point, metres. */
  spread: number;
  /** Spark lifetime, seconds. Dust hangs; hot sparks go out quickly. */
  seconds: number;
  /**
   * True for a hot, glowing spark (metal, glass) and false for dull debris
   * (concrete dust, wooden splinters). This is the one field that changes the
   * blend mode, and it is what stops every impact looking like a lit sticker in
   * the dark scene — the complaint the whole plan started from.
   */
  glowing: boolean;
}

/**
 * One row per material. The four materials are measurably different on purpose:
 * particle count, size, colour and blend mode all differ, so a `low`-preset hit on
 * a car, a wall, a crate and a window never look the same. `tests/material-impacts.test.ts`
 * asserts the differences rather than the table.
 */
export const MATERIAL_IMPACTS: Record<MaterialKind, MaterialImpactProfile> = {
  // Cars, containers, barrels, lamp posts: a handful of small, fast, bright sparks.
  metal: { kind: 'metal', color: 0xffd9a0, particles: 6, size: 0.05, spread: 1.0, seconds: 0.22, glowing: true },
  // Buildings, the perimeter, cinder block: fewer but larger, dull, slower puffs of dust.
  concrete: { kind: 'concrete', color: 0xb9b2a6, particles: 4, size: 0.14, spread: 0.55, seconds: 0.34, glowing: false },
  // Pallets, chests, couches: mid-sized brown splinters.
  wood: { kind: 'wood', color: 0x9c7b4e, particles: 5, size: 0.09, spread: 0.75, seconds: 0.3, glowing: false },
  // Windows and windshields: the most pieces, each the smallest and the widest scatter.
  glass: { kind: 'glass', color: 0xcfeeff, particles: 8, size: 0.045, spread: 1.35, seconds: 0.24, glowing: true },
  // Plastic, rubber, an unknown prop, the grenade point: neutral grey dust.
  default: { kind: 'default', color: 0xc9c2b4, particles: 3, size: 0.11, spread: 0.5, seconds: 0.26, glowing: false },
};

/**
 * Substrings that name a material inside an existing collision tag.
 *
 * Keyed on the tag vocabulary `CityLevel` actually writes (`prop:<name>`,
 * `building`, `perimeter`, `grenade`), matched case-insensitively as substrings so
 * `prop:containerRed`, `prop:streetLights` and `prop:townSign` all resolve without a
 * per-prop table that would drift the moment a prop is added. Order of evaluation is
 * `MATERIAL_PRIORITY`; no keyword list overlaps another today.
 */
export const MATERIAL_TAG_KEYWORDS: Record<Exclude<MaterialKind, 'default'>, readonly string[]> = {
  metal: [
    'container', 'barrel', 'hydrant', 'vehicle', 'pickup', 'truck', 'sports', 'car',
    'wheels', 'pipe', 'light', 'sign', 'tower', 'dumpster', 'grate', 'railing',
    'trafficbarrier', 'machine', 'metal', 'steel',
  ],
  concrete: ['building', 'perimeter', 'cinder', 'concrete', 'brick', 'wall', 'slab', 'rubble', 'stone'],
  wood: ['couch', 'chest', 'pallet', 'wood', 'timber', 'plank', 'crate', 'door', 'bench', 'fence', 'tree'],
  glass: ['glass', 'window', 'windshield', 'pane'],
};

/** Which keyword list wins when a tag could match more than one. */
export const MATERIAL_PRIORITY = ['metal', 'concrete', 'wood', 'glass'] as const;

/**
 * Resolves a collision tag to a material.
 *
 * Deliberately total: any string at all maps to one of the five kinds, and anything
 * unrecognised maps to `default`. That is what makes an unknown tag safe to shoot —
 * it can never crash and it can never silently draw nothing.
 */
export function materialForTag(tag: string): MaterialKind {
  const needle = tag.toLowerCase();
  for (const material of MATERIAL_PRIORITY) {
    for (const keyword of MATERIAL_TAG_KEYWORDS[material]) {
      if (needle.includes(keyword)) return material;
    }
  }
  return 'default';
}
