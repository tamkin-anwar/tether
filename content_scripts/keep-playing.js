// ---------------------------------------------------------------------------
// Runs in each streaming site's own page context (see manifest.json's
// "world": "MAIN"), at document_start, before the site's own scripts.
//
// Keeps watching together going when you switch to another tab or window.
// A player can listen for the Page Visibility API and pause itself the
// moment its tab is hidden, and for Tether that's worse than for a solo
// viewer: the site's own pause fires a real 'pause' event, which sync-core
// broadcasts, so the other person's show stops too. While a video is
// actually being synced in a room (sync-core sets data-tether-syncing on
// <html>), this reports the page as visible and swallows the visibility
// change, so the site never learns it was hidden. Without that flag,
// browsing behaves exactly as normal, a homepage trailer still pauses when
// you leave.
//
// Pauses you choose still go through: a media key, headphone controls, or
// Chrome's own media controls pause the video directly, not via visibility.
// ---------------------------------------------------------------------------
(function () {
  const syncing = () => document.documentElement?.hasAttribute('data-tether-syncing');
  const visibleValue = {
    hidden: false,
    webkitHidden: false,
    visibilityState: 'visible',
    webkitVisibilityState: 'visible',
  };

  for (const name of Object.keys(visibleValue)) {
    const real = Object.getOwnPropertyDescriptor(Document.prototype, name);
    if (!real || !real.get) continue;
    Object.defineProperty(Document.prototype, name, {
      configurable: true,
      enumerable: real.enumerable,
      get() { return syncing() ? visibleValue[name] : real.get.call(this); },
    });
  }

  // Registered on window in the capture phase before any site script runs,
  // so it's the first listener to see the event, ahead of anything the site
  // attaches to window or document.
  for (const type of ['visibilitychange', 'webkitvisibilitychange']) {
    window.addEventListener(type, (e) => { if (syncing()) e.stopImmediatePropagation(); }, true);
  }
})();
