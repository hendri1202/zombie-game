import { describe, expect, it } from 'vitest';
import { placeViewCamera, showcaseLookYawOffset, type ThirdPersonConfig } from '../src/player/viewCamera';

const THIRD: ThirdPersonConfig = {
  distance: 3.4,
  minDistance: 1.1,
  heightOffset: 1.02,
  floorClearance: 0.45,
};

describe('showcase framing', () => {
  it('puts a subject at the middle of the frame with no rotation', () => {
    expect(showcaseLookYawOffset(0.5, 76, 1.6)).toBeCloseTo(0, 9);
  });

  it('turns the camera further for subjects nearer the edge, and the other way on the left',
    () => {
      const centre = showcaseLookYawOffset(0.5, 76, 1.6);
      const right = showcaseLookYawOffset(0.72, 76, 1.6);
      const further = showcaseLookYawOffset(0.9, 76, 1.6);
      const left = showcaseLookYawOffset(0.25, 76, 1.6);
      expect(right).toBeGreaterThan(centre);
      expect(further).toBeGreaterThan(right);
      expect(left).toBeLessThan(centre);
    });

  it('matches the projection maths it claims to invert', () => {
    // A subject at angle t from the camera axis projects to 0.5 + tan(t) / (2 tan(halfFovX)).
    const fov = 76;
    const aspect = 1.6;
    const tanHalfFovX = Math.tan((fov * Math.PI) / 360) * aspect;
    for (const fraction of [0.55, 0.62, 0.72, 0.85]) {
      const offset = showcaseLookYawOffset(fraction, fov, aspect);
      const projected = 0.5 + Math.tan(offset) / (2 * tanHalfFovX);
      expect(projected).toBeCloseTo(fraction, 6);
    }
  });

  it('follows the aspect ratio instead of assuming one', () => {
    // A narrow window has a smaller horizontal field of view, so the same screen
    // fraction sits at a smaller angle. Assuming a fixed aspect would push the
    // subject off the edge on a tall window.
    const wide = showcaseLookYawOffset(0.72, 76, 1.78);
    const narrow = showcaseLookYawOffset(0.72, 76, 1.1);
    expect(narrow).toBeLessThan(wide);
    // ...and both still project to 0.72 in their own window.
    expect(0.5 + Math.tan(narrow) / (2 * (Math.tan((76 * Math.PI) / 360) * 1.1))).toBeCloseTo(0.72, 6);
    expect(0.5 + Math.tan(wide) / (2 * (Math.tan((76 * Math.PI) / 360) * 1.78))).toBeCloseTo(0.72, 6);
  });

  it('stays finite for degenerate inputs', () => {
    for (const [fraction, fov, aspect] of [[0, 76, 1.6], [1, 76, 1.6], [0.5, 0, 0.0], [0.5, 400, 99]]) {
      expect(Number.isFinite(showcaseLookYawOffset(fraction, fov, aspect))).toBe(true);
    }
  });
});

const base = {
  position: { x: 4, z: -7 },
  eyeHeight: 1.62,
  yaw: 0,
  pitch: 0,
  third: THIRD,
} as const;

describe('view camera', () => {
  it('puts the first-person camera at the eye, including head bob', () => {
    const pose = placeViewCamera({
      ...base, mode: 'first', bob: { x: 0.03, y: -0.04 }, recoilPitch: 0.05,
    });
    expect(pose.x).toBeCloseTo(4.03, 6);
    expect(pose.y).toBeCloseTo(1.58, 6);
    expect(pose.z).toBeCloseTo(-7, 6);
    expect(pose.yaw).toBeCloseTo(0, 6);
    expect(pose.pitch).toBeCloseTo(0.05, 6);
    expect(pose.distance).toBe(0);
  });

  it('places the third-person camera behind the player, never in front', () => {
    const pose = placeViewCamera({ ...base, mode: 'third' });
    // yaw 0 faces -Z, so the camera belongs at +Z relative to the player.
    const behindZ = pose.z - base.position.z;
    expect(behindZ).toBeGreaterThan(0);
    expect(pose.distance).toBeCloseTo(THIRD.distance, 6);
    expect(pose.y).toBeCloseTo(base.eyeHeight + THIRD.heightOffset, 6);
  });

  it('looks in exactly the same direction as first person, so aim is identical', () => {
    // The crosshair is the camera's forward vector and shots leave the eye along it,
    // so third person must not rotate the view at all.
    for (const pitch of [-0.7, -0.4, 0, 0.35, 0.9]) {
      for (const yaw of [0, 1.2, -2.5]) {
        const first = placeViewCamera({ ...base, mode: 'first', pitch, yaw });
        const third = placeViewCamera({ ...base, mode: 'third', pitch, yaw });
        expect(third.yaw, `yaw ${yaw}`).toBeCloseTo(first.yaw, 9);
        expect(third.pitch, `pitch ${pitch}`).toBeCloseTo(first.pitch, 9);
      }
    }
  });

  it('puts the camera on the same line of fire, only further back', () => {
    for (const yaw of [0, 1.2, -2.5]) {
      const first = placeViewCamera({ ...base, mode: 'first', pitch: 0.2, yaw });
      const third = placeViewCamera({ ...base, mode: 'third', pitch: 0.2, yaw });
      const dx = third.x - first.x;
      const dz = third.z - first.z;
      const forwardX = -Math.sin(yaw);
      const forwardZ = -Math.cos(yaw);

      // Straight back along the aim direction by exactly the boom length, and up.
      expect(Math.hypot(dx, dz), `yaw ${yaw}`).toBeCloseTo(THIRD.distance, 6);
      expect(dx).toBeCloseTo(-forwardX * THIRD.distance, 6);
      expect(dz).toBeCloseTo(-forwardZ * THIRD.distance, 6);
      expect(third.y - first.y).toBeCloseTo(THIRD.heightOffset, 6);

      // Zero sideways displacement: any cross-axis component would put the camera
      // off the line of fire and make the crosshair lie about where shots go.
      expect(dx * forwardZ - dz * forwardX, `yaw ${yaw}`).toBeCloseTo(0, 9);
    }
  });

  it('pulls the camera in when a wall is behind the player', () => {
    const pose = placeViewCamera({ ...base, mode: 'third', obstructionDistance: 1.8 });
    expect(pose.distance).toBeCloseTo(1.5, 6);
  });

  it('never ends up closer than the configured minimum, even in a corner', () => {
    const pose = placeViewCamera({ ...base, mode: 'third', obstructionDistance: 0.4 });
    expect(pose.distance).toBeCloseTo(THIRD.minDistance, 6);
  });

  it('floors the camera height so it cannot sink through the road', () => {
    const pose = placeViewCamera({
      ...base, eyeHeight: 0.1, mode: 'third', third: { ...THIRD, heightOffset: -2 },
    });
    expect(pose.y).toBeGreaterThanOrEqual(THIRD.floorClearance);
  });

  it('stays finite when aiming straight down', () => {
    for (const pitch of [-Math.PI / 2 + 0.01, Math.PI / 2 - 0.01]) {
      const pose = placeViewCamera({ ...base, mode: 'third', pitch });
      expect(Number.isFinite(pose.yaw)).toBe(true);
      expect(Number.isFinite(pose.pitch)).toBe(true);
      expect(Number.isFinite(pose.x + pose.y + pose.z)).toBe(true);
    }
  });
});
