/* Screen Wake Lock voor Lessenaar in de iOS-schil (piano-practice-tracker#183, stap 2).
   In een WKWebView houdt navigator.wakeLock het scherm niet op elke iOS-versie aan. Daarom vervangt de schil hem:
   de pagina krijgt dezelfde API, en native zet UIApplication.isIdleTimerDisabled zolang er een lock is.
   Lessenaar vraagt hem bij het openen van de lezer (requestWakeLock) en laat hem los bij het sluiten.
   Berichten naar native: { type: 'wake', id, on }. */
(function (root) {
  'use strict';
  const nav = root.navigator, doc = root.document;
  const wk = root.webkit && root.webkit.messageHandlers && root.webkit.messageHandlers.lessenaarWake;
  if (!nav || !wk) return;
  const post = m => { try { wk.postMessage(m); } catch (e) { /* native weg: niets te doen */ } };

  let next = 0;
  const held = new Set();

  function makeSentinel() {
    const id = ++next;
    const s = new EventTarget();
    let released = false;
    Object.defineProperty(s, 'type', { value: 'screen', enumerable: true });
    Object.defineProperty(s, 'released', { get: () => released, enumerable: true });
    s.onrelease = null;
    s._end = () => {
      if (released) return;
      released = true; held.delete(s);
      post({ type: 'wake', id, on: false });
      const ev = new Event('release');
      if (typeof s.onrelease === 'function') s.onrelease(ev);
      s.dispatchEvent(ev);
    };
    s.release = () => { s._end(); return Promise.resolve(); };
    held.add(s);
    post({ type: 'wake', id, on: true });
    return s;
  }

  function releaseAll() { for (const s of [...held]) s._end(); }

  const wakeLock = {
    request(type) {
      if (type !== undefined && type !== 'screen') {
        return Promise.reject(new TypeError("WakeLock: alleen 'screen'"));
      }
      // Zoals de browser: op een verborgen pagina geen lock.
      if (doc && doc.visibilityState === 'hidden') {
        return Promise.reject(new DOMException('Pagina is niet zichtbaar', 'NotAllowedError'));
      }
      return Promise.resolve(makeSentinel());
    },
  };
  Object.defineProperty(nav, 'wakeLock', { value: wakeLock, configurable: true, enumerable: true });

  // Zoals de browser: naar de achtergrond = alle locks los. Lessenaar vraagt opnieuw bij terugkomst.
  if (doc) doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'hidden') releaseAll(); });

  Object.defineProperty(root, '__lessenaarWake', { value: { releaseAll, held: () => held.size } });
})(typeof window !== 'undefined' ? window : globalThis);
