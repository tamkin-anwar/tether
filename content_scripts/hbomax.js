// ---------------------------------------------------------------------------
// HBO Max (now branded just "Max", still on both max.com and the legacy
// hbomax.com domain) adapter. See site-common.js for the shared logic; this
// just says how to find its video element.
// ---------------------------------------------------------------------------

window.TetherSite.start(function findVideo() {
  // Only the player page (play.max.com/video/watch/...), never the home
  // page's autoplaying hero trailer (see netflix.js).
  if (!location.pathname.includes('/watch/')) return null;
  // Same defensive approach as Disney+ and Crunchyroll: prefer the largest
  // on-screen <video> rather than assuming there's only ever one, since a
  // player can keep a hidden or background element around (a quality
  // variant, a muted autoplay preview) alongside the real one.
  const videos = document.querySelectorAll('video');
  if (videos.length <= 1) return videos[0] || null;
  return [...videos].sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
});
