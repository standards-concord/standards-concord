const APP_VERSION: string = import.meta.env.VITE_APP_VERSION;

// Use the same worker/update lifecycle as main.tsx: install in the background, skipWaiting, claim.
export async function reloadApp() {
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    await registration?.update();
    const worker = registration?.installing ?? registration?.waiting;
    if (worker && worker.state !== 'activated' && worker.state !== 'redundant') {
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); worker.removeEventListener('statechange', changed); resolve(); };
        const changed = () => { if (worker.state === 'activated' || worker.state === 'redundant') done(); };
        const timer = setTimeout(done, 3000);
        worker.addEventListener('statechange', changed);
        changed();
      });
    }
  } catch { /* Offline or no worker: a document reload can still recover a failed module fetch. */ }
  window.location.reload();
}

/** A broken deployment gets one automatic reload per build, even if it fails again afterwards. */
export function reloadForChunkFailure() {
  if (!navigator.onLine) return;
  const key = `concord.chunkReload.${APP_VERSION}.${import.meta.env.VITE_APP_COMMIT || 'local'}`;
  try {
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');
  } catch {
    // Without persistent guarding, an automatic reload could loop. Leave Retry available instead.
    return;
  }
  void reloadApp();
}
