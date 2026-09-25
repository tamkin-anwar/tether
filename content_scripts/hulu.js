// ---------------------------------------------------------------------------
// Hulu adapter. See site-common.js for the shared logic; this just says how
// to find Hulu's video element.
// ---------------------------------------------------------------------------

window.TetherSite.start(function findVideo() {
  // Only the player page, never a browse-page preview (see netflix.js).
  if (!location.pathname.includes('/watch/')) return null;
  // Same approach as Netflix: Hulu also renders a single <video> element
  // while watching, and no class/id there is stable across their redesigns
  // either, so take the first (and normally only) one on the page.
  return document.querySelector('video');
});
