// ---------------------------------------------------------------------------
// YouTube adapter. See site-common.js for the shared logic; this just says
// how to find YouTube's video element.
//
// YouTube needs less special handling than it looks like it should, because
// sync-core.js already covers the parts that are unusual about it:
// - It keeps one <video> element for every video you watch, swapping only
//   its source, so moving to the next video never re-attaches anything.
//   checkDrift notices the new video id (contentKey) and catches up to the
//   other person from there.
// - Ads play in that same element, with the player marked ad-showing while
//   they do (looksLikeAd), and pushes wait a beat (schedulePush) so the
//   moment an ad swaps in never gets sent as the shared position.
// - Live streams have no shared timeline, so only play and pause sync on
//   them (isLive).
// - Playback speed syncs, so 1.5x on one side doesn't fight drift
//   correction on the other.
// ---------------------------------------------------------------------------

window.TetherSite.start(function findVideo() {
  // Only an actual watch page. The home page and search results play inline
  // previews on hover in real <video> elements (see netflix.js for why
  // attaching to one of those is actively harmful), and Shorts loop.
  if (location.pathname !== '/watch') return null;
  // The main player's own element, by the class YouTube has given it for
  // years. Everything else on a watch page that's a <video> (hover previews
  // in the sidebar, a Shorts shelf) lives outside #movie_player.
  const main = document.querySelector('#movie_player video.html5-main-video') ||
    document.querySelector('#movie_player video');
  if (main) return main;
  // Fallback if that ever changes: the largest on-screen video.
  const videos = document.querySelectorAll('video');
  if (videos.length <= 1) return videos[0] || null;
  return [...videos].sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
});
