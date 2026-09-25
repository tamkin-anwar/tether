// ---------------------------------------------------------------------------
// Crunchyroll adapter. See site-common.js for the shared logic; this just
// says how to find Crunchyroll's video element.
// ---------------------------------------------------------------------------

window.TetherSite.start(function findVideo() {
  // Only the player page, never a browse-page preview (see netflix.js).
  if (!location.pathname.includes('/watch/')) return null;
  // Same defensive approach as Disney+: Crunchyroll's player can have more
  // than one <video> element on screen (a free-tier ad, an autoplay-next
  // preview), so prefer the largest on-screen one rather than assuming
  // there's only ever a single element.
  const videos = document.querySelectorAll('video');
  if (videos.length <= 1) return videos[0] || null;
  return [...videos].sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
});
