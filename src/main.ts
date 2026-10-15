import './styles/main.css';
import { Game } from './app/Game';

declare global {
  interface Window {
    /** Set by bootstrap(); used by the headless smoke test. */
    deadDistrict?: Game;
  }
}

/**
 * Bootstrap only: find the canvas, create the game, start it.
 * All game logic lives in src/app/Game.ts and the systems it owns.
 */
async function bootstrap(): Promise<void> {
  const canvas = document.getElementById('game-canvas');
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error('#game-canvas is missing from index.html');
  }

  const game = new Game({ canvas });
  try {
    await game.init();
  } catch (error) {
    // A boot failure must be visible, not a black screen.
    const message = error instanceof Error ? error.message : String(error);
    console.error('[boot] failed', error);
    const status = document.getElementById('loading-status');
    const errorText = document.getElementById('loading-error');
    if (status) status.textContent = 'Startup failed';
    if (errorText) {
      errorText.textContent = message;
      errorText.classList.remove('hidden');
    }
    document.getElementById('screen-loading')?.classList.remove('hidden');
    return;
  }

  // Automation hook: tools/smoke.mjs drives the game through this object because
  // headless Chrome does not reliably run requestAnimationFrame.
  window.deadDistrict = game;

  // Dev-server convenience: HMR replaces the module, so release the old instance
  // instead of leaving a second game running with its own listeners.
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      game.dispose();
      delete window.deadDistrict;
    });
  }
}

void bootstrap();
