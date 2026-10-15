import { DEFAULT_QUALITY, QUALITY_PRESETS, type QualityTier } from '../app/gameConfig';
import { CHARACTERS, characterRatings, type CharacterId } from '../app/characters';

export type ScreenName =
  | 'loading' | 'title' | 'pause' | 'gameover' | 'settings' | 'controls' | 'credits' | 'none';

export interface MenuCallbacks {
  onStart: () => void;
  onResume: () => void;
  onRestart: () => void;
  onExitToTitle: () => void;
  onOpenSettings: () => void;
  onCloseSettings: () => void;
  onQualityChange: (tier: QualityTier) => void;
  onSettingsChange: (change: SettingsChange) => void;
  /** Chosen survivor; the game loads that model and applies its stats. */
  onCharacterSelect: (id: CharacterId) => void;
}

export interface SettingsChange {
  volume?: number;
  sensitivity?: number;
  shadows?: boolean;
  flashEffects?: boolean;
  debugOverlay?: boolean;
}

export interface GameOverSummary {
  cause: string;
  kills: number;
  wave: number;
  survivedSeconds: number;
}

function el<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`UI element #${id} is missing from index.html`);
  return element as T;
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

/**
 * All DOM menus: title, pause, game over, settings, controls and credits, plus
 * the loading screen with its actionable error text.
 *
 * Menus report pointer hover back to the game so a click on a menu control can
 * never be interpreted as a shot or a movement key.
 */
export class Menus {
  private readonly screens: Record<Exclude<ScreenName, 'none'>, HTMLElement>;
  private previousScreen: ScreenName = 'none';

  private readonly loadingBar = el<HTMLDivElement>('loading-bar');
  private readonly loadingStatus = el<HTMLParagraphElement>('loading-status');
  private readonly loadingError = el<HTMLParagraphElement>('loading-error');
  private readonly titleAssetNote = el<HTMLParagraphElement>('title-asset-note');
  private readonly gameOverTitle = el('gameover-title');
  private readonly gameOverCause = el('gameover-cause');
  private readonly gameOverKills = el('gameover-kills');
  private readonly gameOverWave = el('gameover-wave');
  private readonly gameOverTime = el('gameover-time');
  private readonly creditsBody = el('credits-body');
  private readonly settingsNote = el<HTMLParagraphElement>('settings-note');
  private readonly survivorCards = el<HTMLDivElement>('survivor-cards');
  private readonly survivorStatus = el<HTMLParagraphElement>('survivor-status');
  private selectedCharacter: CharacterId | null = null;
  private pendingCharacter: CharacterId | null = null;

  private readonly volumeInput = el<HTMLInputElement>('set-volume');
  private readonly volumeOutput = el<HTMLOutputElement>('out-volume');
  private readonly sensitivityInput = el<HTMLInputElement>('set-sensitivity');
  private readonly sensitivityOutput = el<HTMLOutputElement>('out-sensitivity');
  private readonly qualitySelect = el<HTMLSelectElement>('set-quality');
  private readonly shadowsInput = el<HTMLInputElement>('set-shadows');
  private readonly flashInput = el<HTMLInputElement>('set-flash');
  private readonly debugInput = el<HTMLInputElement>('set-debug');

  private readonly callbacks: MenuCallbacks;
  private readonly pointerOverUiListeners = new Set<(over: boolean) => void>();

  constructor(callbacks: MenuCallbacks) {
    this.callbacks = callbacks;
    this.screens = {
      loading: el('screen-loading'),
      title: el('screen-title'),
      pause: el('screen-pause'),
      gameover: el('screen-gameover'),
      settings: el('screen-settings'),
      controls: el('screen-controls'),
      credits: el('screen-credits'),
    };

    this.wireButtons();
    this.wireSettingsInputs();
    this.buildCharacterCards();
    this.wirePointerTracking();
    this.settingsNote.textContent = `Antialiasing is fixed when the renderer starts; changing quality applies shadows, resolution and prop density immediately, and needs a reload for antialiasing.`;
  }

  private wireButtons(): void {
    el('btn-start').addEventListener('click', () => this.callbacks.onStart());
    el('btn-controls').addEventListener('click', () => this.showScreen('controls'));
    el('btn-settings').addEventListener('click', () => this.callbacks.onOpenSettings());
    el('btn-credits').addEventListener('click', () => this.showScreen('credits'));
    el('btn-controls-back').addEventListener('click', () => this.showScreen('title'));
    el('btn-credits-back').addEventListener('click', () => this.showScreen('title'));

    el('btn-resume').addEventListener('click', () => this.callbacks.onResume());
    el('btn-restart-pause').addEventListener('click', () => this.callbacks.onRestart());
    el('btn-settings-pause').addEventListener('click', () => this.callbacks.onOpenSettings());
    el('btn-exit').addEventListener('click', () => this.callbacks.onExitToTitle());

    el('btn-restart').addEventListener('click', () => this.callbacks.onRestart());
    el('btn-exit-gameover').addEventListener('click', () => this.callbacks.onExitToTitle());
    el('btn-settings-back').addEventListener('click', () => this.callbacks.onCloseSettings());
  }

  private wireSettingsInputs(): void {
    this.volumeInput.addEventListener('input', () => {
      const value = Number(this.volumeInput.value) / 100;
      this.volumeOutput.textContent = `${Math.round(value * 100)}%`;
      this.callbacks.onSettingsChange({ volume: value });
    });
    this.sensitivityInput.addEventListener('input', () => {
      const value = Number(this.sensitivityInput.value) / 100;
      this.sensitivityOutput.textContent = value.toFixed(2);
      this.callbacks.onSettingsChange({ sensitivity: value });
    });
    this.qualitySelect.addEventListener('change', () => {
      const tier = this.qualitySelect.value as QualityTier;
      if (tier in QUALITY_PRESETS) this.callbacks.onQualityChange(tier);
    });
    this.shadowsInput.addEventListener('change', () => {
      this.callbacks.onSettingsChange({ shadows: this.shadowsInput.checked });
    });
    this.flashInput.addEventListener('change', () => {
      this.callbacks.onSettingsChange({ flashEffects: this.flashInput.checked });
    });
    this.debugInput.addEventListener('change', () => {
      this.callbacks.onSettingsChange({ debugOverlay: this.debugInput.checked });
    });
  }


  /**
   * Builds one card per survivor from `CHARACTERS`.
   *
   * Generated instead of hand-written markup so a new character cannot appear in
   * the config without appearing on the screen, and the stat bars are derived
   * from the same numbers the game actually uses.
   */
  private buildCharacterCards(): void {
    this.survivorCards.textContent = '';
    for (const spec of CHARACTERS) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'survivor-card';
      card.dataset.character = spec.id;
      card.setAttribute('role', 'radio');
      card.setAttribute('aria-checked', 'false');
      card.style.setProperty('--card-tint', `#${spec.tint.toString(16).padStart(6, '0')}`);

      const name = document.createElement('span');
      name.className = 'survivor-name';
      name.textContent = spec.name;

      const role = document.createElement('span');
      role.className = 'survivor-role';
      role.textContent = spec.tagline;

      const bars = document.createElement('span');
      bars.className = 'stat-bars';
      const ratings = characterRatings(spec);
      for (const [label, value] of [
        ['SPD', ratings.speed],
        ['TGH', ratings.toughness],
        ['HDL', ratings.handling],
      ] as const) {
        const row = document.createElement('span');
        row.className = 'stat-bar-row';
        const text = document.createElement('span');
        text.textContent = label;
        const bar = document.createElement('span');
        bar.className = 'stat-bar';
        const fill = document.createElement('span');
        fill.style.width = `${Math.round(value * 100)}%`;
        bar.appendChild(fill);
        row.append(text, bar);
        bars.appendChild(row);
      }

      card.append(name, role, bars);
      card.addEventListener('click', () => this.callbacks.onCharacterSelect(spec.id));
      this.survivorCards.appendChild(card);
    }
  }

  /** Highlights the active card and reports whether its model is still loading. */
  paintCharacterSelection(selected: CharacterId, pending: CharacterId | null = null): void {
    this.selectedCharacter = selected;
    this.pendingCharacter = pending;
    for (const card of this.survivorCards.querySelectorAll<HTMLButtonElement>('.survivor-card')) {
      const id = card.dataset.character;
      const isSelected = id === selected;
      card.classList.toggle('is-selected', isSelected);
      card.classList.toggle('is-pending', id === pending);
      card.setAttribute('aria-checked', String(isSelected));
    }
  }

  setCharacterStatus(text: string, tone: 'muted' | 'error' = 'muted'): void {
    this.survivorStatus.textContent = text;
    this.survivorStatus.classList.toggle('error-text', tone === 'error');
  }

  get activeCharacter(): CharacterId | null {
    return this.selectedCharacter;
  }

  get loadingCharacter(): CharacterId | null {
    return this.pendingCharacter;
  }

  /**
   * Tracks whether the pointer is over a menu panel. Values are painted without
   * firing the change callbacks, so binding cannot push a value into a system
   * that does not exist yet.
   */
  private wirePointerTracking(): void {
    for (const screen of Object.values(this.screens)) {
      const panels = screen.querySelectorAll('.panel');
      panels.forEach((panel) => {
        panel.addEventListener('pointerenter', () => this.notifyPointerOverUi(true));
        panel.addEventListener('pointerleave', () => this.notifyPointerOverUi(false));
      });
    }
  }

  onPointerOverUi(listener: (over: boolean) => void): () => void {
    this.pointerOverUiListeners.add(listener);
    return () => this.pointerOverUiListeners.delete(listener);
  }

  private notifyPointerOverUi(over: boolean): void {
    for (const listener of this.pointerOverUiListeners) listener(over);
  }

  get currentScreen(): ScreenName {
    return this.previousScreen;
  }

  showScreen(name: ScreenName): void {
    for (const [key, element] of Object.entries(this.screens)) {
      element.classList.toggle('hidden', key !== name);
    }
    this.previousScreen = name;
    this.notifyPointerOverUi(name !== 'loading' && name !== 'none');
  }

  /** Applies values to the controls without triggering their callbacks. */
  paintSettings(values: {
    volume: number; sensitivity: number; quality: QualityTier;
    shadows: boolean; flashEffects: boolean; debugOverlay: boolean;
  }): void {
    this.volumeInput.value = String(Math.round(values.volume * 100));
    this.volumeOutput.textContent = `${Math.round(values.volume * 100)}%`;
    this.sensitivityInput.value = String(Math.round(values.sensitivity * 100));
    this.sensitivityOutput.textContent = values.sensitivity.toFixed(2);
    this.qualitySelect.value = values.quality in QUALITY_PRESETS ? values.quality : DEFAULT_QUALITY;
    this.shadowsInput.checked = values.shadows;
    this.flashInput.checked = values.flashEffects;
    this.debugInput.checked = values.debugOverlay;
  }

  setLoading(progress: number, status: string): void {
    this.loadingBar.style.width = `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`;
    this.loadingStatus.textContent = status;
  }

  showLoadError(message: string): void {
    this.loadingError.textContent = message;
    this.loadingError.classList.remove('hidden');
  }

  setTitleNote(note: string): void {
    this.titleAssetNote.textContent = note;
  }

  showGameOver(summary: GameOverSummary): void {
    this.gameOverTitle.textContent = 'You died';
    this.gameOverCause.textContent = summary.cause;
    this.gameOverKills.textContent = String(summary.kills);
    this.gameOverWave.textContent = String(summary.wave);
    this.gameOverTime.textContent = formatDuration(summary.survivedSeconds);
    this.showScreen('gameover');
  }

  setCreditsHtml(html: string): void {
    this.creditsBody.innerHTML = html;
  }
}
