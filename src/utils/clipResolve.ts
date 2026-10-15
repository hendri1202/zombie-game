import type { AnimationClip } from 'three';

export interface ClipResolution {
  clip: AnimationClip | null;
  matchedName: string | null;
  /** True when the requested state had no clip and a fallback was substituted. */
  usedFallback: boolean;
}

/**
 * Short name of a clip.
 *
 * Exporters prefix clips with the armature name ("CharacterArmature|Walk"), and
 * that prefix must not take part in matching.
 */
export function shortName(clip: AnimationClip): string {
  const parts = clip.name.split('|');
  return (parts[parts.length - 1] ?? clip.name).trim().toLowerCase();
}

/**
 * Finds the best clip for a candidate list.
 *
 * Candidate order is the priority; within one candidate an exact short-name
 * match beats a prefix match, which beats a substring match. Without that,
 * "Idle_Attack" would win over "Idle" for the idle state simply because it
 * appears earlier in the file.
 */
export function findClip(clips: AnimationClip[], candidates: readonly string[]): AnimationClip | null {
  for (const candidate of candidates) {
    const exact = clips.find((clip) => shortName(clip) === candidate.toLowerCase());
    if (exact) return exact;
  }
  for (const candidate of candidates) {
    const prefixed = clips.find((clip) => shortName(clip).startsWith(candidate.toLowerCase()));
    if (prefixed) return prefixed;
  }
  for (const candidate of candidates) {
    const contained = clips.find((clip) => shortName(clip).includes(candidate.toLowerCase()));
    if (contained) return contained;
  }
  return null;
}

/**
 * Resolves one state from a list of candidate lists, trying each group in order.
 *
 * The groups are the state itself followed by its fallbacks, so a character with
 * no gun-specific clip still gets a locomotion cycle instead of freezing.
 */
export function resolveByCandidates(clips: AnimationClip[], candidateGroups: readonly (readonly string[])[]): ClipResolution {
  for (let index = 0; index < candidateGroups.length; index += 1) {
    const clip = findClip(clips, candidateGroups[index]);
    if (clip) return { clip, matchedName: clip.name, usedFallback: index > 0 };
  }
  return { clip: null, matchedName: null, usedFallback: true };
}

/** Which clip each requested group resolved to, for logs and diagnostics. */
export function resolveCandidateMap(
  clips: AnimationClip[],
  groups: Record<string, readonly (readonly string[])[]>,
): Record<string, string | null> {
  const map: Record<string, string | null> = {};
  for (const state of Object.keys(groups)) map[state] = resolveByCandidates(clips, groups[state]).matchedName;
  return map;
}
