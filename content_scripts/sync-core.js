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
  const DRIFT_CHECK_MS = 2000;
  const DRIFT_TOLERANCE_S = 0.5;
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

  function looksLikeAd() {
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
  let serverOffsetMs = 0;   // add to Date.now() to estimate the Firebase server's clock
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
  async function calibrateClock() {
    if (!config) return;
    try {
      const t0 = Date.now();
      const res = await fetch(roomUrl('_clock'), { method: 'PUT', body: JSON.stringify({ '.sv': 'timestamp' }) });
      const t1 = Date.now();
      const serverTime = await res.json();
      if (typeof serverTime !== 'number') return;
      const rtt = t1 - t0;
      const estimatedServerNow = serverTime + rtt / 2; // the server likely stamped this roughly mid-flight
      serverOffsetMs = estimatedServerNow - t1;
    } catch (e) { /* keep the previous offset if this attempt fails */ }
  }
  function serverNow() { return Date.now() + serverOffsetMs; }

  function pushSync(type) {
    if (!config || applyingRemote || !video) return;
    if (looksLikeAd()) return; // an ad's own position isn't the shared watch position
    // See currentTimeSeconds/isPlayingNow above: on a site where the
    // <video> element itself can't be trusted for position, read through
    // the site's own player instead. Either can come back null if that
    // player hasn't finished loading yet; nothing to broadcast in that case.
    const time = currentTimeSeconds();
    const playing = isPlayingNow();
    if (time == null || playing == null) return;
    const payload = { type, time, playing, ts: { '.sv': 'timestamp' }, from: CLIENT_ID };
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
    lastRemote = { time, ts: serverNow(), playing };
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
    lastRemote = { time: data.time, ts: data.ts, playing: data.playing };
    // Keep lastRemote current either way, so the moment this side's own ad
    // ends there's already a fresh target to catch up to, but don't touch
    // an ad that's actually playing right now: seeking it to a content
    // timestamp, or pausing/playing it to match, is meaningless at best and
    // can visibly glitch or restart the ad at worst.
    if (looksLikeAd()) return;
    // Only project the position forward if the video was actually playing at
    // the moment this was written. A paused video doesn't advance just
    // because time passed before this arrived, if it did, joining a room
    // (or reconnecting) minutes into someone else's pause would seek to
    // "where they'd be if they'd kept playing" instead of where they
    // actually are: sitting still.
    const elapsed = data.playing ? Math.max(0, (serverNow() - data.ts) / 1000) : 0;
    const localTime = data.time + elapsed;
    const current = currentTimeSeconds();
    const needsSeek = current == null || Math.abs(current - localTime) > 0.35;
    withRemoteGuard(() => {
      // See siteControls above: on a site where setting video.currentTime
      // directly isn't safe, route the same change through the site's own
      // player instead.
      if (siteControls) {
        if (needsSeek) siteControls.seek(localTime);
        if (data.playing) siteControls.play();
        if (!data.playing) siteControls.pause();
      } else {
        if (needsSeek) video.currentTime = localTime;
        if (data.playing && video.paused) video.play().catch(() => {});
        if (!data.playing && !video.paused) video.pause();
      }
    }, needsSeek);
  }

  let wasAdLike = false;
  function checkDrift() {
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
    if (adLike) return;
    if (!lastRemote || !lastRemote.playing || !video || applyingRemote) return;
    if (!isPlayingNow()) return;
    const current = currentTimeSeconds();
    if (current == null) return;
    const expected = lastRemote.time + (serverNow() - lastRemote.ts) / 1000;
    if (Math.abs(current - expected) > DRIFT_TOLERANCE_S) {
      withRemoteGuard(() => {
        if (siteControls) siteControls.seek(expected);
        else video.currentTime = expected;
      }, true);
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

  function connect() {
    if (es) es.close();
    if (reactionsEs) reactionsEs.close();
    if (clockTimer) clearInterval(clockTimer);
    if (presenceTimer) clearInterval(presenceTimer);
    if (staleCheckTimer) clearInterval(staleCheckTimer);
    if (!config || !config.roomId || !config.dbUrl) { onStatus('no-room'); return; }
    calibrateClock();
    clockTimer = setInterval(calibrateClock, CLOCK_RECALIBRATE_MS);
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
    es.onopen = () => { lastEventAt = Date.now(); onStatus('connected'); };
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
    videoListeners = {
      play: () => pushSync('play'),
      pause: () => pushSync('pause'),
      seeked: () => pushSync('seek'),
    };
    video.addEventListener('play', videoListeners.play);
    video.addEventListener('pause', videoListeners.pause);
    video.addEventListener('seeked', videoListeners.seeked);
    driftTimer = setInterval(checkDrift, DRIFT_CHECK_MS);
    // Firebase's stream delivers the room's current state once, right as the
    // connection opens (see connect()), which is how a newly-arriving video
    // would normally catch up to wherever the other person already is. But
    // that only fires once, at connect time, and this video element usually
    // isn't done loading yet when it does, so that catch-up gets silently
    // missed with nothing to retry it. Fetch the current state directly the
    // moment a video actually exists to attach it to, instead of only ever
    // reacting to the other person's next play, pause, or seek.
    if (config) fetch(roomUrl('sync')).then((r) => r.json()).then(applyRemote).catch(() => {});
    writeNowWatching();
  }

  function detachVideo() {
    if (video && videoListeners) {
      video.removeEventListener('play', videoListeners.play);
      video.removeEventListener('pause', videoListeners.pause);
      video.removeEventListener('seeked', videoListeners.seeked);
    }
    videoListeners = null;
    video = null;
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
