import { DEFAULT_QUALITY, QUALITY_PRESETS, type QualityTier } from '../app/gameConfig';
import { DEFAULT_CHARACTER_ID, type CharacterId } from '../app/characters';
import type { ViewMode } from '../player/viewCamera';

export interface SettingsValues {
  volume: number;
  sensitivity: number;
  quality: QualityTier;
  shadows: boolean;
  flashEffects: boolean;
  debugOverlay: boolean;
  /** Chosen survivor; persisted so the player keeps their character. */
  characterId: CharacterId;
  /** Camera mode; third person by default so the character is visible. */
  viewMode: ViewMode;
}

const STORAGE_KEY = 'dead-district:settings:v1';

export const DEFAULT_SETTINGS: SettingsValues = {
  volume: 0.7,
  sensitivity: 1,
  quality: DEFAULT_QUALITY,
  shadows: QUALITY_PRESETS[DEFAULT_QUALITY].shadows,
  flashEffects: true,
  debugOverlay: false,
  characterId: DEFAULT_CHARACTER_ID,
  viewMode: 'third',
};

/**
 * Settings store with localStorage persistence.
 *
 * Parsing is defensive: a corrupted or hand-edited entry falls back to defaults
 * rather than crashing the game on boot.
 */
export class SettingsStore {
  private values: SettingsValues;

  constructor(initial: SettingsValues = DEFAULT_SETTINGS) {
    this.values = { ...initial, ...this.load() };
  }

  get current(): SettingsValues {
    return this.values;
  }

  update(change: Partial<SettingsValues>): SettingsValues {
    this.values = { ...this.values, ...change };
    this.save();
    return this.values;
  }

  reset(): SettingsValues {
    this.values = { ...DEFAULT_SETTINGS };
    this.save();
    return this.values;
  }

  private load(): Partial<SettingsValues> {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return {};
      const record = parsed as Record<string, unknown>;
      const result: Partial<SettingsValues> = {};
      if (typeof record.volume === 'number' && record.volume >= 0 && record.volume <= 1) result.volume = record.volume;
      if (typeof record.sensitivity === 'number' && record.sensitivity > 0) result.sensitivity = record.sensitivity;
      if (typeof record.quality === 'string' && record.quality in QUALITY_PRESETS) result.quality = record.quality as QualityTier;
      if (typeof record.shadows === 'boolean') result.shadows = record.shadows;
      if (typeof record.flashEffects === 'boolean') result.flashEffects = record.flashEffects;
      if (typeof record.characterId === 'string') result.characterId = record.characterId as CharacterId;
      if (record.viewMode === 'first' || record.viewMode === 'third') result.viewMode = record.viewMode;
      if (typeof record.debugOverlay === 'boolean') result.debugOverlay = record.debugOverlay;
      return result;
    } catch (error) {
      console.warn('[settings] could not read stored settings, using defaults', error);
      return {};
    }
  }

  private save(): void {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.values));
    } catch (error) {
      console.warn('[settings] could not persist settings', error);
    }
  }
}
