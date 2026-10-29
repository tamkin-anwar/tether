// ---------------------------------------------------------------------------
// Tether sync core. Shared by every site-specific adapter (netflix.js, etc).
//
// Talks to Firebase Realtime Database over plain REST plus the RTDB
// streaming API (Server-Sent Events on a .json endpoint), not the Firebase
// SDK. That keeps the extension dependency-free and avoids Manifest V3's
// restrictions on remote code in content scripts. This is just fetch() and
// EventSource, both native.
//
// A note on why sync lives in each content script rather than the background
// service worker: MV3 service workers get suspended after ~30s of
// inactivity, which would silently kill a long-lived EventSource stream.
// Content scripts stay alive for as long as the tab is open on a matching
// page, which is exactly the lifetime a "watch together" connection needs.
// ---------------------------------------------------------------------------

(function () {
  // Same shared database baked into the popup (see popup.js). Falls back to
  // this if the popup has never been opened on this install yet, so
  // playback sync still works the moment two people share a room code.
  const DEFAULT_DB_URL = 'https://tether-643cf-default-rtdb.asia-southeast1.firebasedatabase.app';

  // Resolved once, from storage, before anything else runs (see resolveClientId
  // below). Shared with the popup's own copy of this same logic so that a
  // presence entry written from either place is recognizable as "me", not
  // mistaken for a second person in the room.
  let CLIENT_ID = null;
  // Unlike CLIENT_ID (chrome.storage.local, one per install), this lives in
  // chrome.storage.sync, so it's shared by every browser Chrome signs into
  // the same account, matching the popup's own copy of this (see popup.js).
  // Written so that a laptop actively watching here and a desktop's popup
  // checking presence can recognize each other as the same person, not a
  // second person in the room, purely from clientId they'd look identical
  // to an actual partner.
  let OWNER_ID = null;
  const APPLY_REMOTE_GUARD_MS = 400; // suppress re-broadcasting a change we just applied ourselves
  const DRIFT_CHECK_MS = 1000;
  // How tightly playback is held together. Within PRECISION_S, nothing
  // happens. Beyond it and up to SEEK_LIMIT_S, the gap is closed by playing a
  // few percent faster or slower for a moment (see nudge), which nobody
  // watching can see or hear. Only past SEEK_LIMIT_S is it a seek, which
  // rebuffers and visibly jumps. Sites can loosen both (Prime, see prime.js).
  const PRECISION_S = 0.06;
  const SEEK_LIMIT_S = 1.0;
  // How far off an incoming update (the other person pressing play, pause or
  // seeking) has to be to seek right then rather than leave it to the
  // nudging above. Paused, it's the exact frame you're both looking at, and
  // there's no nudging a paused video, so that's held much tighter.
  const SEEK_THRESHOLD_PLAYING_S = 0.35;
  const SEEK_THRESHOLD_PAUSED_S = 0.15;
  const PUSH_SETTLE_MS = 120;     // see schedulePush
  const CLOCK_RECALIBRATE_MS = 60000;
  const PRESENCE_HEARTBEAT_MS = 5000;
  const STALE_CHECK_MS = 20000;
  const STALE_AFTER_MS = 45000; // no server activity at all in this long is treated as a dead connection

  // Ad-supported tiers (Netflix, Hulu, Disney+, Max, and Crunchyroll all sell
  // one now) break sync in a specific way: an ad break's own play/pause/seek
  // has nothing to do with where the two of you actually are in the episode,
  // and the two of you almost never see the same ads or the same number of
  // them, so broadcasting or applying position based on one is actively
  // wrong, not just imprecise. There's no single reliable "is an ad playing"
  // signal across five different players whose DOM changes on their own
  // schedule (see the site adapters' own comments on exactly this problem
  // for findVideo), so this leans on two independent, more durable signals
  // instead of a guessed class name per site: a suspiciously short video
  // appearing in the middle of an already long-form one (real ad breaks
  // are seconds to a couple minutes; a movie or episode isn't), and, on
  // YouTube specifically, the `ad-showing`/`ad-interrupting` classes
  // YouTube's own player has added to its container for years, stable
  // enough that ad-blocking extensions have relied on it for about as long.
  const AD_LIKE_MAX_DURATION_S = 121;
  let baselineDuration = null; // longest real (non-ad-like) duration seen on the current page, the "this is what long-form looks like" reference point
  let baselineUrl = null;      // which page that baseline belongs to

  // When an ad ends, the player puts the show back where it stopped, and
  // that fires the same seeked/play events as you seeking yourself would.
  // Pushed, they sent the position from before the ad as if it were new and
  // pulled the other person back to it, undoing however far they'd watched
  // in the meantime. For a moment after an ad, this side only catches up
  // (see checkDrift) and never pushes.
  const AD_RESUME_QUIET_MS = 2500;
  let lastAdSignal = false;
  let adEndedAt = 0;
  function looksLikeAd() {
    const ad = adSignal();
    if (lastAdSignal && !ad) adEndedAt = Date.now();
    lastAdSignal = ad;
    return ad;
  }
  function justLeftAd() {
    return Date.now() - adEndedAt < AD_RESUME_QUIET_MS;
  }

  function adSignal() {
    if (!video) return false;
    // A site that can tell us directly (currently just Disney+, via its own
    // ad-interstitial flag; see disneyplus.js) beats guessing from duration.
    if (siteControls?.isAdPlaying) {
      const known = siteControls.isAdPlaying();
      if (known != null) return known;
    }
    // Ads play within the same page (see writeNowWatching below, an ad
    // break never changes location.href, only an actual switch to
    // different content does, even in a same-page SPA nav). Without this,
    // finishing a long movie and then deliberately switching to something
    // short next, a trailer, a music video, would carry the old baseline
    // over and mistake that new, genuinely-short video for an ad
    // interrupting the last one, and never sync it at all.
    if (pageUrl() !== baselineUrl) {
      baselineDuration = null;
      baselineUrl = pageUrl();
    }
    const ytPlayer = document.getElementById('movie_player');
    if (ytPlayer && (ytPlayer.classList.contains('ad-showing') || ytPlayer.classList.contains('ad-interrupting'))) return true;
    const d = video.duration;
    if (!Number.isFinite(d) || d <= 0) return false;
    if (d > AD_LIKE_MAX_DURATION_S) { baselineDuration = d; return false; }
    // A short video on its own isn't suspicious, a trailer or a music video
    // is completely normal to watch together start to finish. It only reads
    // as an ad once something noticeably longer was already the thing being
    // watched, on this same page, a sudden dip in the middle of that.
    return baselineDuration !== null && baselineDuration > AD_LIKE_MAX_DURATION_S;
  }

  // A site that can't be read from through its <video> element at all
  // (currently just Disney+, see disneyplus.js/disneyplus-page.js: after a
  // seek there, video.currentTime restarts near zero while the player's own
  // clock keeps counting true position) provides these; everything else
  // falls back to the element directly, unchanged.
  function currentTimeSeconds() {
    if (siteControls?.getCurrentTime) {
      const t = siteControls.getCurrentTime();
      if (t != null) return t;
    }
    return video ? video.currentTime : null;
  }
  function isPlayingNow() {
    if (siteControls?.getPlaying) {
      const p = siteControls.getPlaying();
      if (p != null) return p;
    }
    return video ? !video.paused : null;
  }

  let config = null;       // { roomId, dbUrl }
  // A locally-remembered display name, not an account (see popup.js for the
  // input this comes from). Both this file and the popup write the same
  // presence/$CLIENT_ID node, and this one heartbeats far more often (every
  // 5s, for as long as a streaming tab stays open, versus only while the
  // popup happens to be open), so if this copy didn't also know the
  // nickname, its next heartbeat would almost immediately overwrite the
  // popup's name-inclusive entry with a nameless one.
  let nickname = '';
  // Set only by site adapters that need it (currently Netflix and Disney+;
  // see netflix.js/disneyplus.js): { seek(seconds), play(), pause(), and
  // optionally getCurrentTime()/getPlaying()/isAdPlaying() for a site where
  // even reading the <video> element isn't reliable, see currentTimeSeconds/
  // isPlayingNow/looksLikeAd above }. When present, reads and remote
  // catch-ups are routed through this instead of touching video directly.
  let siteControls = null;
  let video = null;
  let es = null;            // EventSource
  let reactionsEs = null;   // separate EventSource: reactions are rare enough that folding them into the sync stream's put/patch parsing wasn't worth the added complexity there
  let remoteGuards = 0;     // how many remote changes are still settling (see withRemoteGuard)
  let lastRemote = null;    // { time, ts, playing }, used for drift correction
  let lastEventAt = 0;      // Date.now() of the last thing heard from the server, any kind
  let driftTimer = null;
  let clockTimer = null;
  let presenceTimer = null;
  let staleCheckTimer = null;
  let serverOffsetMs = 0;   // add to localNow() to estimate the Firebase server's clock (see calibrateClock)
  let onStatus = () => {};  // callback(status: 'connected'|'disconnected'|'no-room')
  let onReaction = () => {}; // callback(emoji), only for a reaction that arrived from the other person
  let chatEs = null;
  // Everything else the on-page UI (site-common.js) listens for: 'chat'
  // (the newest messages), 'action' (the other person played, paused,
  // skipped or changed speed), 'elsewhere' (they're on a different title).
  const listeners = {};
  function emit(name, detail) {
    for (const fn of listeners[name] || []) { try { fn(detail); } catch (e) { /* one bad listener can't break sync */ } }
  }

  function log(...args) { console.log('[Tether]', ...args); }

  // A random ID regenerated on every page load would make it impossible to
  // tell "my own other tab" apart from "the other person" in the presence
  // list, so this is persisted once per browser profile instead.
  function resolveClientId(cb) {
    chrome.storage.local.get(['clientId'], (stored) => {
      if (stored.clientId) { CLIENT_ID = stored.clientId; cb(); return; }
      CLIENT_ID = 'u_' + Math.random().toString(36).slice(2, 10);
      chrome.storage.local.set({ clientId: CLIENT_ID }, cb);
    });
  }

  function resolveOwnerId(cb) {
    chrome.storage.sync.get(['ownerId'], (stored) => {
      if (stored.ownerId) { OWNER_ID = stored.ownerId; cb(); return; }
      OWNER_ID = 'o_' + Math.random().toString(36).slice(2, 10);
      chrome.storage.sync.set({ ownerId: OWNER_ID }, cb);
    });
  }

  function roomUrl(path) {
    return `${config.dbUrl.replace(/\/$/, '')}/rooms/${encodeURIComponent(config.roomId)}/${path}.json`;
  }

  // Over a long-distance connection, the two devices' own clocks can easily
  // be a few hundred ms apart, enough to matter for tight sync. Rather than
  // trust each device's local clock, calibrate once against the shared
  // Firebase server's clock (the same NTP-style trick used for any
  // low-latency sync): write a server-timestamp placeholder, see what the
  // server resolved it to, and back out the round-trip-adjusted offset.
  //
  // One round trip is a noisy measurement: the offset it gives is only as
  // good as the assumption that the request and the response took equally
  // long, and the database lives in Singapore, a long way from most people
  // using this, so a slow leg on either side skews it by tens of
  // milliseconds. Several samples are kept, and the one with the fastest
  // round trip wins, because the less time a sample spent in flight, the
  // less room there was for the two legs to differ (the standard NTP
  // approach). A burst of samples on connect gets a good estimate within a
  // second; one more a minute keeps it fresh.
  //
  // Timed on the monotonic clock rather than Date.now(), which can jump
  // when the system clock gets corrected mid-session.
  const CLOCK_SAMPLES_KEPT = 12;
  // The last offset measured in a session, kept for outside one: checking
  // for an invite only reads the room (nothing is written while you're not
  // watching together), so it has no way to measure the clock itself.
  const CLOCK_KEY = 'tetherClockOffset';
  let clockSamples = [];
  function localNow() { return performance.timeOrigin + performance.now(); }
  async function clockSample() {
    if (!config) return;
    try {
      const t0 = localNow();
      const res = await fetch(roomUrl('_clock'), { method: 'PUT', body: JSON.stringify({ '.sv': 'timestamp' }) });
      const t1 = localNow();
      const serverTime = await res.json();
      if (typeof serverTime !== 'number') return;
      const rtt = t1 - t0;
      // The server likely stamped this roughly mid-flight.
      clockSamples.push({ rtt, offset: serverTime + rtt / 2 - t1 });
      if (clockSamples.length > CLOCK_SAMPLES_KEPT) clockSamples.shift();
      serverOffsetMs = clockSamples.reduce((best, c) => (c.rtt < best.rtt ? c : best)).offset;
      // Saved against Date.now(), the clock every tab shares; localNow() is
      // this tab's own and can drift from it (sleep, a clock correction).
      try { chrome.storage.local.set({ [CLOCK_KEY]: serverNow() - Date.now() }); } catch (e) { /* extension reloaded */ }
    } catch (e) { /* keep the previous offset if this attempt fails */ }
  }
  async function calibrateClock(burst) {
    for (let i = 0; i < (burst ? 5 : 1); i++) await clockSample();
  }
  // Resolves once this connection's first clock sample is back. Catching up
  // waits on it: deciding whether the other person is here right now, and
  // where they'd be by now, both read the server's clock.
  let clockReady = Promise.resolve();
  function serverNow() { return localNow() + serverOffsetMs; }

  // Where this is, for the other person to follow: the address without its
  // query or fragment, which on these sites carry tracking and playlist
  // details, not the title (YouTube's own ?v= is the exception, and kept).
  function shareUrl() {
    try {
      const u = new URL(pageUrl());
      const v = /(^|\.)youtube\.com$/.test(u.hostname) ? u.searchParams.get('v') : null;
      u.search = v ? '?v=' + encodeURIComponent(v) : '';
      u.hash = '';
      return u.href;
    } catch (e) { return location.origin + location.pathname; }
  }
  // Only ever sends someone to one of the streaming sites Tether works on.
  // The address comes from the shared room, which anyone with its code can
  // write to; without this, a "Join them" could lead anywhere.
  const SITE_HOST = /(^|\.)(netflix\.com|hulu\.com|disneyplus\.com|crunchyroll\.com|max\.com|hbomax\.com|youtube\.com|primevideo\.com)$/;
  const AMAZON_HOST = /^www\.amazon\.(com|co\.uk|de|ca|co\.jp|in|com\.au|fr|it|es)$/;
  function safeUrl(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:') return null;
      if (SITE_HOST.test(u.hostname) || (AMAZON_HOST.test(u.hostname) && /\/(gp\/video|dp)\//.test(u.pathname))) return u.href;
    } catch (e) { /* not a URL */ }
    return null;
  }

  // Which title/episode a position belongs to. A bare timestamp means
  // nothing without it: at an episode change, one side's 0:00 on the new
  // episode was applied to the other side still finishing the old one (and
  // the old episode's 42:10 to a freshly started new one). Just the id, not
  // the whole path: Crunchyroll's slug after the id is localized, and
  // Disney+ can add a locale prefix, so two people in different regions
  // watching the same thing would otherwise never match.
  function contentKey() {
    // Prime Video can't be keyed from the URL at all (see prime.js), so a
    // site can supply its own.
    if (siteControls?.contentKey) return siteControls.contentKey();
    const loc = new URL(pageUrl());
    const v = loc.searchParams.get('v');
    if (loc.pathname === '/watch' && v) return 'yt:' + v;
    const live = /(^|\.)youtube\.com$/.test(loc.hostname) && loc.pathname.match(/^\/live\/([^/]+)/);
    if (live) return 'yt:' + live[1];
    const m = loc.pathname.match(/\/watch\/([^/]+)/) || loc.pathname.match(/\/(?:play|video)\/([^/]+)/);
    return m ? m[1] : loc.pathname;
  }
  // The address of the title being watched. Usually this page's own; a
  // player that runs in a frame of its own (Crunchyroll's) gets it from the
  // page around it instead (see crunchyroll.js).
  function pageUrl() {
    return (siteControls?.pageUrl && siteControls.pageUrl()) || location.href;
  }
  // Payloads from an older version carry no content key: nothing to compare,
  // so they're trusted, the same as before this check existed.
  function sameContent(key) {
    if (!key) return true;
    if (siteControls?.sameContent) return siteControls.sameContent(key, contentKey());
    return key === contentKey();
  }

  // A live stream (a YouTube live, Hulu + Live TV) has no shared timeline:
  // each viewer's video.currentTime counts from whenever their own session
  // started, so seeking one to the other's number lands somewhere arbitrary.
  // Play and pause still sync; position doesn't.
  function isLive() {
    return !siteControls?.getCurrentTime && !!video && video.duration === Infinity;
  }

  function playbackRate() {
    const r = video ? video.playbackRate : 1;
    return Number.isFinite(r) && r > 0 ? r : 1;
  }
  function clampRate(r) {
    return (typeof r === 'number' && Number.isFinite(r)) ? Math.min(4, Math.max(0.25, r)) : 1;
  }

  // Sites whose players rebuffer badly on every seek, or can only tell us
  // their position to within a fraction of a second (Prime Video, see
  // prime.js), ask for more slack.
  function precision() { return siteControls?.precisionS ?? PRECISION_S; }
  function seekLimit() { return siteControls?.seekLimitS ?? SEEK_LIMIT_S; }
  function seekThreshold(playing) {
    return playing
      ? Math.max(SEEK_THRESHOLD_PLAYING_S, siteControls?.precisionS ?? 0)
      : Math.max(SEEK_THRESHOLD_PAUSED_S, siteControls?.precisionS ?? 0);
  }

  // A seek isn't instant: while the player fetches and buffers the new spot,
  // the shared timeline keeps moving, so seeking to exactly where the other
  // person is lands behind them by however long that took. Seeks made while
  // playing aim that far ahead. It starts at a typical value and learns this
  // site and connection's real one from how far off each seek actually
  // landed (measured on the next drift check).
  let seekLead = 0.25;
  let probeLead = false;
  function learnLead(miss) {
    // miss: where we landed minus where we should be. Behind means negative.
    if (Math.abs(miss) < 1.5) seekLead = Math.min(1.5, Math.max(0, seekLead - 0.6 * miss));
  }

  // Closing a small gap by speed instead of a seek. Up to 10% faster or
  // slower, scaled to the gap, with the pitch kept as is (Chrome's default):
  // a few seconds of that is imperceptible, where a seek is a visible jump
  // and a moment of buffering. Stops once back within a fraction of the
  // target, so it doesn't hunt back and forth around it.
  let nudging = false;
  let nudgeRate = 1;
  // A player that keeps putting its own speed back (some sites manage speed
  // themselves) can't be nudged; after a few tries, this page goes back to
  // closing every gap past precision with a seek, the way it always did.
  let nudgeRefusals = 0;
  function canNudge() { return nudgeRefusals < 3; }
  function nudge(gap) {
    if (nudging && Math.abs(playbackRate() - nudgeRate) > 0.005) nudgeRefusals++;
    const amount = Math.min(0.1, 0.04 + Math.abs(gap) * 0.15);
    const r = knownRate * (gap < 0 ? 1 + amount : 1 - amount);
    if (nudging && Math.abs(r - nudgeRate) < 0.005) return;
    nudging = true;
    nudgeRate = r;
    try { video.playbackRate = r; } catch (e) { nudging = false; }
  }
  function stopNudge() {
    if (!nudging) return;
    nudging = false;
    try { if (video) video.playbackRate = knownRate; } catch (e) { /* nothing to restore */ }
  }

  // A native event is pushed a beat later rather than the instant it fires.
  // A player's own transitions arrive as bursts (a seek is often
  // pause + seeked + play, an ad starting on YouTube swaps the source a
  // moment before its ad-showing class appears), and reading state once
  // everything has settled sends one accurate update instead of several,
  // the first of which could carry an ad's 0:00 as the shared position.
  // The first few seconds of a video, or of a new title in the same one.
  // A player's own startup fires the same events a person would: it seeks
  // to wherever this account last left off (or 0:00) and autoplays. Pushed,
  // that told the other person, already watching, to jump to it, so whoever
  // opened the title second yanked the first back to their own resume
  // point. During this window this side only catches up. If there turned
  // out to be nobody to catch up to (this side is first), where it is gets
  // announced at the end instead, so starting a title first still works,
  // just a moment later.
  // Catching up means following someone who is watching right now. The
  // room keeps its last playback state forever, so without this check,
  // starting last night's episode again tonight, alone, snapped you to
  // wherever the two of you stopped yesterday. Only applied if the other
  // person is in a session at this moment (an older version that doesn't
  // report sessions counts if it's there at all).
  async function catchUp() {
    if (!config || !isLeader()) return;
    try {
      const [presence, data] = await Promise.all([
        fetch(roomUrl('presence')).then((res) => res.json()),
        fetch(roomUrl('sync')).then((res) => res.json()),
      ]);
      const now = serverNow();
      const watching = Object.entries(presence || {}).filter(([id, p]) =>
        id !== CLIENT_ID && p && p.watching !== false && (!p.owner || p.owner !== OWNER_ID) && now - p.ts < 15000);
      // And only to something they set during this session. The room also
      // holds whatever they last did before it (last night's episode, left
      // playing when the tab closed); projected forward by a day, that
      // threw both of you past the end. Older versions don't report when
      // their session began, so for them, being there is enough.
      const fresh = data && watching.some(([id, p]) =>
        data.from === id && (typeof p.since !== 'number' || (typeof data.ts === 'number' && data.ts >= p.since)));
      if (fresh) applyRemote(data);
    } catch (e) { /* nothing to catch up to */ }
  }

  const STARTUP_QUIET_MS = 3000;
  let startupUntil = 0;
  let startupTimer = null;
  let caughtUp = false;
  // When this side last announced where it is (see endStartup). Both sides
  // can announce within the same moment (the next episode autoplaying on
  // both, say); each then applied the other's and they swapped places.
  // The one with the higher id keeps its position and says so again; the
  // other follows.
  let announcedAt = 0;
  const ANNOUNCE_CLASH_MS = 2500;
  function beginStartup() {
    startupUntil = Date.now() + STARTUP_QUIET_MS;
    caughtUp = false;
    clearTimeout(startupTimer);
    startupTimer = setTimeout(endStartup, STARTUP_QUIET_MS);
    clockReady.then(catchUp);
  }
  function endStartup() {
    startupUntil = 0;
    if (!video || !config || !isLeader()) return;
    if (caughtUp) {
      // Once more now that it has settled: a player that finished its own
      // startup seek after our catch-up would otherwise be left where it
      // put itself, not where the other person is.
      catchUp();
    } else {
      // Even with no event seen: a player's startup can play and seek
      // before this video was attached at all, and the other person should
      // still hear where this side is.
      // Always as 'start', whatever happened during the window: that's how
      // the other side recognizes an announcement (see announcedAt).
      // Only counts as an announcement if one went out (not during an ad,
      // or before the player knows its position).
      if (pushSync('start')) announcedAt = Date.now();
    }
  }
  // A new title showing up in the same <video> element (every YouTube video,
  // Prime episodes) is a fresh start too. Checked on every event, not only
  // on checkDrift's timer, so the new title's own startup events are caught.
  let lastContentKey = null;
  function noteContent() {
    const key = contentKey();
    if (key === lastContentKey) return false;
    lastContentKey = key;
    if (config) writeNowWatching(); // the invite link should point at the new title
    beginStartup();
    return true;
  }

  let pushTimer = null;
  let pushType = null;
  // Players fire ratechange while loading (setting 1x on a video that was
  // already at 1x), and an episode starting is exactly the wrong moment to
  // send this side's position as news. Only a real change of speed counts.
  let knownRate = 1;
  function onRateChange() {
    const r = playbackRate();
    if (nudging && Math.abs(r - nudgeRate) < 0.001) return; // our own nudge
    if (Math.abs(r - knownRate) < 0.01) return;
    nudging = false; // someone picked a speed; that wins over any nudge
    knownRate = r;
    schedulePush('rate');
  }
  function schedulePush(type) {
    if (!sessionOn()) return; // not watching together: nothing is shared
    if (remoteGuards > 0) return; // an echo of something we just applied, not a local action
    // Playing, pausing or seeking in the tab you're looking at makes it the
    // one in charge (see claimLeader). A tab in the background that isn't
    // in charge is just a stray video; it doesn't speak for you.
    if (!isLeader()) {
      if (document.hidden) return;
      claimLeader(false);
    }
    noteContent();
    if (Date.now() < startupUntil) return; // announced as one at the end of the window
    pushType = type;
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      pushSync(pushType);
    }, PUSH_SETTLE_MS);
  }

  // Only ever called through schedulePush, which already dropped echoes of
  // our own remote-applied changes at the moment their events fired.
  // True if something was actually sent.
  function pushSync(type) {
    if (!config || !video) return false;
    if (looksLikeAd()) return false; // an ad's own position isn't the shared watch position
    if (justLeftAd()) return false;
    // See currentTimeSeconds/isPlayingNow above: on a site where the
    // <video> element itself can't be trusted for position, read through
    // the site's own player instead. Either can come back null if that
    // player hasn't finished loading yet; nothing to broadcast in that case.
    const time = currentTimeSeconds();
    const playing = isPlayingNow();
    if (time == null || playing == null) return false;
    const content = contentKey();
    // The speed someone chose, not a nudge in progress.
    const rate = nudging ? knownRate : playbackRate();
    // Stamped with the moment the position was read, on the shared server
    // clock (see calibrateClock), not with when the server received the
    // write. A server timestamp arrived one upload later than the position
    // it described, and the other side, projecting forward from it, always
    // landed exactly that far behind: a tenth to a fifth of a second on a
    // typical connection to this database, every single time.
    // Until the first clock sample is back (the first second or so after
    // connecting), the server's own timestamp: late by an upload, but never
    // wrong by however far off this device's clock happens to be.
    const ts = clockSamples.length ? Math.round(serverNow()) : null;
    // name: so the other side can say who did it ("Ridu paused").
    // url: where this is, so the other side can offer to join if they're on
    // something else (see noteElsewhere).
    const payload = {
      type, time, playing, rate, content, ts: ts ?? { '.sv': 'timestamp' }, from: CLIENT_ID,
      name: nickname || null, url: shareUrl(),
    };
    // lastRemote is what checkDrift treats as "where playback should be", but
    // it was only ever updated by data arriving from the other person, never
    // by our own action. Whichever side acts less often ends up with a
    // stale lastRemote that still reflects the other person from a while
    // ago, so the instant THAT side seeks, its own checkDrift runs a
    // moment later, disagrees with what just happened locally, and quietly
    // snaps it back, seeking looked like it silently did nothing. Using
    // serverNow() here rather than waiting on the write's own resolved
    // timestamp is deliberately consistent with what checkDrift compares
    // against on this same device, not less accurate: it's this device's
    // own clock-corrected "now" either way.
    lastRemote = { time, ts: ts ?? serverNow(), playing, rate, content };
    fetch(roomUrl('sync'), { method: 'PUT', body: JSON.stringify(payload) }).catch((e) => log('push failed', e));
    return true;
  }

  // Runs `fn`, which may set video.currentTime, while suppressing the
  // pushSync() that would otherwise fire off the resulting native events.
  // A seek on a slow connection can take a while to actually settle (it
  // waits on buffering), so guessing a fixed timeout risks lifting the
  // guard before the real 'seeked' event arrives, which would then get
  // mistaken for a fresh local action and re-broadcast. Confirm on the
  // real event instead, with a generous timeout only as a fallback for the
  // case where no seek actually happened.
  // Counted, not a single flag: a play arriving while an earlier seek is
  // still buffering used to lift the guard on its short timer, and the
  // seek's own 'seeked' then went out as if this person had skipped.
  function withRemoteGuard(fn, mayNeedSeek) {
    const el = video; // captured now, in case the player gets swapped out mid-guard (an episode change, say)
    remoteGuards++;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      remoteGuards = Math.max(0, remoteGuards - 1);
      el.removeEventListener('seeked', finish);
    };
    if (mayNeedSeek) el.addEventListener('seeked', finish);
    fn();
    setTimeout(finish, mayNeedSeek ? 4000 : APPLY_REMOTE_GUARD_MS);
  }

  function applyRemote(data) {
    if (!data || data.from === CLIENT_ID || !video || !isLeader()) return;
    // A different title or episode: not a position this video can use, and
    // not something checkDrift should keep steering toward either. But worth
    // telling this person about, with a way to get there.
    if (!sameContent(data.content)) { noteElsewhere(data); return; }
    noteElsewhere(null);
    if (data.type === 'start' && Date.now() - announcedAt < ANNOUNCE_CLASH_MS) {
      announcedAt = 0;
      // Keeps its spot only if it can say so; otherwise it follows.
      if (String(CLIENT_ID) > String(data.from) && pushSync('start')) return;
    }
    noteAction(data);
    const rate = clampRate(data.rate);
    lastRemote = { time: data.time, ts: data.ts, playing: data.playing, rate, content: data.content };
    // Keep lastRemote current either way, so the moment this side's own ad
    // ends there's already a fresh target to catch up to, but don't touch
    // an ad that's actually playing right now: seeking it to a content
    // timestamp, or pausing/playing it to match, is meaningless at best and
    // can visibly glitch or restart the ad at worst.
    if (looksLikeAd()) return;
    caughtUp = true;
    // Only project the position forward if the video was actually playing at
    // the moment this was written. A paused video doesn't advance just
    // because time passed before this arrived, if it did, joining a room
    // (or reconnecting) minutes into someone else's pause would seek to
    // "where they'd be if they'd kept playing" instead of where they
    // actually are: sitting still.
    // Multiplied by their speed: at 1.5x, ten seconds in flight is fifteen
    // seconds of show.
    const elapsed = data.playing ? Math.max(0, (serverNow() - data.ts) / 1000) * rate : 0;
    const localTime = data.time + elapsed;
    const current = currentTimeSeconds();
    const needsSeek = !isLive() && (current == null || Math.abs(current - localTime) > seekThreshold(data.playing));
    // Playing, aim ahead by the time the seek itself takes (see seekLead).
    let target = data.playing ? localTime + seekLead : localTime;
    const length = video.duration;
    if (Number.isFinite(length) && length > 1) target = Math.min(target, length - 0.5);
    if (needsSeek && data.playing) probeLead = true;
    stopNudge();
    withRemoteGuard(() => {
      // Speed is part of staying together: one of you at 1.25x drifts a
      // full minute every four, and drift correction would be seeking
      // every two seconds trying to hold that together. Older versions
      // send no rate; clampRate reads that as normal speed.
      if (Math.abs(knownRate - rate) > 0.01 || Math.abs(playbackRate() - rate) > 0.01) {
        try { knownRate = rate; video.playbackRate = rate; } catch (e) { /* a site that refuses keeps its own */ }
      }
      // See siteControls above: on a site where setting video.currentTime
      // directly isn't safe, route the same change through the site's own
      // player instead.
      if (siteControls?.seek) {
        if (needsSeek) siteControls.seek(target);
        if (data.playing) siteControls.play();
        if (!data.playing) siteControls.pause();
      } else {
        if (needsSeek) video.currentTime = target;
        if (data.playing && video.paused) video.play().catch(() => {});
        if (!data.playing && !video.paused) video.pause();
      }
    }, needsSeek);
  }

  // The other person on a different title: offered as a one-click "join
  // them", the same way an invite link works. Only while it's current: their
  // last update has to be recent, or, if they're still playing, from within
  // the length of a long movie, since nothing new is sent while someone just
  // watches.
  let elsewhereShown = null;
  function noteElsewhere(data) {
    let next = null;
    const url = data && safeUrl(data.url);
    if (url && url !== shareUrl() && typeof data.ts === 'number') {
      const age = serverNow() - data.ts;
      if (age < (data.playing ? 4 * 3600e3 : 15 * 60e3)) next = { name: data.name || null, url };
    }
    if ((next && next.url) === (elsewhereShown && elsewhereShown.url)) return;
    elsewhereShown = next;
    emit('elsewhere', next);
  }

  // "Ridu paused", "Ridu skipped to 12:04": so a change that just happened
  // to your playback is never a mystery. Only for something that just
  // happened (not the state fetched on joining, or replayed on reconnect),
  // and only once, since the same update can arrive by stream and by fetch.
  let lastActionKey = null;
  function noteAction(data) {
    if (!['play', 'pause', 'seek', 'rate'].includes(data.type) || typeof data.ts !== 'number') return;
    if (Math.abs(serverNow() - data.ts) > 6000) return;
    const key = data.from + ':' + data.ts;
    if (key === lastActionKey) return;
    lastActionKey = key;
    emit('action', { type: data.type, name: data.name || null, time: data.time, rate: clampRate(data.rate) });
  }

  let wasAdLike = false;
  function checkDrift() {
    if (orphaned()) return;
    if (!isLeader()) return; // standing by; the tab in charge keeps time
    // A new title or episode in the same <video> element, with no event
    // from it yet: catch up to the other person (see noteContent). Their
    // latest position for it may have arrived while this tab was still on
    // the old one, and was rightly ignored then.
    if (noteContent()) return;
    const adLike = looksLikeAd();
    if (adLike !== wasAdLike) {
      wasAdLike = adLike;
      if (!adLike && config) {
        // The ad that was just playing here could have run for anywhere
        // from a few seconds to a couple minutes, with nothing pushed or
        // applied the whole time (see pushSync/applyRemote above), so the
        // shared position could be stale by exactly that much now. Fetch
        // the current value directly instead of waiting on the other
        // person's next play, pause, or seek to correct it.
        catchUp();
      }
      return;
    }
    if (adLike) { stopNudge(); return; }
    if (remoteGuards > 0 || Date.now() < startupUntil) return;
    // lastRemote can outlive the episode it came from (this tab just moved on
    // to the next one); don't pull the new episode toward the old one's clock.
    if (!video || !lastRemote || !lastRemote.playing || !sameContent(lastRemote.content) ||
        !isPlayingNow() || isLive()) {
      stopNudge();
      probeLead = false;
      return;
    }
    const current = currentTimeSeconds();
    if (current == null) return;
    const expected = lastRemote.time + (serverNow() - lastRemote.ts) / 1000 * (lastRemote.rate || 1);
    const gap = current - expected; // positive: ahead of the other person
    if (probeLead) { probeLead = false; learnLead(gap); }
    const seekPast = canNudge() ? seekLimit() : Math.max(precision(), 0.5);
    if (Math.abs(gap) > seekPast) {
      stopNudge();
      probeLead = true;
      withRemoteGuard(() => {
        if (siteControls?.seek) siteControls.seek(expected + seekLead);
        else video.currentTime = expected + seekLead;
      }, true);
    } else if (Math.abs(gap) > precision() && canNudge()) {
      nudge(gap);
    } else if (nudging && Math.abs(gap) < precision() * 0.4) {
      stopNudge();
    }
  }

  // A heartbeat rather than a true onDisconnect: the REST + SSE approach this
  // extension deliberately uses (see the file header) has no equivalent of
  // the Firebase SDK's connection-aware onDisconnect, so presence is inferred
  // from "has this client written a timestamp recently" instead.
  function writePresence(watching = sessionOn()) {
    if (!config || !CLIENT_ID) return;
    // A server timestamp, not this device's own clock: the popup's presence
    // check (see popup.js) compares this against its own idea of "now" to
    // decide if it's stale, and this app's whole premise is two people whose
    // devices can genuinely disagree on the time by more than a little.
    // Two client-side clocks fed into one staleness check is exactly how
    // "someone's been gone for a while" and "someone's still here" get
    // swapped.
    fetch(roomUrl('presence/' + CLIENT_ID), {
      method: 'PUT',
      // watching: in a session right now, which is what the other person's
      // Tether offers to join (see pollInvite).
      // since: when this session began, on the server's clock, so the other
      // side only catches up to playback from this session (see catchUp).
      body: JSON.stringify({ ts: { '.sv': 'timestamp' }, name: nickname || null, owner: OWNER_ID || null, watching: !!watching,
        since: watching && session ? Math.round(session.startedAt + serverNow() - Date.now()) : null }),
    }).catch(() => {});
  }

  // Lets an invite link (see join.js) send a new person straight to the
  // right title instead of a bare room code they'd have to act on manually.
  // Written whenever a video attaches, which also naturally covers an
  // episode change: Netflix et al. swap in a new <video> element (and this
  // tab's URL) without a full page reload, and that already re-triggers
  // attachVideo via the site adapter's own MutationObserver.
  //
  // Refreshed on every heartbeat, not just once at attach, with a server
  // timestamp: rooms persist across days, and a value written once and never
  // refreshed can't tell "watching this right now" apart from "watched this
  // yesterday", so an invite link clicked before today's first press of play
  // redirected to yesterday's show. `live` marks this newer, refreshed
  // format so join.js only applies a freshness check to writers that
  // actually keep it fresh, not to an older version that never did.
  function writeNowWatching() {
    // Only the tab you're watching in: a stray video in another tab would
    // otherwise send an invite link to the wrong place.
    if (!config || !sessionOn() || !isLeader()) return;
    fetch(roomUrl('nowWatching'), {
      method: 'PUT',
      body: JSON.stringify({ url: shareUrl(), ts: { '.sv': 'timestamp' }, live: true, from: CLIENT_ID }),
    }).catch(() => {});
  }

  // Who you're watching with, right now: checked by the tab in charge each
  // heartbeat, so the badge can say "In sync with Ridu" rather than "In
  // sync" with nobody there, and say when they join or leave.
  let partner;
  async function checkPartner() {
    if (!config || !isLeader()) return;
    try {
      const data = await (await fetch(roomUrl('presence'))).json();
      const now = serverNow();
      const found = Object.entries(data || {}).find(([id, p]) =>
        id !== CLIENT_ID && p && p.watching !== false && (!p.owner || p.owner !== OWNER_ID) && now - p.ts < 15000);
      const next = found ? { name: found[1].name || null } : null;
      if (partner !== undefined && JSON.stringify(next) === JSON.stringify(partner)) return;
      const first = partner === undefined;
      partner = next;
      emit('partner', { partner: next, first });
    } catch (e) { /* next heartbeat */ }
  }

  // After Tether is updated or reloaded, the copy already running in an open
  // tab carries on without its extension: storage stops working, so it
  // can't hear End or another tab taking over, but its connections and
  // timers keep going, and it went on syncing as a second tab in charge.
  // The moment that's noticed, it stops, and tells the page's buttons to go
  // too (see site-common.js).
  let dead = false;
  function orphaned() {
    if (dead) return true;
    let alive = false;
    try { alive = !!(chrome.runtime && chrome.runtime.id); } catch (e) { /* context invalidated */ }
    if (alive) return false;
    dead = true;
    closeStreams();
    for (const t of [clockTimer, presenceTimer, inviteTimer, driftTimer]) if (t) clearInterval(t);
    clockTimer = presenceTimer = inviteTimer = driftTimer = null;
    if (video && videoListeners) {
      for (const [type, fn] of Object.entries(videoListeners)) video.removeEventListener(type, fn);
    }
    clearTimeout(pushTimer);
    clearTimeout(startupTimer);
    videoListeners = null;
    video = null;
    document.documentElement.removeAttribute('data-tether-syncing');
    emit('gone');
    return true;
  }

  function heartbeat() {
    if (orphaned()) return;
    if (!sessionOn()) { endSession(); return; } // 30 minutes without a video
    checkPartner();
    bumpSession();
    writePresence();
    if (video) writeNowWatching();
    // The tab in charge says it's still here (and whether it's playing);
    // any other tab on a player checks whether it should step in.
    if (isLeader() && !video) {
      releaseLeader();
    } else if (isLeader()) {
      leader = { id: TAB_ID, at: Date.now(), playing: !!isPlayingNow() };
      try { chrome.storage.local.set({ [LEADER_KEY]: leader }); } catch (e) { /* extension reloaded */ }
    } else {
      maybeClaim();
    }
  }

  // Same messages, same shape, as the popup's chat (see popup.js), so a
  // message sent from either shows up in both, for both people.
  function sendChat(text) {
    const t = String(text || '').trim().slice(0, 500);
    if (!config || !t) return;
    fetch(roomUrl('chat'), {
      method: 'POST',
      body: JSON.stringify({ text: t, from: CLIENT_ID, name: nickname || null, ts: { '.sv': 'timestamp' } }),
    }).catch(() => {});
  }

  function startChatStream() {
    if (chatEs) chatEs.close();
    let messages = {};
    // Newest 40 only, the same reasoning as the popup's stream.
    chatEs = new EventSource(roomUrl('chat') + '?orderBy=%22%24key%22&limitToLast=40');
    const handle = (e) => {
      try {
        const { path, data } = JSON.parse(e.data);
        const initial = path === '/';
        if (initial) messages = data || {};
        else if (data === null) delete messages[path.slice(1)];
        else messages[path.slice(1)] = data;
        emit('chat', { messages, initial });
      } catch (err) { /* ignore malformed frames */ }
    };
    chatEs.addEventListener('put', handle);
    chatEs.addEventListener('patch', handle);
  }

  function sendReaction(emoji) {
    if (!config) return;
    fetch(roomUrl('reactions'), {
      method: 'PUT',
      body: JSON.stringify({ emoji, from: CLIENT_ID, ts: { '.sv': 'timestamp' } }),
    }).catch(() => {});
  }

  // Read by keep-playing.js (MAIN world, shares this DOM attribute but not
  // this file's variables): only while a video is attached in a room should
  // the page be kept believing it's visible when you switch tabs.
  function updateSyncingFlag() {
    document.documentElement.toggleAttribute('data-tether-syncing', !!(video && config && config.roomId && sessionOn()));
  }

  // ---------------------------------------------------------------------
  // Watching together is a session you start, not something that's always
  // on. The room itself is permanent (its code, chat and notes are always
  // there), but playback is only synced, and what you're watching only
  // shared, while a session is on: started from the popup or the page,
  // joined by accepting the other person's invite, or by opening an invite
  // link. Without one, Tether shares nothing about what you watch; it only
  // checks, while you're looking at a streaming tab, whether the other
  // person has started a session, so it can offer to join it.
  //
  // Kept per browser (storage.local): starting a session on your laptop
  // doesn't start one on your desktop. It ends with End, or on its own
  // after 30 minutes without a video open.
  // ---------------------------------------------------------------------
  const SESSION_KEY = 'tetherSession';
  const SESSION_IDLE_MS = 30 * 60e3;
  let session = null; // { roomId, startedAt, lastVideoAt }
  function sessionOn() {
    return !!(session && config && config.roomId && session.roomId === config.roomId &&
      Date.now() - (session.lastVideoAt || session.startedAt) < SESSION_IDLE_MS);
  }
  function startSession() {
    if (dead || !config || !config.roomId) return;
    const now = Date.now();
    session = { roomId: config.roomId, startedAt: now, lastVideoAt: now };
    try { chrome.storage.local.set({ [SESSION_KEY]: session }); } catch (e) { /* extension reloaded */ }
    connect();
  }
  function endSession() {
    const wasOn = !!session;
    session = null;
    try { chrome.storage.local.remove(SESSION_KEY); } catch (e) { /* extension reloaded */ }
    // Tell the other side right away, rather than leaving them an invite to
    // a session that's over until this entry goes stale on its own.
    if (wasOn) { writePresence(false); clearNowWatching(); }
    connect();
  }
  // What you were watching doesn't stay in the room after you end: removed
  // if this browser is the one that last wrote it.
  async function clearNowWatching() {
    if (!config || !config.roomId) return;
    try {
      const data = await (await fetch(roomUrl('nowWatching'))).json();
      if (data && data.from === CLIENT_ID) await fetch(roomUrl('nowWatching'), { method: 'DELETE' });
    } catch (e) { /* left to go stale */ }
  }
  let lastVideoBump = 0;
  function bumpSession() {
    if (!session || !video || Date.now() - lastVideoBump < 30000) return;
    lastVideoBump = Date.now();
    session = { ...session, lastVideoAt: lastVideoBump };
    try { chrome.storage.local.set({ [SESSION_KEY]: session }); } catch (e) { /* extension reloaded */ }
  }

  // Without a session: is the other person in one? Read only, and only from
  // the tab you're looking at, every few seconds.
  const INVITE_POLL_MS = 8000;
  let inviteTimer = null;
  let inviteShown = null;
  function setInvite(next) {
    if ((next && next.key) === (inviteShown && inviteShown.key)) return;
    inviteShown = next;
    emit('invite', next);
  }
  async function pollInvite() {
    if (orphaned()) return;
    if (!config || !config.roomId || sessionOn() || document.hidden) return;
    try {
      const data = await (await fetch(roomUrl('presence'))).json();
      const now = serverNow();
      const partner = Object.entries(data || {}).find(([id, p]) =>
        id !== CLIENT_ID && p && p.watching === true && (!p.owner || p.owner !== OWNER_ID) && now - p.ts < 15000);
      setInvite(partner ? { key: partner[0], name: partner[1].name || null } : null);
    } catch (e) { /* try again next time */ }
  }

  // ---------------------------------------------------------------------
  // One tab holds the live connections.
  //
  // The database only speaks HTTP/1.1, and Chrome allows six open
  // connections to one server per site. Each live stream (playback,
  // reactions, chat) holds one open for as long as it runs, so three
  // YouTube tabs used all six between them, and every save (play, pause,
  // presence) queued behind them forever: sync silently froze in every tab.
  // So in each browser, only the tab you're actually watching in holds the
  // streams. It's chosen through extension storage, which every tab shares:
  // a tab takes over when you play, pause or seek in it, when you switch to
  // it, or when the current one goes quiet (closed, crashed, or left the
  // player for over 15 seconds); every other tab stands by with nothing
  // open, and steps back in the moment it's chosen.
  // ---------------------------------------------------------------------
  const TAB_ID = 't_' + Math.random().toString(36).slice(2, 10);
  const LEADER_KEY = 'tetherLeader';
  const LEADER_STALE_MS = 15000;
  let leader = null; // { id, at, playing }
  function isLeader() { return !!leader && leader.id === TAB_ID; }
  function leaderStale() { return !leader || Date.now() - leader.at > LEADER_STALE_MS; }
  function claimLeader(withCatchUp = true) {
    if (!config || !config.roomId || !video || !sessionOn()) return;
    const was = isLeader();
    leader = { id: TAB_ID, at: Date.now(), playing: !!isPlayingNow() };
    try { chrome.storage.local.set({ [LEADER_KEY]: leader }); } catch (e) { /* extension reloaded */ }
    updateStreams();
    // Newly in charge: catch up to the other person, who may have moved on
    // while this tab was standing by. Not when it's taking over because of
    // something you just did in it, which is what gets sent instead.
    if (!was && withCatchUp) catchUp();
    if (!was) { partner = undefined; checkPartner(); }
  }
  function releaseLeader() {
    if (!isLeader()) return;
    leader = null;
    try { chrome.storage.local.remove(LEADER_KEY); } catch (e) { /* extension reloaded */ }
    updateStreams();
  }
  // Take over only if the tab in charge has gone quiet. Or, when a video
  // opens in the tab you're looking at, if the tab in charge isn't playing
  // anything. Never from a tab in the background just because the one in
  // charge is paused: pausing is part of watching, not leaving.
  function maybeClaim(opening = false) {
    if (!video || isLeader()) return;
    if (leaderStale() || (opening && !document.hidden && !leader.playing)) claimLeader();
  }
  function onLeaderChanged(next) {
    leader = next || null;
    updateStreams();
    // The leader stepped down (left its player, closed): a tab that's still
    // on one picks up, after a beat so two tabs don't both jump at once.
    if (!leader && video) setTimeout(maybeClaim, 200 + Math.random() * 600);
  }
  document.addEventListener('visibilitychange', () => {
    // This is the real visibility; keep-playing.js only changes what the
    // site's own scripts see.
    if (!document.hidden && video) claimLeader();
    if (!document.hidden && !sessionOn()) pollInvite();
  });
  window.addEventListener('pagehide', releaseLeader);

  let streamsOpen = false;
  let idleStatus = null;
  function updateStreams() {
    if (!sessionOn()) { if (streamsOpen) closeStreams(); return; }
    // The tab in charge keeps its streams for a moment even between videos
    // (Netflix swaps the element at every episode), rather than dropping and
    // reopening them; heartbeat hands over if it stays off a player.
    const want = !!(config && config.roomId && isLeader());
    if (want && !streamsOpen) openStreams();
    else if (!want && streamsOpen) closeStreams();
    // Only on a change, or every leadership heartbeat would flash the badge.
    const next = want ? null : (config && config.roomId ? (video ? 'standby' : 'idle') : null);
    if (next && next !== idleStatus) onStatus(next);
    idleStatus = next;
  }

  function closeStreams() {
    streamsOpen = false;
    if (es) { es.close(); es = null; }
    if (reactionsEs) { reactionsEs.close(); reactionsEs = null; }
    if (chatEs) { chatEs.close(); chatEs = null; }
    if (staleCheckTimer) { clearInterval(staleCheckTimer); staleCheckTimer = null; }
    stopNudge();
  }

  function openStreams() {
    closeStreams();
    streamsOpen = true;
    lastEventAt = Date.now();
    es = new EventSource(roomUrl('sync'));
    // The stream opens with a snapshot of whatever is stored, which is not
    // news and may be from yesterday (see catchUp, which decides whether to
    // follow it). Everything after that is the other person acting now.
    let snapshot = true;
    es.addEventListener('put', (e) => {
      lastEventAt = Date.now();
      if (snapshot) { snapshot = false; return; }
      try { applyRemote(JSON.parse(e.data).data); } catch (err) { /* ignore malformed frames */ }
    });
    es.addEventListener('patch', (e) => {
      lastEventAt = Date.now();
      try { applyRemote(JSON.parse(e.data).data); } catch (err) { /* ignore malformed frames */ }
    });
    // Firebase's RTDB streaming API sends these periodically on an otherwise
    // quiet room specifically so a still-good connection doesn't look dead;
    // count them the same as a real update for staleness purposes.
    es.addEventListener('keep-alive', () => { lastEventAt = Date.now(); });
    // Every (re)connect starts with a snapshot. After a dropped connection,
    // the other person may have acted in the gap, so that's worth catching
    // up to, through the same check as joining.
    let opens = 0;
    es.onopen = () => {
      lastEventAt = Date.now();
      snapshot = true;
      if (opens++ > 0) catchUp();
      onStatus(video ? 'connected' : 'idle');
    };
    es.onerror = () => { onStatus('disconnected'); };
    // Belt and suspenders: an SSE connection can go quietly dead (a NAT or
    // proxy dropping it) without ever firing the EventSource's own onerror,
    // which would otherwise leave this stuck reporting "connected" while
    // nothing actually gets through. If nothing at all has been heard,
    // including Firebase's own keep-alives, open fresh ones.
    staleCheckTimer = setInterval(() => {
      if (Date.now() - lastEventAt > STALE_AFTER_MS) { openStreams(); catchUp(); }
    }, STALE_CHECK_MS);

    reactionsEs = new EventSource(roomUrl('reactions'));
    const handleReaction = (e) => {
      try {
        const data = JSON.parse(e.data).data;
        if (data && data.from !== CLIENT_ID && data.emoji) onReaction(data.emoji);
      } catch (err) { /* ignore malformed frames */ }
    };
    reactionsEs.addEventListener('put', handleReaction);
    reactionsEs.addEventListener('patch', handleReaction);

    startChatStream();
  }

  function connect() {
    if (dead) return;
    updateSyncingFlag();
    closeStreams();
    if (clockTimer) clearInterval(clockTimer);
    if (presenceTimer) clearInterval(presenceTimer);
    if (inviteTimer) { clearInterval(inviteTimer); inviteTimer = null; }
    idleStatus = null;
    if (!config || !config.roomId || !config.dbUrl) { onStatus('no-room'); return; }
    if (!sessionOn()) {
      // A session that timed out while nothing was open to end it.
      if (session) { session = null; try { chrome.storage.local.remove(SESSION_KEY); } catch (e) { /* reloaded */ } }
      releaseLeader();
      noteElsewhere(null);
      onStatus(video ? 'off' : 'off-browse');
      pollInvite();
      inviteTimer = setInterval(pollInvite, INVITE_POLL_MS);
      return;
    }
    setInvite(null);
    clockSamples = [];
    clockReady = clockSample();
    clockReady.then(() => calibrateClock(true));
    clockTimer = setInterval(() => calibrateClock(false), CLOCK_RECALIBRATE_MS);
    writePresence();
    presenceTimer = setInterval(heartbeat, PRESENCE_HEARTBEAT_MS);
    // Covers the case where the video attached before config existed yet
    // (attachVideo's own call is a no-op then, guarded on config): now that
    // config is valid, make sure whatever's already playing gets recorded.
    if (video) writeNowWatching();
    if (video) maybeClaim(true);
    updateStreams();
    // Joining (or starting) a session is a fresh start like opening a video
    // (see beginStartup): catch up to whoever's already watching, and only
    // announce this side's position if there's nobody to catch up to, so
    // joining brings you to them, never them to you.
    if (video) { lastContentKey = contentKey(); beginStartup(); }
  }

  let videoListeners = null;

  function attachVideo(el) {
    video = el;
    updateSyncingFlag();
    // The connection usually opened back on a browse page, which reported
    // 'idle'; now that there's actually something to sync, say so.
    if (es && es.readyState === EventSource.OPEN) onStatus('connected');
    if (config && config.roomId && !sessionOn()) onStatus('off');
    videoListeners = {
      play: () => schedulePush('play'),
      pause: () => schedulePush('pause'),
      seeked: () => schedulePush('seek'),
      ratechange: onRateChange,
    };
    knownRate = playbackRate();
    for (const [type, fn] of Object.entries(videoListeners)) video.addEventListener(type, fn);
    driftTimer = setInterval(checkDrift, DRIFT_CHECK_MS);
    // Firebase's stream delivers the room's current state once, right as the
    // connection opens (see connect()), which is how a newly-arriving video
    // would normally catch up to wherever the other person already is. But
    // that only fires once, at connect time, and this video element usually
    // isn't done loading yet when it does, so that catch-up gets silently
    // missed with nothing to retry it. Fetch the current state directly the
    // moment a video actually exists to attach it to, instead of only ever
    // reacting to the other person's next play, pause, or seek.
    //
    // Done as the start of the startup window (see beginStartup), so this
    // video's own startup events can't be sent ahead of that catch-up.
    lastContentKey = contentKey();
    maybeClaim(true);
    updateStreams(); // standing by if another tab is in charge, and say so
    beginStartup();
    writeNowWatching();
  }

  function detachVideo() {
    if (video && videoListeners) {
      for (const [type, fn] of Object.entries(videoListeners)) video.removeEventListener(type, fn);
    }
    clearTimeout(pushTimer);
    pushTimer = null;
    clearTimeout(startupTimer);
    startupUntil = 0;
    stopNudge();
    probeLead = false;
    noteElsewhere(null);
    videoListeners = null;
    video = null;
    updateSyncingFlag();
    if (config && config.roomId && !sessionOn()) onStatus('off-browse');
    else updateStreams();
    if (driftTimer) clearInterval(driftTimer);
  }

  // ---------------------------------------------------------------------
  // Public API used by site adapters (window.TetherSync.*)
  // ---------------------------------------------------------------------
  window.TetherSync = {
    /** Call once, with a status callback, a reaction callback, and optional
     *  player controls (see site-common.js). Site adapters are responsible
     *  for finding the video element and re-calling setVideo when the
     *  player is torn down/rebuilt (Netflix does this on episode change,
     *  for instance). */
    init(statusCallback, reactionCallback, playerControls) {
      onStatus = statusCallback || onStatus;
      onReaction = reactionCallback || onReaction;
      siteControls = playerControls || null;
      // The storage-change listener is only registered once CLIENT_ID exists,
      // not just fired-and-forgotten alongside resolveClientId: a room change
      // arriving in that small window would otherwise call connect() while
      // CLIENT_ID is still null, and a sync pushed with `from: null` right as
      // it resolves could briefly fail to recognize itself as "my own echo".
      resolveClientId(() => {
        resolveOwnerId(() => {
          chrome.storage.local.get([LEADER_KEY, SESSION_KEY, CLOCK_KEY], (local) => {
            if (typeof local[CLOCK_KEY] === 'number') serverOffsetMs = local[CLOCK_KEY] + Date.now() - localNow();
            leader = local[LEADER_KEY] || null;
            session = local[SESSION_KEY] || null;
            chrome.storage.sync.get(['roomId', 'dbUrl', 'nickname'], (stored) => {
              config = { roomId: stored.roomId, dbUrl: stored.dbUrl || DEFAULT_DB_URL };
              nickname = stored.nickname || '';
              connect();
            });
          });
          chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes[LEADER_KEY]) onLeaderChanged(changes[LEADER_KEY].newValue);
            // Started or ended in another tab, the popup, or by an invite link.
            if (area === 'local' && changes[SESSION_KEY]) {
              const was = sessionOn();
              session = changes[SESSION_KEY].newValue || null;
              if (sessionOn() !== was) connect();
            }
            if (area !== 'sync') return;
            if (changes.nickname) nickname = changes.nickname.newValue || '';
            // Self-heals the rare case where this device and another one
            // both generated a fresh ownerId within the same instant, before
            // either had synced: whichever value Chrome settles on for real
            // is picked up here instead of staying stuck on a locally-made
            // one that lost the race.
            if (changes.ownerId) OWNER_ID = changes.ownerId.newValue || OWNER_ID;
            if (changes.roomId || changes.dbUrl) {
              chrome.storage.sync.get(['roomId', 'dbUrl'], (stored) => {
                config = { roomId: stored.roomId, dbUrl: stored.dbUrl || DEFAULT_DB_URL };
                connect();
              });
            }
          });
        });
      });
    },
    setVideo(el) {
      if (dead || video === el) return;
      detachVideo();
      if (el) attachVideo(el);
    },
    sendReaction,
    sendChat,
    safeUrl,
    startSession,
    endSession,
    get sessionActive() { return sessionOn(); },
    get roomId() { return config && config.roomId; },
    on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
    get clientId() { return CLIENT_ID; },
    // For diagnosing from the console: is this tab the one in charge?
    get state() { return { tab: TAB_ID, leader: leader && leader.id, streamsOpen, hasVideo: !!video }; },
  };
})();
