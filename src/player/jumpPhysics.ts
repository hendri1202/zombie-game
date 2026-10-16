/**
 * Vertical motion for the jump, kept pure and separate from the controller.
 *
 * The world is otherwise flat — a ground plane and axis-aligned collision boxes that are
 * resolved in XZ only (see `CollisionWorld.resolveCircle`) — so the jump adds exactly one
 * new axis of movement, and it is worth being able to assert that arc without a camera, a
 * collision world or a frame loop. `PlayerController` owns the controls and the landing
 * timer; the maths that actually moves the player lives here.
 *
 * The integration is semi-implicit Euler (`speed -= g·dt`, then `height += speed·dt`),
 * which is what the controller runs every frame. Its first-order error makes the discrete
 * peak a little *lower* than the closed-form `jumpPeakHeight`, so the helpers below are the
 * design figures and the tests compare the simulated arc against them with a tolerance
 * rather than for equality.
 */

/** The ground the player lands on, metres. One flat city block: there is no terrain height. */
export const GROUND_HEIGHT = 0;

/** Height a jump launched at `jumpSpeed` reaches, metres: v² / (2g). */
export function jumpPeakHeight(jumpSpeed: number, gravity: number): number {
  if (gravity <= 0) return 0;
  return (jumpSpeed * jumpSpeed) / (2 * gravity);
}

/** Seconds from launch to landing back at the same height: 2v / g. */
export function jumpAirTime(jumpSpeed: number, gravity: number): number {
  if (gravity <= 0) return 0;
  return (2 * jumpSpeed) / gravity;
}

/**
 * The three air poses the character can hold, in the order one jump passes through them.
 *
 * `hang` is the peak *and* the whole descent: the rig ships one airborne pose
 * (`Jump_Idle`) and no separate falling clip, so the same pose that reads as "hanging at
 * the top" also reads as the float on the way down.
 */
export type JumpPhase = 'rise' | 'hang' | 'land';

export interface VerticalState {
  /** Height of the feet above the ground plane, metres. */
  height: number;
  /** Vertical speed, m/s; positive is up. */
  speed: number;
  /** True while the feet are on the ground. */
  grounded: boolean;
}

export interface VerticalStep extends VerticalState {
  /** True on the step the feet touched the ground (a landing, not a standing frame). */
  landed: boolean;
  /** Downward speed at touchdown, m/s; 0 on every other step. */
  impactSpeed: number;
}

/**
 * Advances height and speed one step and settles the player on the ground plane.
 *
 * Landing is a clamp, never a bounce: `height` is never left below the ground and `speed`
 * is zeroed on contact, which is what stops the arc from tunnelling through the floor and
 * what makes `grounded` a trustworthy answer for the next step. A body already standing on
 * the ground reports `landed: false` on every step — only the step that ends a fall in
 * flight counts.
 */
export function stepVertical(
  state: VerticalState,
  gravity: number,
  delta: number,
  groundHeight = GROUND_HEIGHT,
): VerticalStep {
  const wasGrounded = state.grounded;
  const speed = state.speed - gravity * delta;
  const height = state.height + speed * delta;

  if (height <= groundHeight) {
    return {
      height: groundHeight,
      speed: 0,
      grounded: true,
      landed: !wasGrounded,
      impactSpeed: wasGrounded ? 0 : Math.abs(speed),
    };
  }

  return { height, speed, grounded: false, landed: false, impactSpeed: 0 };
}
