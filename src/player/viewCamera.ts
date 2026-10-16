import { clamp } from '../utils/math';

export type ViewMode = 'first' | 'third';

export interface ThirdPersonConfig {
  /** Ideal distance behind the player's head, metres. */
  distance: number;
  /** Never closer than this, however tight the space. */
  minDistance: number;
  /**
   * Camera height above the eye line, metres.
   *
   * This is what keeps the character out of the middle of the screen: a boom set
   * high and looking along the player's own aim line puts the body in the lower
   * third, leaving the crosshair and the road ahead clear.
   */
  heightOffset: number;
  /** Camera height is clamped to at least this above the ground. */
  floorClearance: number;
}

export interface ViewCameraInput {
  position: { x: number; z: number };
  /**
   * Height of the player's feet above the world ground plane, metres.
   *
   * Separate from `eyeHeight`, which is the character's own eye offset: this is what makes
   * the camera ride up and down with a jump without the eye height itself changing. Absent
   * means grounded, which is the world before §14.2.
   */
  baseY?: number;
  eyeHeight: number;
  yaw: number;
  pitch: number;
  /** Extra recoil pitch, radians, added to the view pitch. */
  recoilPitch?: number;
  /**
   * Extra recoil yaw, radians, added to the view yaw.
   *
   * Kept apart from `yaw` and added here, exactly as the pitch is: the player's own aim
   * is never written to by a shot, so a burst that has finished recovering leaves the
   * camera pointing precisely where the mouse left it.
   */
  recoilYaw?: number;
  mode: ViewMode;
  third: ThirdPersonConfig;
  /**
   * Distance to the closest wall behind the player's head, or null when nothing
   * is in the way. Used to pull the camera in instead of letting it clip through
   * a building.
   */
  obstructionDistance?: number | null;
  /** Head bob offset applied in first person only, metres. */
  bob?: { x: number; y: number };
}

export interface ViewCameraPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  /** Distance actually used behind the head; equals 0 in first person. */
  distance: number;
}

/**
 * Places the view camera for either mode.
 *
 * Third person is a boom that sits behind and above the player's eye and looks
 * along **the player's own aim direction** — the same yaw and pitch as first
 * person, with no sideways offset. That is deliberate: shots are fired from the
 * eye along the camera's forward vector, so a parallel boom keeps the crosshair,
 * the muzzle line and the first-person aim all on one line. An over-the-shoulder
 * offset looks nicer in a screenshot but puts every shot ~0.4 m to the side of
 * where the crosshair points, at every range.
 */
/**
 * Yaw offset that puts a subject at `frameFraction` of the frame width.
 *
 * 0.5 is dead centre; 0.72 puts the subject three quarters of the way to the right
 * edge. Derived from the field of view rather than tuned by eye, so it holds at any
 * window size: the subject's angular offset has to satisfy
 * `tan(offset) = (2f - 1) * tan(halfFovX)`, and halfFovX follows from the vertical
 * FOV and the aspect ratio.
 *
 * A positive result turns the camera left, which moves a stationary subject to the
 * right of frame.
 */
export function showcaseLookYawOffset(
  frameFraction: number,
  fovYDegrees: number,
  aspect: number,
): number {
  const halfFovY = (Math.max(1, Math.min(179, fovYDegrees)) * Math.PI) / 360;
  const tanHalfFovX = Math.tan(halfFovY) * Math.max(0.1, aspect);
  const clamped = Math.max(0.01, Math.min(0.99, frameFraction));
  return Math.atan((2 * clamped - 1) * tanHalfFovX);
}

export function placeViewCamera(input: ViewCameraInput): ViewCameraPose {
  const { position, eyeHeight, yaw, pitch, third } = input;
  // Feet height plus the character's own eye offset: a jump lifts the eye line, it does not
  // shorten the character.
  const eyeY = (input.baseY ?? 0) + eyeHeight;

  if (input.mode === 'first') {
    const bob = input.bob ?? { x: 0, y: 0 };
    return {
      x: position.x + bob.x,
      y: eyeY + bob.y,
      z: position.z,
      yaw: yaw + (input.recoilYaw ?? 0),
      pitch: pitch + (input.recoilPitch ?? 0),
      distance: 0,
    };
  }

  const forwardX = -Math.sin(yaw);
  const forwardZ = -Math.cos(yaw);

  // Pull the camera in when a wall is behind the player rather than clipping it.
  let distance = third.distance;
  if (input.obstructionDistance !== null && input.obstructionDistance !== undefined) {
    distance = Math.min(distance, input.obstructionDistance - 0.3);
  }
  distance = clamp(distance, Math.min(third.minDistance, third.distance), third.distance);

  // Straight back along the aim line, and up. No lateral offset, so the ray the
  // crosshair marks is the very ray the muzzle fires along.
  const x = position.x - forwardX * distance;
  const z = position.z - forwardZ * distance;
  const y = Math.max(eyeY + third.heightOffset, third.floorClearance);

  return { x, y, z, yaw: yaw + (input.recoilYaw ?? 0), pitch: pitch + (input.recoilPitch ?? 0), distance };
}
