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
    if (location.href !== baselineUrl) {
      baselineDuration = null;
      baselineUrl = location.href;
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
  let applyingRemote = false;
  let lastRemote = null;    // { time, ts, playing }, used for drift correction
  let lastEventAt = 0;      // Date.now() of the last thing heard from the server, any kind
  let driftTimer = null;
  let clockTimer = null;
  let presenceTimer = null;
  let staleCheckTimer = null;
  let serverOffsetMs = 0;   // add to localNow() to estimate the Firebase server's clock (see calibrateClock)
  let onStatus = () => {};  // callback(status: 'connected'|'disconnected'|'no-room')
  let onReaction = () => {}; // callback(emoji), only for a reaction that arrived from the other person

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
    } catch (e) { /* keep the previous offset if this attempt fails */ }
  }
  async function calibrateClock(burst) {
    for (let i = 0; i < (burst ? 5 : 1); i++) await clockSample();
  }
  function serverNow() { return localNow() + serverOffsetMs; }

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
    const v = new URLSearchParams(location.search).get('v');
    if (location.pathname === '/watch' && v) return 'yt:' + v;
    const m = location.pathname.match(/\/watch\/([^/]+)/) || location.pathname.match(/\/(?:play|video)\/([^/]+)/);
    return m ? m[1] : location.pathname;
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
  const STARTUP_QUIET_MS = 3000;
  let startupUntil = 0;
  let startupTimer = null;
  let caughtUp = false;
  let startupPush = null;
  function beginStartup() {
    startupUntil = Date.now() + STARTUP_QUIET_MS;
    caughtUp = false;
    startupPush = null;
    clearTimeout(startupTimer);
    startupTimer = setTimeout(endStartup, STARTUP_QUIET_MS);
    if (config) fetch(roomUrl('sync')).then((r) => r.json()).then(applyRemote).catch(() => {});
  }
  function endStartup() {
    startupUntil = 0;
    if (!video || !config) return;
    if (caughtUp) {
      // Once more now that it has settled: a player that finished its own
      // startup seek after our catch-up would otherwise be left where it
      // put itself, not where the other person is.
      fetch(roomUrl('sync')).then((r) => r.json()).then(applyRemote).catch(() => {});
    } else {
      // Even with no event seen: a player's startup can play and seek
      // before this video was attached at all, and the other person should
      // still hear where this side is.
      pushSync(startupPush || 'start');
    }
    startupPush = null;
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
    if (applyingRemote) return; // an echo of something we just applied, not a local action
    noteContent();
    if (Date.now() < startupUntil) { startupPush = type; return; }
    pushType = type;
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      pushSync(pushType);
    }, PUSH_SETTLE_MS);
  }

  // Only ever called through schedulePush, which already dropped echoes of
  // our own remote-applied changes at the moment their events fired.
  function pushSync(type) {
    if (!config || !video) return;
    if (looksLikeAd()) return; // an ad's own position isn't the shared watch position
    if (justLeftAd()) return;
    // See currentTimeSeconds/isPlayingNow above: on a site where the
    // <video> element itself can't be trusted for position, read through
    // the site's own player instead. Either can come back null if that
    // player hasn't finished loading yet; nothing to broadcast in that case.
    const time = currentTimeSeconds();
    const playing = isPlayingNow();
    if (time == null || playing == null) return;
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
    const payload = { type, time, playing, rate, content, ts: ts ?? { '.sv': 'timestamp' }, from: CLIENT_ID };
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
  }

  // Runs `fn`, which may set video.currentTime, while suppressing the
  // pushSync() that would otherwise fire off the resulting native events.
  // A seek on a slow connection can take a while to actually settle (it
  // waits on buffering), so guessing a fixed timeout risks lifting the
  // guard before the real 'seeked' event arrives, which would then get
  // mistaken for a fresh local action and re-broadcast. Confirm on the
  // real event instead, with a generous timeout only as a fallback for the
  // case where no seek actually happened.
  function withRemoteGuard(fn, mayNeedSeek) {
    const el = video; // captured now, in case the player gets swapped out mid-guard (an episode change, say)
    applyingRemote = true;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      applyingRemote = false;
      el.removeEventListener('seeked', finish);
    };
    if (mayNeedSeek) el.addEventListener('seeked', finish);
    fn();
    setTimeout(finish, mayNeedSeek ? 4000 : APPLY_REMOTE_GUARD_MS);
  }

  function applyRemote(data) {
    if (!data || data.from === CLIENT_ID || !video) return;
    // A different title or episode: not a position this video can use, and
    // not something checkDrift should keep steering toward either.
    if (!sameContent(data.content)) return;
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
    const target = data.playing ? localTime + seekLead : localTime;
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
      if (siteControls) {
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

  let wasAdLike = false;
  function checkDrift() {
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
        fetch(roomUrl('sync')).then((r) => r.json()).then(applyRemote).catch(() => {});
      }
      return;
    }
    if (adLike) { stopNudge(); return; }
    if (applyingRemote || Date.now() < startupUntil) return;
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
        if (siteControls) siteControls.seek(expected + seekLead);
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
  function writePresence() {
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
      body: JSON.stringify({ ts: { '.sv': 'timestamp' }, name: nickname || null, owner: OWNER_ID || null }),
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
    if (!config) return;
    fetch(roomUrl('nowWatching'), {
      method: 'PUT',
      body: JSON.stringify({ url: location.href, ts: { '.sv': 'timestamp' }, live: true }),
    }).catch(() => {});
  }

  function heartbeat() {
    writePresence();
    if (video) writeNowWatching();
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
    document.documentElement.toggleAttribute('data-tether-syncing', !!(video && config && config.roomId));
  }

  function connect() {
    updateSyncingFlag();
    if (es) es.close();
    if (reactionsEs) reactionsEs.close();
    if (clockTimer) clearInterval(clockTimer);
    if (presenceTimer) clearInterval(presenceTimer);
    if (staleCheckTimer) clearInterval(staleCheckTimer);
    if (!config || !config.roomId || !config.dbUrl) { onStatus('no-room'); return; }
    clockSamples = [];
    calibrateClock(true);
    clockTimer = setInterval(() => calibrateClock(false), CLOCK_RECALIBRATE_MS);
    writePresence();
    presenceTimer = setInterval(heartbeat, PRESENCE_HEARTBEAT_MS);
    // Covers the case where the video attached before config existed yet
    // (attachVideo's own call is a no-op then, guarded on config): now that
    // config is valid, make sure whatever's already playing gets recorded.
    if (video) writeNowWatching();
    lastEventAt = Date.now();
    es = new EventSource(roomUrl('sync'));
    es.addEventListener('put', (e) => {
      lastEventAt = Date.now();
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
    // "In sync" is only true with a video attached; on a browse page (see the
    // adapters' player-page check) there's nothing being synced yet.
    es.onopen = () => { lastEventAt = Date.now(); onStatus(video ? 'connected' : 'idle'); };
    es.onerror = () => { onStatus('disconnected'); };
    // Belt and suspenders: an SSE connection can go quietly dead (a NAT or
    // proxy dropping it) without ever firing the EventSource's own onerror,
    // which would otherwise leave this stuck reporting "connected" while
    // nothing actually gets through. If nothing at all has been heard,
    // including Firebase's own keep-alives, force a fresh connection.
    staleCheckTimer = setInterval(() => {
      if (Date.now() - lastEventAt > STALE_AFTER_MS) connect();
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
  }

  let videoListeners = null;

  function attachVideo(el) {
    video = el;
    updateSyncingFlag();
    // The connection usually opened back on a browse page, which reported
    // 'idle'; now that there's actually something to sync, say so.
    if (es && es.readyState === EventSource.OPEN) onStatus('connected');
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
    videoListeners = null;
    video = null;
    updateSyncingFlag();
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
          chrome.storage.sync.get(['roomId', 'dbUrl', 'nickname'], (stored) => {
            config = { roomId: stored.roomId, dbUrl: stored.dbUrl || DEFAULT_DB_URL };
            nickname = stored.nickname || '';
            connect();
          });
          chrome.storage.onChanged.addListener((changes, area) => {
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
      if (video === el) return;
      detachVideo();
      if (el) attachVideo(el);
    },
    sendReaction,
  };
})();
