import { Camera, Vector3 } from 'three';
import { PLAYER, THIRD_PERSON } from '../app/gameConfig';
import { CollisionWorld } from '../level/CollisionWorld';
import { placeViewCamera, type ViewMode } from './viewCamera';
import type { InputSnapshot } from '../input/InputManager';
import { clamp, damp } from '../utils/math';
import { stepVertical, type JumpPhase } from './jumpPhysics';

export interface PlayerControllerDeps {
  camera: Camera;
  collision: CollisionWorld;
}

/**
 * How fast the two recoil offsets bleed back to zero, per second.
 *
 * One rate for both axes: a kick that came back on a different schedule sideways than
 * vertically would leave the crosshair tracing a curve on its way home, and the shot's
 * feel is supposed to be a shove that settles, not a swirl.
 */
const RECOIL_RECOVERY = 7;

/**
 * First-person movement and camera orientation.
 *
 * The player is a kinematic circle: intent is turned into a velocity, the
 * velocity is integrated with delta time, and the collision world pushes the
 * circle out of geometry. Horizontal control is the same on the ground and in the
 * air, so walk and run speed are untouched by the jump and a wall stops a jump
 * exactly as it stops a walk — the collision world resolves in XZ only, at every
 * height.
 *
 * Vertical motion (§14.2) is a gravity arc over a flat ground plane: Space gives an
 * upward launch speed while grounded, gravity pulls the player back down, and the arc
 * lands on `GROUND_HEIGHT` and stops there. There is no double jump: a launch is only
 * accepted while grounded, so one press is one jump.
 */
export class PlayerController {
  readonly position = new Vector3(PLAYER.spawn.x, 0, PLAYER.spawn.z);
  readonly velocity = new Vector3();
  yaw = Math.PI;
  pitch = 0;
  /** Third person by default: the player's own character is meant to be visible. */
  viewMode: ViewMode = 'third';
  sensitivity = PLAYER.lookSensitivityDefault;
  /** Recoil pitch added on top of the mouse pitch, decays every frame. */
  private recoilPitch = 0;
  /**
   * Recoil yaw added on top of the mouse yaw, decays every frame.
   *
   * Both recoil offsets are *added* to the aim where the camera is placed rather than
   * written into `yaw` / `pitch`, which is what makes the recovery honest: when the
   * offsets have bled back to zero the camera is pointing exactly where the mouse left it,
   * with no residual drift for the player to fight. Writing into `yaw` and relying on a
   * negative kick to cancel it would leave every burst a few milliradians off.
   */
  private recoilYaw = 0;

  /** Current recoil offset in radians (read-only, for diagnostics). */
  get currentRecoilPitch(): number {
    return this.recoilPitch;
  }

  /** Current sideways recoil offset in radians (read-only, for diagnostics). */
  get currentRecoilYaw(): number {
    return this.recoilYaw;
  }
  private bobTime = 0;
  private enabled = true;
  /** True while the player's feet are on the ground plane. */
  private onGround = true;
  /** Seconds left of the landing pose after touchdown. */
  private landTimer = 0;
  /**
   * Jump and landing events, latched on the frame they happen and read once by the game.
   *
   * The controller knows nothing about audio, so it reports the transition instead of
   * playing it: the game turns these into the `player:jumped` / `player:landed` events.
   */
  private jumpEventPending = false;
  private landEventPending = false;
  private readonly camera: Camera;
  private readonly collision: CollisionWorld;
  /** Per-survivor movement speeds; defaults come from PLAYER. */
  private walkSpeed = PLAYER.walkSpeed;
  private sprintSpeed = PLAYER.sprintSpeed;
  /** Reused so the per-frame camera work allocates nothing. */
  private readonly scratchOrigin = new Vector3();
  private readonly scratchDirection = new Vector3();

  constructor(deps: PlayerControllerDeps) {
    this.camera = deps.camera;
    this.collision = deps.collision;
    this.syncCamera(0);
  }

  /** Current walk speed, for diagnostics and the character-stat assertions. */
  get walkSpeedValue(): number {
    return this.walkSpeed;
  }

  get sprintSpeedValue(): number {
    return this.sprintSpeed;
  }

  /** True while the feet are on the ground plane. */
  get grounded(): boolean {
    return this.onGround;
  }

  /** Height of the feet above the ground plane, metres. */
  get height(): number {
    return this.position.y;
  }

  /**
   * Which air pose the character should hold, or null when it is on its feet.
   *
   * `hang` covers the peak and the whole descent: the rig ships one airborne pose
   * (`Jump_Idle`) and no separate falling clip, so the same pose that reads as hanging at
   * the top also reads as the float on the way down (see `JumpPhase`). `land` is reported
   * for a moment after touchdown so the landing clip gets to play before the walk cycle
   * returns.
   */
  get jumpPhase(): JumpPhase | null {
    if (!this.onGround) return this.velocity.y > PLAYER.jumpApexSpeed ? 'rise' : 'hang';
    return this.landTimer > 0 ? 'land' : null;
  }

  /**
   * Jump and landing transitions since this was last called, then cleared.
   *
   * Called once per frame by the game, which turns them into the sound events. Kept as a
   * consumed report rather than direct calls so audio stays out of the controller.
   */
  consumeMotionEvents(): { jumped: boolean; landed: boolean } {
    const events = { jumped: this.jumpEventPending, landed: this.landEventPending };
    this.jumpEventPending = false;
    this.landEventPending = false;
    return events;
  }

  /** Applies the chosen survivor's movement speeds. */
  setSpeeds(walkSpeed: number, sprintSpeed: number): void {
    this.walkSpeed = Math.max(0.5, walkSpeed);
    this.sprintSpeed = Math.max(this.walkSpeed, sprintSpeed);
  }

  /** First person or over-the-shoulder; V switches at runtime. */
  setViewMode(mode: ViewMode): void {
    this.viewMode = mode;
    this.syncCamera(0);
  }

  get mode(): ViewMode {
    return this.viewMode;
  }

  toggleViewMode(): ViewMode {
    this.setViewMode(this.viewMode === 'third' ? 'first' : 'third');
    return this.viewMode;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.velocity.set(0, 0, 0);
  }

  reset(): void {
    this.position.set(PLAYER.spawn.x, 0, PLAYER.spawn.z);
    this.velocity.set(0, 0, 0);
    this.yaw = Math.PI;
    this.pitch = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.bobTime = 0;
    this.onGround = true;
    this.landTimer = 0;
    this.jumpEventPending = false;
    this.landEventPending = false;
    this.syncCamera(0);
  }

  /**
   * Queues a shot's kick: up on every round, and sideways on most of them.
   *
   * The two offsets decay on their own (see update), so this only ever adds; nothing has
   * to subtract afterwards, which is what keeps the recovery from being a second,
   * hand-tuned motion that can drift.
   */
  addRecoil(amount: number, yaw = 0): void {
    this.recoilPitch += amount;
    this.recoilYaw += yaw;
  }

  /**
   * Camera forward projected on the XZ plane.
   *
   * three.js cameras look down their local -Z, so with `rotation.y = yaw` the
   * world-space forward is (-sin yaw, -cos yaw). Movement uses this, not
   * (sin, cos), or W would walk backwards.
   */
  get forwardXZ(): { x: number; z: number } {
    return { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) };
  }

  /**
   * Facing expressed as `atan2(x, z)`, the same convention the spawn-cone test
   * uses, so "in front of the player" means the same thing everywhere.
   */
  get facingAngle(): number {
    const forward = this.forwardXZ;
    return Math.atan2(forward.x, forward.z);
  }

  /** Ground speed in m/s, which drives head bob and the character's walk cycle. */
  get speed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  get eyePosition(): Vector3 {
    // Feet height plus the eye offset: a jump raises the eye line with the body.
    return new Vector3(this.position.x, this.position.y + PLAYER.eyeHeight, this.position.z);
  }

  update(delta: number, input: InputSnapshot | null): void {
    // Recoil recovers even while paused-free frames are skipped, so the camera
    // never sticks looking at the sky after a burst.
    this.recoilPitch = damp(this.recoilPitch, 0, RECOIL_RECOVERY, delta);
    this.recoilYaw = damp(this.recoilYaw, 0, RECOIL_RECOVERY, delta);

    if (!this.enabled || !input) {
      this.velocity.x = damp(this.velocity.x, 0, PLAYER.groundDamping, delta);
      this.velocity.z = damp(this.velocity.z, 0, PLAYER.groundDamping, delta);
      // Vertical motion is frozen rather than simulated here. Pausing in mid-air must not
      // drop the player to the road, and there is nothing to advance while the world is
      // stopped — the arc resumes from the same height and speed on the next live frame.
      this.syncCamera(delta);
      return;
    }

    if (input.lookX !== 0 || input.lookY !== 0) {
      this.yaw -= input.lookX * 0.0022 * this.sensitivity;
      this.pitch -= input.lookY * 0.0022 * this.sensitivity;
      this.pitch = clamp(this.pitch, -Math.PI / 2 + 0.05, Math.PI / 2 - 0.05);
      this.yaw = this.yaw % (Math.PI * 2);
    }

    // A jump is accepted only from the ground: that single rule is the whole anti-double-jump
    // policy, so a press while airborne is ignored rather than queued (nothing here latches
    // it), and holding the key cannot buy a second hop.
    if (input.jumpPressed && this.onGround) {
      this.velocity.y = PLAYER.jumpSpeed;
      this.onGround = false;
      this.jumpEventPending = true;
    }

    // Movement is relative to where the camera is looking (see forwardXZ).
    const forwardX = -Math.sin(this.yaw);
    const forwardZ = -Math.cos(this.yaw);
    const rightX = Math.cos(this.yaw);
    const rightZ = -Math.sin(this.yaw);

    let wishX = forwardX * input.forward + rightX * input.right;
    let wishZ = forwardZ * input.forward + rightZ * input.right;
    const wishLength = Math.hypot(wishX, wishZ);
    if (wishLength > 1e-4) {
      wishX /= wishLength;
      wishZ /= wishLength;
    } else {
      wishX = 0;
      wishZ = 0;
    }

    const targetSpeed = (input.sprint ? this.sprintSpeed : this.walkSpeed) * (wishLength > 0 ? 1 : 0);
    const desiredX = wishX * targetSpeed;
    const desiredZ = wishZ * targetSpeed;

    // Accelerate toward the desired velocity; damping toward zero when idle.
    const rate = wishLength > 0 ? PLAYER.acceleration : PLAYER.groundDamping * 1.4;
    this.velocity.x = damp(this.velocity.x, desiredX, rate * 0.35, delta);
    this.velocity.z = damp(this.velocity.z, desiredZ, rate * 0.35, delta);

    this.position.x += this.velocity.x * delta;
    this.position.z += this.velocity.z * delta;
    this.collision.resolveCircle(this.position, PLAYER.radius);

    // Vertical motion, through the pure step so the arc is testable on its own. The ground is
    // the flat plane at y = 0: the collision world's boxes carry a height, but `resolveCircle`
    // resolves in XZ at every height, so a box that blocks the player also blocks them in
    // flight — there is no walkable surface above the road to land on, and the jump therefore
    // cannot clear a wall or leave the block, it can only arc over the pavement.
    const vertical = stepVertical(
      { height: this.position.y, speed: this.velocity.y, grounded: this.onGround },
      PLAYER.gravity,
      delta,
    );
    this.position.y = vertical.height;
    this.velocity.y = vertical.speed;
    this.onGround = vertical.grounded;
    if (vertical.landed) {
      this.landTimer = PLAYER.landSeconds;
      this.landEventPending = true;
    } else if (this.landTimer > 0) {
      this.landTimer = Math.max(0, this.landTimer - delta);
    }

    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    this.bobTime += delta * (4 + speed * 1.4);
    this.syncCamera(delta);
  }

  private syncCamera(delta: number): void {
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const bobAmount = speed > 0.4 ? Math.min(speed / this.sprintSpeed, 1) * PLAYER.headBobAmplitude : 0;
    const bobY = Math.sin(this.bobTime * PLAYER.headBobFrequency) * bobAmount;
    const bobX = Math.cos(this.bobTime * PLAYER.headBobFrequency * 0.5) * bobAmount * 0.6;

    const pose = placeViewCamera({
      position: this.position,
      baseY: this.position.y,
      eyeHeight: PLAYER.eyeHeight,
      yaw: this.yaw,
      pitch: this.pitch,
      recoilPitch: this.recoilPitch,
      recoilYaw: this.recoilYaw,
      mode: this.viewMode,
      third: THIRD_PERSON,
      obstructionDistance: this.viewMode === 'third' ? this.measureCameraObstruction() : null,
      bob: { x: bobX, y: bobY },
    });

    this.scratchDirection.set(0, 0, 0);
    this.camera.position.set(pose.x, pose.y, pose.z);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = pose.yaw;
    this.camera.rotation.x = pose.pitch;
    if (delta === 0) this.camera.updateMatrixWorld();
  }

  /**
   * How far the camera can sit behind the player's head before it would enter a
   * wall. Uses the same collision world the player is blocked by, so the camera
   * can never look through a building the player cannot walk through.
   */
  private measureCameraObstruction(): number | null {
    const behindX = Math.sin(this.yaw);
    const behindZ = Math.cos(this.yaw);
    const origin = this.scratchOrigin.set(this.position.x, this.position.y + PLAYER.eyeHeight, this.position.z);
    const hit = this.collision.raycast(
      origin,
      this.scratchDirection.set(behindX, 0, behindZ),
      THIRD_PERSON.distance,
    );
    return hit ? hit.distance : null;
  }
}
