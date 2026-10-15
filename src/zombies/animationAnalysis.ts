import { AnimationClip, VectorKeyframeTrack } from 'three';

export interface ClipMotion {
  name: string;
  /** Clip length in seconds. */
  duration: number;
  trackCount: number;
  /** Root bone position track used for the analysis, if the clip has one. */
  rootTrackName: string | null;
  /**
   * Horizontal distance the root travels over one loop, in metres.
   * 0 means the clip is authored in place (translation is driven by code).
   */
  horizontalTravel: number;
  /** Vertical range of the root over one loop, in metres (for lift-off checks). */
  verticalRange: number;
  /** Loop frequency at timeScale = 1. */
  cadence: number;
}

/**
 * Fraction of a clip's tracks whose bone exists in a target skeleton.
 *
 * Clips from the same rig family bind by track name, so a clip written for one
 * model plays on another model of that family with no retargeting at all. This
 * measures that compatibility instead of assuming it: a clip that binds partially
 * is rejected, because unmatched tracks silently leave limbs unanimated.
 */
export function clipCompatibility(clip: AnimationClip, targetBones: ReadonlySet<string>): number {
  if (clip.tracks.length === 0) return 0;
  let matched = 0;
  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf('.');
    const path = dot >= 0 ? track.name.slice(0, dot) : track.name;
    const parts = path.split('/');
    const bone = (parts[parts.length - 1] ?? path).toLowerCase();
    if (targetBones.has(bone)) matched += 1;
  }
  return matched / clip.tracks.length;
}

/**
 * Bone names a clip animates that the target skeleton does not have.
 *
 * Returned sorted and de-duplicated so the reason a clip was refused is
 * reviewable: missing finger or toe bones are cosmetic, a missing spine or upper
 * arm is not.
 */
export function missingBindings(clip: AnimationClip, targetBones: ReadonlySet<string>): string[] {
  const missing = new Set<string>();
  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf('.');
    const path = dot >= 0 ? track.name.slice(0, dot) : track.name;
    const parts = path.split('/');
    const bone = (parts[parts.length - 1] ?? path).toLowerCase();
    if (!targetBones.has(bone)) missing.add(bone);
  }
  return [...missing].sort();
}

/** Lower-cased bone names in a hierarchy, used as a clip-binding target set. */
export function collectBoneNames(root: import('three').Object3D): Set<string> {
  const names = new Set<string>();
  root.traverse((child) => {
    if (child.name) names.add(child.name.toLowerCase());
  });
  return names;
}

/** Bones that carry the whole body, from most to least specific. */
const ROOT_TRACK_CANDIDATES = ['hips', 'root', 'armature', 'pelvis', 'spine'];

function isPositionTrack(trackName: string): boolean {
  return trackName.toLowerCase().endsWith('.position');
}

function boneNameOf(trackName: string): string {
  const dot = trackName.lastIndexOf('.');
  const path = dot >= 0 ? trackName.slice(0, dot) : trackName;
  const parts = path.split('/');
  return (parts[parts.length - 1] ?? path).toLowerCase();
}

/**
 * Measures what a clip actually does to the body.
 *
 * The important number is `horizontalTravel`: a clip with no root translation is
 * "in place", so the visible walking speed is entirely decided by how fast the
 * code moves the entity. Without matching the two, feet slide — which is the
 * single most common tell of cheap character animation.
 */
export function analyseClip(clip: AnimationClip): ClipMotion {
  let rootTrack: VectorKeyframeTrack | null = null;

  for (const candidate of ROOT_TRACK_CANDIDATES) {
    const found = clip.tracks.find(
      (track) => isPositionTrack(track.name) && boneNameOf(track.name).includes(candidate),
    );
    if (found instanceof VectorKeyframeTrack) {
      rootTrack = found;
      break;
    }
  }

  if (!rootTrack) {
    return {
      name: clip.name,
      duration: clip.duration,
      trackCount: clip.tracks.length,
      rootTrackName: null,
      horizontalTravel: 0,
      verticalRange: 0,
      cadence: clip.duration > 0 ? 1 / clip.duration : 0,
    };
  }

  const values = rootTrack.values;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let i = 0; i + 2 < values.length; i += 3) {
    const x = values[i];
    const y = values[i + 1];
    const z = values[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }

  // The loop's net displacement is the difference between the last and first
  // keyframe; the swing (max-min) would count a bobbing in-place clip as travel.
  const last = values.length >= 3 ? values.length - 3 : 0;
  const travelX = values[last] - values[0];
  const travelZ = values[last + 2] - values[0 + 2];

  return {
    name: clip.name,
    duration: clip.duration,
    trackCount: clip.tracks.length,
    rootTrackName: rootTrack.name,
    horizontalTravel: Math.hypot(travelX, travelZ),
    verticalRange: maxY - minY,
    cadence: clip.duration > 0 ? 1 / clip.duration : 0,
  };
}

/**
 * Playback speed that makes the animated stride match how fast the entity is
 * actually moving.
 *
 * With root motion present the answer is exact: the clip covers
 * `horizontalTravel` metres per loop, so playing it `speed / (travel * cadence)`
 * times faster keeps feet planted. For an in-place clip there is no such ground
 * truth, so the caller supplies the speed the clip was authored to look right at.
 */
export function requiredTimeScale(motion: ClipMotion, speed: number, inPlaceReferenceSpeed: number): number {
  if (speed <= 0.01) return 0;
  const animatedSpeed = motion.horizontalTravel > 0.02
    ? motion.horizontalTravel * motion.cadence
    : inPlaceReferenceSpeed;
  if (animatedSpeed <= 0.01) return 1;
  return speed / animatedSpeed;
}
