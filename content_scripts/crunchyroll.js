// ---------------------------------------------------------------------------
// Crunchyroll adapter. See site-common.js for the shared logic.
//
// Crunchyroll's player isn't part of the page: it's a frame of its own from
// static.crunchyroll.com (its "vilos" player), with the <video> inside it.
// So Tether runs in two places here:
// - Inside the player frame, where the video is. That's where syncing, and
//   everything drawn over the video, happens.
// - On the page around it, which knows which episode this is (the frame's
//   own address is the same player page for every episode). It tells the
//   frame, and keeps its own buttons out of the way on a watch page.
// ---------------------------------------------------------------------------

(function () {
  if (location.hostname === 'static.crunchyroll.com') {
    let pageUrl = null;
    window.addEventListener('message', (e) => {
      if (!/^https:\/\/(www\.)?crunchyroll\.com$/.test(e.origin)) return;
      const url = e.data && e.data.tetherPageUrl;
      if (typeof url === 'string' && url.includes('/watch/')) pageUrl = url;
    });
    window.TetherSite.start(function findVideo() {
      // Not until the page has said which episode this is: a position sent
      // without that couldn't be told apart from any other episode's.
      if (!pageUrl) return null;
      // A free-tier ad or an up-next preview can sit alongside the episode;
      // the largest on screen is the one being watched.
      const videos = document.querySelectorAll('video');
      if (videos.length <= 1) return videos[0] || null;
      return [...videos].sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
    }, { pageUrl: () => pageUrl });
    return;
  }

  const onWatchPage = () => location.pathname.includes('/watch/');
  setInterval(() => {
    if (onWatchPage()) {
      const frame = document.querySelector('iframe[src*="static.crunchyroll.com/vilos"]');
      if (frame && frame.contentWindow) {
        frame.contentWindow.postMessage({ tetherPageUrl: location.href }, 'https://static.crunchyroll.com');
      }
    }
    // On a watch page the player frame shows the invite and everything else.
    const overlay = document.querySelector('[data-tether-overlay]');
    if (overlay) overlay.style.display = onWatchPage() ? 'none' : '';
  }, 500);
  // Browse pages: no video here, but the offer to join the other person's
  // session still shows up.
  window.TetherSite.start(() => null);
})();
