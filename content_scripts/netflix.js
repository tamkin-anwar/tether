// ---------------------------------------------------------------------------
// Netflix adapter. See site-common.js for the shared logic; this just says
// how to find Netflix's video element.
// ---------------------------------------------------------------------------

window.TetherSite.start(function findVideo() {
  // Netflix's player renders a single <video> element while watching.
  // No stable id/class is guaranteed across Netflix's own redesigns, so
  // just take the first (and normally only) <video> on the page.
  return document.querySelector('video');
}, {
  // Directing a remote catch-up through Netflix's own internal player API
  // (see netflix-page.js, the only thing that can actually reach it) rather
  // than setting video.currentTime directly, which Netflix's own abuse
  // detection can flag as a "rapid time skip" and kill playback over with
  // error M7375.
  seek(seconds) { document.dispatchEvent(new CustomEvent('tether-netflix-seek', { detail: seconds * 1000 })); },
  play() { document.dispatchEvent(new CustomEvent('tether-netflix-play')); },
  pause() { document.dispatchEvent(new CustomEvent('tether-netflix-pause')); },
});
