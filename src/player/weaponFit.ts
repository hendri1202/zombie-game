import { Euler, Matrix4, Mesh, Object3D, Vector3 } from 'three';
import { measureWeaponFrame, type WeaponFrame } from './weaponMechanism';

/**
 * Where a mounted weapon's barrel actually ends, and where its fore-end is.
 *
 * Both numbers are read out of the mesh rather than tuned by eye, because both were wrong in
 * a way no configuration value could show: `WEAPON_FEEL.muzzleOffset` was one offset for the
 * whole roster, so the flash left a point 36 cm in front of the holder no matter how long the
 * gun was — 20 cm past the MP7's muzzle, just inside the 870's — and `HANDS_PLACEMENT` had one
 * support-hand reach per grip kind, so the hand sat at a fixed distance from the grip on a
 * 0.29 m PDW and a 0.50 m belt-fed gun alike.
 *
 * The frame itself (`measureWeaponFrame`) already knows the body's own long axis, which is the
 * hard part: the pack's shotgun and SMG are turned about 40 degrees inside their own space, so
 * "the far end along +Z" is not the muzzle for either of them.
 */

/** The last few percent of the body, averaged, so one stray vertex cannot move the tip. */
const TIP_BAND = 0.04;

export interface WeaponFit {
  /** The body's measured frame: axis, length, and its surface height at a station. */
  readonly frame: WeaponFrame;
  /**
   * The bore's end, in the model's own local units (the units `measureWeaponFrame` reports,
   * before `normalizeViewModel`'s scale — `Object3D.localToWorld` applies that).
   */
  readonly barrelTip: Vector3;
  /**
   * A point on the body's own centre line `station` of the way from the butt to the muzzle.
   *
   * `y` is the middle of the body's cross-section there, not the mesh's overall top: a hand
   * placed against the overall top would sit on the pistol's rear sight.
   */
  gripPoint(station: number, out: Vector3): Vector3;
}

/**
 * Measures a weapon's barrel tip and fore-end from its geometry.
 *
 * The tip is the furthest vertex along the measured axis, with its across-axis position taken
 * from the mean of the last 4% of the body. The mean matters: the extreme vertex of a barrel
 * modelled as a ten-sided cylinder is one corner of the muzzle's rim, and putting the flash on
 * a corner of the rim makes it visibly off-centre on the shot after the muzzle brake's spin.
 */
export function measureWeaponFit(model: Object3D): WeaponFit {
  const frame = measureWeaponFrame(model);
  model.updateMatrixWorld(true);
  const toLocal = new Matrix4().copy(model.matrixWorld).invert();
  const matrix = new Matrix4();
  const point = new Vector3();

  /** Visits every vertex of the model in the model's own local space. */
  const eachVertex = (visit: (vertex: Vector3) => void): void => {
    model.traverse((child) => {
      const mesh = child as Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      const attribute = mesh.geometry.getAttribute('position');
      if (!attribute) return;
      matrix.multiplyMatrices(toLocal, mesh.matrixWorld);
      for (let index = 0; index < attribute.count; index += 1) {
        point.set(attribute.getX(index), attribute.getY(index), attribute.getZ(index))
          .applyMatrix4(matrix);
        visit(point);
      }
    });
  };
  const along = (vertex: Vector3): number => vertex.x * frame.axis.x + vertex.z * frame.axis.z;

  // Extremes measured from the model's own origin, not from the centroid that
  // `measureWeaponFrame` reports its stations against: the grip convention puts the origin at
  // the grip, so a station is a distance along the axis from there, and mixing the two frames
  // shifts every point by the centroid's own projection onto the axis (which on the long guns
  // is several centimetres).
  let furthest = Number.NEGATIVE_INFINITY;
  let nearest = Number.POSITIVE_INFINITY;
  eachVertex((vertex) => {
    const distance = along(vertex);
    furthest = Math.max(furthest, distance);
    nearest = Math.min(nearest, distance);
  });

  const tip = new Vector3();
  if (Number.isFinite(furthest)) {
    const band = Math.max(1e-4, frame.length * TIP_BAND);
    const mean = new Vector3();
    let samples = 0;
    eachVertex((vertex) => {
      if (along(vertex) < furthest - band) return;
      mean.add(vertex);
      samples += 1;
    });
    if (samples > 0) {
      mean.multiplyScalar(1 / samples);
      // The mean of a tip cross-section sits half a band behind the extreme, so the mean
      // supplies the bore's centre and the extreme supplies the distance.
      tip.copy(mean).addScaledVector(frame.axis, furthest - along(mean));
    } else {
      tip.copy(frame.axis).multiplyScalar(furthest);
    }
  }

  return {
    frame,
    barrelTip: tip,
    gripPoint(station: number, out: Vector3): Vector3 {
      const clamped = Math.min(1, Math.max(0, station));
      const distance = nearest + (furthest - nearest) * clamped;
      out.set(frame.axis.x * distance, 0, frame.axis.z * distance);
      // The middle of the body's cross-section there: a hand hangs under the bore, not on the
      // line the barrel's tip is on.
      out.y = frame.centreAt(clamped);
      return out;
    },
  };
}

/**
 * The muzzle's position in the frame a flash offset is expressed in: the weapon's placement.
 *
 * `WeaponController.muzzleWorldPosition` adds this to `viewModelHolder.position` and then
 * transforms by the camera, so the number is `R_placement * (holderScale * modelScale * tip)`
 * — the weapon's own placement rotation and both scales, and nothing else. The holder's
 * *transient* pose is deliberately left out: it carries the equip drop and the recoil kick,
 * which move the flash with the gun's position (as the fixed offset always did) but must not
 * rotate it, or the flash swings off the bore for the fraction of a second after a swap.
 *
 * Measuring at mount time through `holder.worldToLocal` instead catches that transient pose:
 * with the weapon still being raised, the holder is rotated by half a radian and the offset
 * comes out 8 cm off the bore.
 */
export function muzzleOffsetInPlacement(
  fit: WeaponFit,
  model: Object3D,
  holderScale: number,
  placementRotation: readonly [number, number, number],
  out = new Vector3(),
): Vector3 {
  model.updateMatrix();
  out.copy(fit.barrelTip).applyMatrix4(model.matrix).multiplyScalar(holderScale);
  return out.applyEuler(new Euler(placementRotation[0], placementRotation[1], placementRotation[2]));
}

/**
 * Where the support hand grips the weapon, in the hands group's own space.
 *
 * The hands group is a sibling of the weapon under the holder, so the point is measured on
 * the mesh and then carried into the hands' space — which is what makes the hand land on the
 * weapon instead of at a fixed reach that only happens to suit one barrel length.
 */
export function supportGripInHands(
  fit: WeaponFit,
  model: Object3D,
  holder: Object3D,
  hands: Object3D,
  station: number,
  out = new Vector3(),
): Vector3 {
  holder.updateMatrixWorld(true);
  hands.updateMatrixWorld(true);
  model.localToWorld(fit.gripPoint(station, out));
  return hands.worldToLocal(out);
}

/** Where the support hand goes along the weapon, as a fraction from butt to muzzle. */
export const SUPPORT_GRIP_STATION = 0.66;
