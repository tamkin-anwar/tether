// ---------------------------------------------------------------------------
// Runs only on tether's own join page (see manifest.json), not on any
// streaming site. A join link looks like
// https://tamkin-anwar.github.io/tether/join.html?code=XXXXXX and this is
// what turns "clicked a link" into "landed on the exact title", the same
// one-click flow Teleparty's own links use, instead of the older path of
// opening the popup and pasting a code in by hand (which still works fine
// as a fallback, this is just no longer the only way in).
// ---------------------------------------------------------------------------

(function () {
  const DEFAULT_DB_URL = 'https://tether-643cf-default-rtdb.asia-southeast1.firebasedatabase.app';

  // Tells the plain page (join.html's own inline script, which has no way to
  // ask "is an extension installed") that Tether is here and taking over.
  document.documentElement.setAttribute('data-tether-active', 'true');

  function setStatus(text) {
    const el = document.getElementById('joinStatus');
    if (el) el.textContent = text;
  }
  function setHeadline(text) {
    const el = document.querySelector('#waitingState h1');
    if (el) el.textContent = text;
  }

  const code = (new URLSearchParams(location.search).get('code') || '').trim().toUpperCase();
  if (!code) {
    setStatus("This link is missing a room code.");
    return;
  }

  chrome.storage.sync.get(['dbUrl'], (stored) => {
    const dbUrl = stored.dbUrl || DEFAULT_DB_URL;
    // Joins the room the same way pasting the code into the popup would.
    chrome.storage.sync.set({ roomId: code });

    function roomUrl(path) {
      return `${dbUrl.replace(/\/$/, '')}/rooms/${encodeURIComponent(code)}/${path}.json`;
    }

    // Polling rather than an open stream: this page's entire job is done the
    // instant it redirects, so there's nothing worth keeping a connection
    // alive for.
    //
    // No cap here would leave someone staring at "waiting..." forever if the
    // other person never presses play, with no explanation and no way out.
    // After a stretch, reassure them they're already in the room (the code
    // above already joined it) and that opening the service themselves works
    // fine too, they'll catch up automatically the moment the other person
    // does start playing. After a much longer stretch, stop polling outright
    // rather than running an abandoned tab's network requests indefinitely.
    let attempts = 0;
    const REASSURE_AFTER = 10;   // ~20-25s
    const GIVE_UP_AFTER = 200;   // ~10 minutes
    function tryRedirect() {
      fetch(roomUrl('nowWatching')).then((r) => r.json()).then((data) => {
        if (data && data.url) {
          location.replace(data.url);
          return;
        }
        attempts++;
        if (attempts === 1) setHeadline("Waiting on them");
        if (attempts >= GIVE_UP_AFTER) {
          setStatus("Still nothing yet. Refresh this page once they've pressed play, or just open the service yourselves, you're already in the room.");
          return;
        }
        setStatus(attempts < REASSURE_AFTER
          ? "Waiting for the other person to start watching..."
          : "Still waiting. You're already in the room, so feel free to open Netflix (or whichever you're both using) yourself whenever you're ready.");
        setTimeout(tryRedirect, 2000);
      }).catch(() => setTimeout(tryRedirect, 3000));
    }
    tryRedirect();
  });
})();
