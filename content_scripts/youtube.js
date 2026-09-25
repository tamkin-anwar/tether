// ---------------------------------------------------------------------------
// YouTube adapter. See site-common.js for the shared logic; this just says
// how to find YouTube's video element.
// ---------------------------------------------------------------------------

window.TetherSite.start(function findVideo() {
  // Only an actual watch page. The home page and search results play inline
  // previews on hover in real <video> elements (see netflix.js for why
  // attaching to one of those is actively harmful), and Shorts loop.
  if (location.pathname !== '/watch') return null;
  // YouTube reuses the same <video> element for both the actual video and
  // any pre-roll/mid-roll ad, so unlike Disney+/Crunchyroll/Max there's no
  // separate ad element to worry about. It does still have other, unrelated
  // <video> elements on a typical page though (thumbnail hover previews, a
  // Shorts shelf in the sidebar), so prefer the largest on-screen one rather
  // than just the first, same defensive approach as those other adapters.
  const videos = document.querySelectorAll('video');
  if (videos.length <= 1) return videos[0] || null;
  return [...videos].sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
});
