// ---------------------------------------------------------------------------
// Runs in Disney+'s own page context (see manifest.json's "world": "MAIN"),
// not the isolated world disneyplus.js/sync-core.js run in, which can't see
// this custom element's own JS properties, only its DOM structure. Talks
// back to that isolated world over plain DOM CustomEvents, the same bridge
// netflix-page.js uses for the same reason.
//
// Why this exists, and why it's not just the Netflix fix again: Disney+'s
// <video> element isn't just unsafe to seek directly, it's unsafe to even
// read from. After a seek, Disney+ rebuilds its media source buffer and
// video.currentTime restarts near zero while the player's own
// timeline.info.playheadPositionMs keeps counting true content time
// (duration is also reported as Infinity on the element). So unlike
// Netflix, this has to override both writing AND reading position, not
// just writing.
//
// The player itself is reachable far more simply than Netflix's: Disney+
// hangs it directly as a `.mediaPlayer` property on the <disney-web-player>
// custom element, no internal session-id lookup or React-internals walk
// needed. That specific element/property shape isn't something this
// extension can verify against a live account in its own test setup, only
// documented and cross-checked against an independent, actively maintained
// watch-together project that verified it directly against a real title
// page; treat this as a best-effort implementation until confirmed against
// an actual Disney+ session.
// ---------------------------------------------------------------------------
(function () {
  function getPlayer() {
    try {
      return document.querySelector('disney-web-player')?.mediaPlayer || null;
    } catch (e) { return null; }
  }
  function getUiState() {
    try {
      return document.querySelector('disney-web-player-ui')?.latestUiState || null;
    } catch (e) { return null; }
  }

  document.addEventListener('tether-disneyplus-query', () => {
    const player = getPlayer();
    const info = player?.timeline?.info;
    const status = player?.playbackStatus;
    const ui = getUiState();
    const detail = (info && status)
      ? {
          currentTimeMs: typeof info.playheadPositionMs === 'number' ? info.playheadPositionMs : null,
          playing: !!status.playing && !status.paused && !status.ended,
          adPlaying: !!ui?.interstitials?.isInterstitialPlaying,
        }
      : { currentTimeMs: null, playing: null, adPlaying: !!ui?.interstitials?.isInterstitialPlaying };
    document.dispatchEvent(new CustomEvent('tether-disneyplus-state', { detail }));
  });

  document.addEventListener('tether-disneyplus-seek', (e) => {
    try { getPlayer()?.seek?.(e.detail); } catch (err) { /* best effort */ }
  });
  document.addEventListener('tether-disneyplus-play', () => {
    try { getPlayer()?.play?.(); } catch (err) { /* best effort */ }
  });
  document.addEventListener('tether-disneyplus-pause', () => {
    try { getPlayer()?.pause?.(); } catch (err) { /* best effort */ }
  });
})();
