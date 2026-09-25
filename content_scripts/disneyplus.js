// ---------------------------------------------------------------------------
// Disney+ adapter. See site-common.js for the shared logic; this just says
// how to find Disney+'s video element, and (see disneyplus-page.js) how to
// read and control the real one through Disney+'s own player instead of the
// <video> element, which isn't safe to seek OR read position from here.
// ---------------------------------------------------------------------------

(function () {
  // Set by disneyplus-page.js's response to a query, dispatched and read
  // back within the same synchronous call below: dispatchEvent() runs every
  // listener before returning, so the MAIN-world listener's own dispatch of
  // the response event fires this one before queryState() returns.
  let lastState = null;
  document.addEventListener('tether-disneyplus-state', (e) => { lastState = e.detail; });

  function queryState() {
    lastState = null;
    document.dispatchEvent(new CustomEvent('tether-disneyplus-query'));
    return lastState;
  }

  window.TetherSite.start(function findVideo() {
    // Only the player page, never a browse-page preview (see netflix.js).
    // Disney+ has used both /video/<id> and the newer /play/<id>, sometimes
    // behind a locale prefix.
    if (!/\/(video|play)\//.test(location.pathname)) return null;
    // Same starting approach as Netflix and Hulu. Disney+ has been known to
    // occasionally keep more than one <video> element around (a background
    // trailer, for instance), so if sync ever seems to grab the wrong one
    // here, prefer the largest on-screen video instead of just the first.
    const videos = document.querySelectorAll('video');
    if (videos.length <= 1) return videos[0] || null;
    return [...videos].sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
  }, {
    seek(seconds) { document.dispatchEvent(new CustomEvent('tether-disneyplus-seek', { detail: seconds * 1000 })); },
    play() { document.dispatchEvent(new CustomEvent('tether-disneyplus-play')); },
    pause() { document.dispatchEvent(new CustomEvent('tether-disneyplus-pause')); },
    // These three are what set Disney+ apart from Netflix: reading
    // video.currentTime here isn't just imprecise, it's actively wrong
    // after a seek (see disneyplus-page.js), so sync-core.js needs a real
    // position/playing state from somewhere else too, not just a safer way
    // to write one.
    getCurrentTime() {
      const s = queryState();
      return (s && typeof s.currentTimeMs === 'number') ? s.currentTimeMs / 1000 : null;
    },
    getPlaying() {
      const s = queryState();
      return (s && typeof s.playing === 'boolean') ? s.playing : null;
    },
    isAdPlaying() {
      const s = queryState();
      return s ? !!s.adPlaying : null;
    },
  });
})();
