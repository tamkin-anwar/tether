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
  // The spinner means "actively working on it". Leaving it running in a
  // state where nothing further is going to happen, a dead link, giving up
  // after minutes of nobody pressing play, reads as still-in-progress when
  // it's actually a dead end, exactly the kind of thing that makes someone
  // sit there waiting on something that already stopped.
  function stopSpinner() {
    const el = document.querySelector('#waitingState .spinner');
    if (el) el.style.display = 'none';
  }

  const code = (new URLSearchParams(location.search).get('code') || '').trim().toUpperCase();
  if (!code) {
    stopSpinner();
    setHeadline("This link isn't valid");
    setStatus("It's missing a room code. Ask whoever sent it for a fresh invite link.");
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
    // nowWatching is refreshed every 5s while someone's actually on a player
    // page (see sync-core.js), so anything older than a few missed beats is
    // left over from an earlier session, not where they are now.
    const FRESH_MS = 20000;
    // Same server-clock trick sync-core.js uses: the timestamp being checked
    // is the server's, so "how old is it" has to be measured on that clock
    // too, not this device's. null if calibration fails, in which case the
    // freshness check is skipped rather than blocking the join outright.
    let serverOffsetMs = null;
    function calibrate() {
      const t0 = Date.now();
      let t1 = 0;
      return fetch(roomUrl('_clock'), { method: 'PUT', body: JSON.stringify({ '.sv': 'timestamp' }) })
        .then((r) => { t1 = Date.now(); return r.json(); })
        .then((serverTime) => {
          if (typeof serverTime === 'number') serverOffsetMs = (serverTime + (t1 - t0) / 2) - t1;
        })
        .catch(() => {});
    }
    function isCurrent(data) {
      // Written by a version that doesn't refresh it: no way to tell, so
      // trust it, the same as before this check existed.
      if (!data.live || typeof data.ts !== 'number' || serverOffsetMs === null) return true;
      return (Date.now() + serverOffsetMs) - data.ts < FRESH_MS;
    }
    function tryRedirect() {
      fetch(roomUrl('nowWatching')).then((r) => r.json()).then((data) => {
        if (data && data.url && isCurrent(data)) {
          location.replace(data.url);
          return;
        }
        attempts++;
        // Unconditional, not just on the first attempt: a successful
        // response, even an empty one, means the connection is genuinely
        // fine, which should override and self-heal any "having trouble
        // connecting" headline left behind by an earlier transient network
        // error, without needing separate state to track that explicitly.
        setHeadline("Waiting on them");
        if (attempts >= GIVE_UP_AFTER) {
          stopSpinner();
          setHeadline("Still nothing yet");
          setStatus("Refresh this page once they've pressed play, or just open the service yourselves, you're already in the room.");
          return;
        }
        setStatus(attempts < REASSURE_AFTER
          ? "Waiting for the other person to start watching..."
          : "Still waiting. You're already in the room, so feel free to open Netflix (or whichever you're both using) yourself whenever you're ready.");
        setTimeout(tryRedirect, 2000);
      }).catch(() => {
        // A genuine network failure, not just "no data yet" (blocked by an
        // ad-blocker, offline, DNS trouble). Without its own counter and
        // status, this fell through silently forever: attempts never
        // advanced, so it never reassured or gave up, just kept retrying
        // behind whatever the original static "Getting you to the right
        // spot." text said, with no sign anything was actually wrong.
        attempts++;
        if (attempts >= GIVE_UP_AFTER) {
          stopSpinner();
          setHeadline("Something's not connecting");
          setStatus("Refresh this page, or just open the service yourselves, you're already in the room.");
          return;
        }
        setHeadline("Having trouble connecting");
        setStatus("Retrying...");
        setTimeout(tryRedirect, 3000);
      });
    }
    calibrate().then(tryRedirect);
  });
})();
