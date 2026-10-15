import { Camera, Vector3 } from 'three';
import { PLAYER, THIRD_PERSON } from '../app/gameConfig';
import { CollisionWorld } from '../level/CollisionWorld';
import { placeViewCamera, type ViewMode } from './viewCamera';
import type { InputSnapshot } from '../input/InputManager';
import { clamp, damp } from '../utils/math';

export interface PlayerControllerDeps {
  camera: Camera;
  collision: CollisionWorld;
}

/**
 * First-person movement and camera orientation.
 *
 * The player is a kinematic circle: intent is turned into a velocity, the
 * velocity is integrated with delta time, and the collision world pushes the
 * circle out of geometry. Vertical movement is intentionally absent (one flat
 * city block), so there is no gravity or jump to get wrong.
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

  /** Current recoil offset in radians (read-only, for diagnostics). */
  get currentRecoilPitch(): number {
    return this.recoilPitch;
  }
  private bobTime = 0;
  private enabled = true;
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
    this.bobTime = 0;
    this.syncCamera(0);
  }

  addRecoil(amount: number): void {
    this.recoilPitch += amount;
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
    return new Vector3(this.position.x, PLAYER.eyeHeight, this.position.z);
  }

  update(delta: number, input: InputSnapshot | null): void {
    // Recoil recovers even while paused-free frames are skipped, so the camera
    // never sticks looking at the sky after a burst.
    this.recoilPitch = damp(this.recoilPitch, 0, 7, delta);

    if (!this.enabled || !input) {
      this.velocity.x = damp(this.velocity.x, 0, PLAYER.groundDamping, delta);
      this.velocity.z = damp(this.velocity.z, 0, PLAYER.groundDamping, delta);
      this.syncCamera(delta);
      return;
    }

    if (input.lookX !== 0 || input.lookY !== 0) {
      this.yaw -= input.lookX * 0.0022 * this.sensitivity;
      this.pitch -= input.lookY * 0.0022 * this.sensitivity;
      this.pitch = clamp(this.pitch, -Math.PI / 2 + 0.05, Math.PI / 2 - 0.05);
      this.yaw = this.yaw % (Math.PI * 2);
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
      eyeHeight: PLAYER.eyeHeight,
      yaw: this.yaw,
      pitch: this.pitch,
      recoilPitch: this.recoilPitch,
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
    const origin = this.scratchOrigin.set(this.position.x, PLAYER.eyeHeight, this.position.z);
    const hit = this.collision.raycast(
      origin,
      this.scratchDirection.set(behindX, 0, behindZ),
      THIRD_PERSON.distance,
    );
    return hit ? hit.distance : null;
  }
}
