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
  const tr = (key) => chrome.i18n.getMessage(key) || key;
  const DEFAULT_DB_URL = 'https://tether-643cf-default-rtdb.asia-southeast1.firebasedatabase.app';

  // Tells the plain page (join.html's own inline script, which has no way to
  // ask "is an extension installed") that Tether is here and taking over.
  document.documentElement.setAttribute('data-tether-active', 'true');

  // join.html's own text is English (it's a plain web page); once it's
  // there, show its first message in the person's language instead.
  document.addEventListener('DOMContentLoaded', () => {
    const h = document.querySelector('#waitingState h1');
    const p = document.getElementById('joinStatus');
    if (h && h.textContent === 'Connecting to Tether...') h.textContent = tr('joinConnectingTitle');
    if (p && p.textContent === 'Getting you to the right spot.') p.textContent = tr('joinConnecting');
  });

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

  // Same cleanup as the popup's join box: some messaging apps carry a
  // trailing character into a tapped link, which would otherwise join a
  // room that doesn't exist.
  const code = (new URLSearchParams(location.search).get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code) {
    stopSpinner();
    setHeadline(tr('joinInvalidTitle'));
    setStatus(tr('joinInvalid'));
    return;
  }

  chrome.storage.sync.get(['dbUrl'], (stored) => {
    const dbUrl = stored.dbUrl || DEFAULT_DB_URL;
    // Joins the room the same way pasting the code into the popup would,
    // and joins the session: following an invite link is accepting the
    // invite (see sync-core.js), so playback syncs as soon as the video opens.
    chrome.storage.sync.set({ roomId: code });
    const now = Date.now();
    chrome.storage.local.set({ tetherSession: { roomId: code, startedAt: now, lastVideoAt: now } });

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
    // Only to one of the streaming sites Tether works on (the same check as
    // sync-core.js's safeUrl): the room is writable by anyone with its code,
    // and an invite link must never lead somewhere else.
    function safeUrl(url) {
      try {
        const u = new URL(url);
        if (u.protocol !== 'https:') return null;
        if (/(^|\.)(netflix\.com|hulu\.com|disneyplus\.com|crunchyroll\.com|max\.com|hbomax\.com|youtube\.com|primevideo\.com)$/.test(u.hostname)) return u.href;
        if (/^www\.amazon\.(com|co\.uk|de|ca|co\.jp|in|com\.au|fr|it|es)$/.test(u.hostname) && /\/(gp\/video|dp)\//.test(u.pathname)) return u.href;
      } catch (e) { /* not a URL */ }
      return null;
    }
    function tryRedirect() {
      fetch(roomUrl('nowWatching')).then((r) => r.json()).then((data) => {
        const target = data && safeUrl(data.url);
        if (target && isCurrent(data)) {
          location.replace(target);
          return;
        }
        attempts++;
        // Unconditional, not just on the first attempt: a successful
        // response, even an empty one, means the connection is genuinely
        // fine, which should override and self-heal any "having trouble
        // connecting" headline left behind by an earlier transient network
        // error, without needing separate state to track that explicitly.
        setHeadline(tr('joinWaitingTitle'));
        if (attempts >= GIVE_UP_AFTER) {
          stopSpinner();
          setHeadline(tr('joinGaveUpTitle'));
          setStatus(tr('joinGaveUp'));
          return;
        }
        setStatus(tr(attempts < REASSURE_AFTER ? 'joinWaiting' : 'joinStillWaiting'));
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
          setHeadline(tr('joinFailedTitle'));
          setStatus(tr('joinFailed'));
          return;
        }
        setHeadline(tr('joinTroubleTitle'));
        setStatus(tr('joinRetrying'));
        setTimeout(tryRedirect, 3000);
      });
    }
    calibrate().then(tryRedirect);
  });
})();
