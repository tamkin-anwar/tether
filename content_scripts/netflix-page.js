// ---------------------------------------------------------------------------
// Runs in Netflix's own page context (see manifest.json's "world": "MAIN"),
// not the isolated world netflix.js/sync-core.js run in, which can't see
// window.netflix at all, that's a page-only global. Talks back to that
// isolated world over plain DOM CustomEvents, the standard bridge for
// reaching a page's own globals from a normal (isolated-world) content
// script.
//
// Why this exists: setting video.currentTime directly, the obvious way to
// seek a native <video> element, is exactly what Netflix's own abuse
// detection flags as a "rapid time skip" and kills playback over with error
// M7375, most often right as the video also gets told to play, a real user
// report against this extension traced to precisely that: a big remote
// catch-up seek immediately followed by .play(). Routing the same seek
// through Netflix's own internal player API instead is recognized as
// legitimate, it's the same call Netflix's own scrubber makes internally.
// Confirmed by checking, not assuming: multiple unrelated extensions that
// also scrub/sync Netflix playback (asbplayer, videospeed) hit this exact
// error and fixed it exactly this way, community-verified as working.
// ---------------------------------------------------------------------------
(function () {
  function getNetflixPlayer() {
    try {
      const api = window.netflix?.appContext?.state?.playerApp?.getAPI?.();
      const videoPlayer = api?.videoPlayer;
      if (!videoPlayer) return null;
      const sessionIds = videoPlayer.getAllPlayerSessionIds?.() || [];
      if (!sessionIds.length) return null;
      // Prefer the actual watch session over just "whichever id is last":
      // a leftover preview/trailer session id can outlive its own player
      // and sit at the end of this list.
      const watchId = sessionIds.find((id) => id.startsWith('watch-')) || sessionIds[sessionIds.length - 1];
      return videoPlayer.getVideoPlayerBySessionId?.(watchId) || null;
    } catch (e) { return null; }
  }

  document.addEventListener('tether-netflix-seek', (e) => {
    try { getNetflixPlayer()?.seek(e.detail); } catch (err) { /* best effort */ }
  });
  document.addEventListener('tether-netflix-play', () => {
    try { getNetflixPlayer()?.play(); } catch (err) { /* best effort */ }
  });
  document.addEventListener('tether-netflix-pause', () => {
    try { getNetflixPlayer()?.pause(); } catch (err) { /* best effort */ }
  });

  // Netflix's own client-capability check for "precise seeking" support:
  // without it reporting true, the internal seek above can fall back to a
  // coarser seek that doesn't land where asked, or trip the same abuse
  // detection anyway. This has to patch Function.prototype.apply itself,
  // page-wide, rather than a specific object, because Netflix's own code
  // calls this through a minified, internal reference with no stable path
  // to target directly; matching on the exact property names it checks for
  // keeps this from touching any other call on the page. Same technique
  // verified working by the other extensions that hit this exact issue.
  const originalApply = Function.prototype.apply;
  Function.prototype.apply = new Proxy(originalApply, {
    apply(target, thisArg, args) {
      if (args && args[1] && typeof args[1][0] === 'string') {
        const property = args[1][0];
        if (property === 'preciseSeeking' || property === 'preciseseeking' || property === 'preciseseekingontwocoredevice') {
          return true;
        }
      }
      return target.call(thisArg, ...args);
    },
  });
})();
