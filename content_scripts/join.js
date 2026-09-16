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
    function tryRedirect() {
      fetch(roomUrl('nowWatching')).then((r) => r.json()).then((data) => {
        if (data && data.url) {
          location.replace(data.url);
        } else {
          setStatus("Waiting for the other person to start watching...");
          setTimeout(tryRedirect, 2000);
        }
      }).catch(() => setTimeout(tryRedirect, 3000));
    }
    tryRedirect();
  });
})();
