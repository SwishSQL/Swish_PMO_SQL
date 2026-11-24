// After a new version is deployed, a page that was already open (the sign-in page left open, say) still asks for the
// old version's files, which are gone. Loading the new version once fixes it, so that is done by itself; a second
// failure in the same few seconds is a real error and is shown instead (no reload loop).

const KEY = 'pmo.reloadedForNewVersion';

/** Load the new version once. Returns false when that was already tried just now. */
export function reloadForNewVersion(): boolean {
  try {
    if (sessionStorage.getItem(KEY)) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

/** A page loaded on first use: if its file is gone (a new version), load the new version. */
export function lazyPage<T>(load: () => Promise<T>): () => Promise<T> {
  return () =>
    load().catch((e) => {
      // While the page reloads, keep waiting rather than flashing an error.
      if (reloadForNewVersion()) return new Promise<T>(() => undefined);
      throw e;
    });
}

export function installFreshVersion(): void {
  // Any other file loaded on demand (Vite reports these).
  window.addEventListener('vite:preloadError', (e) => {
    if (reloadForNewVersion()) e.preventDefault();
  });
  // This version loaded fine: a later new version may reload once again.
  window.setTimeout(() => {
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      /* nothing kept */
    }
  }, 10_000);
}
