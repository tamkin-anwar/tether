// ---------------------------------------------------------------------------
// Prime Video adapter, for primevideo.com and Prime Video on Amazon's own
// storefronts (amazon.com/gp/video and friends). See site-common.js for the
// shared logic.
//
// Prime is different from every other site here in three ways, and each
// one changes how this adapter works:
//
// 1. Its <video> clock isn't the episode's clock. Ads are stitched into the
//    same stream as the show (server-side ad insertion), so video.currentTime
//    counts every ad watched so far, and two people who sat through
//    different ads (the normal case on the ad tier) are minutes apart on it
//    while being at the exact same scene. Even without ads, Prime builds the
//    stream with an offset of its own. The position shared with the other
//    person is the one Prime's own time bar shows, worked out from the
//    <video> clock minus a tracked offset (see OffsetTracker below), and
//    turned back into the <video> clock to seek.
//
// 2. It has no player page. The player opens as an overlay on top of the
//    title's detail page, with no change to the URL, and the detail page
//    itself autoplays a trailer in another <video>. So "is a title playing"
//    means "is the player overlay open with a video in it", and which
//    episode it is comes from the player's own title line, not the URL.
//
// 3. Its raw seeks are fragile. Rapid or repeated seeks can kill playback
//    ("Video Unavailable"), and each one rebuffers for most of a second, so
//    seeks are spaced out and small drift is tolerated longer than on other
//    sites.
//
// All of this reads Prime's markup, which isn't a public API and changes
// from time to time. Every read falls back to something safe if a class name
// stops matching: the <video> clock with the last known offset, and no ad
// detected, which is how every other site already behaves.
// ---------------------------------------------------------------------------

(function () {
  const PLAYER_SELECTOR = '.webPlayerSDKContainer, #dv-web-player';
  const SEEK_SPACING_MS = 1500;

  function visible(el) {
    return !!el && el.getClientRects().length > 0;
  }

  // The open player overlay, or null on a browse or detail page. Prime
  // keeps the overlay in the page, hidden, after you close it. And a title's
  // page autoplays its trailer, possibly in the same kind of player, which
  // must never be what gets synced (see netflix.js for what that did there),
  // so it has to be the real player: one with playback controls (the time
  // bar, the controls overlay), or, if Prime ever drops those class names,
  // one that fills most of the window, the way the player overlay does and a
  // trailer banner doesn't.
  function isFullPlayer(el) {
    if (el.querySelector('.atvwebplayersdk-timeindicator-text, .atvwebplayersdk-overlays-container')) return true;
    const r = el.getBoundingClientRect();
    return r.width >= window.innerWidth * 0.6 && r.height >= window.innerHeight * 0.6;
  }
  function playerBox() {
    for (const el of document.querySelectorAll(PLAYER_SELECTOR)) {
      if (visible(el) && isFullPlayer(el)) return el;
    }
    return null;
  }

  function findVideo() {
    const box = playerBox();
    if (!box) return null;
    // A video that has started loading something (an empty one is the
    // overlay mid-open), and not a looping one, which is a preview.
    const videos = [...box.querySelectorAll('video')]
      .filter((v) => !v.loop && (v.readyState >= 1 || (Number.isFinite(v.duration) && v.duration > 0)));
    if (videos.length <= 1) return videos[0] || null;
    return videos.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
  }

  function text(root, selector) {
    const el = root.querySelector(selector);
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  // ---------------------------------------------------------------------
  // Ads. Several signals, most specific first, because Prime renames these
  // classes now and then and A/B tests two versions of the ad timer at
  // once. All of them are scoped to the open player, and need visible text,
  // since an empty ad-timer element stays mounted between breaks.
  // ---------------------------------------------------------------------
  const AD_SELECTORS = [
    '[class*="atvwebplayersdk-ad-timer"]',
    '.atvwebplayersdk-adtimeindicator-text',
    '.atvwebplayersdk-skip-ad-button',
    '[aria-label*="playing ad" i]',
  ];
  // Always on screen, never an ad: the "go ad-free" upsell button, the
  // hidden resume message, and the skip-intro/recap buttons.
  const NOT_AD = '.atvwebplayersdk-go-ad-free-button, .atvwebplayersdk-ad-resume-message, .atvwebplayersdk-skipelement-button, .atvwebplayersdk-skipelements-button';
  // The player's own words during a break, for when every class above has
  // been renamed. The countdown renders as "Ad0:20", with no space, in the
  // player's language.
  const AD_TEXT = /(?:^|[^a-zÀ-ɏ])(?:ad|ads|anuncio|publicidad|werbung|publicité|pubblicità|reclame|reklam|propaganda)[^0-9a-z]{0,3}\d{1,2}:\d{2}|fast forward and rewind (?:are )?unavailable during ads/i;

  function adPlaying(box) {
    for (const selector of AD_SELECTORS) {
      for (const el of box.querySelectorAll(selector)) {
        if (el.closest(NOT_AD) || !visible(el)) continue;
        if (el.matches('[class*="skip-ad"]') || el.textContent.trim()) return true;
      }
    }
    const words = (box.innerText || '').slice(0, 4000);
    return AD_TEXT.test(words);
  }

  // ---------------------------------------------------------------------
  // The episode's own time, from Prime's time bar: "12:34 / 45:00", or
  // "12:34 / -32:26" when it's showing time remaining. Only the first number,
  // time elapsed, is needed.
  // ---------------------------------------------------------------------
  function shownTime(box) {
    const raw = text(box, '.atvwebplayersdk-timeindicator-text');
    const m = raw.match(/^(\d{1,2}(?::\d{2}){1,2})/);
    if (!m) return null;
    return { raw: m[1], seconds: m[1].split(':').reduce((a, b) => a * 60 + Number(b), 0) };
  }

  // Tracks (video clock) minus (episode clock).
  //
  // From the time bar: it only shows whole seconds, so one reading is only
  // good to within a second. But the moment the bar ticks over to a new
  // second is exact, so the offset is sampled at those ticks, polled four
  // times a second. A sample can only be up to one poll late, never early,
  // which makes the smallest recent sample the best estimate.
  //
  // Across an ad: the episode doesn't move while an ad plays, only the
  // video clock does, so the offset grows by exactly how far the video
  // clock ran during the break. That's applied the instant the ad ends,
  // without waiting on the time bar, which matters because the very next
  // thing sync-core does after an ad is catch up to the other person, and it
  // needs the right position to do that.
  //
  // A reading that disagrees with the estimate by more than a second and a
  // half (a seek that crossed an ad break, the next episode starting) only
  // replaces it once a second reading agrees, so one stale frame of the
  // time bar can't send a wrong position to anyone. Readings are skipped
  // while a seek settles, since the bar takes a moment to catch up.
  //
  // The time bar may stop updating while the player's controls are hidden.
  // Nothing new is sampled then and the last good offset stands, which is
  // right: the offset only changes at ads, seeks and episode changes.
  const OffsetTracker = {
    offset: null,       // best estimate, seconds
    samples: [],
    candidate: null,    // a disagreeing reading, waiting on a second to confirm it
    candidateAt: 0,
    lastRaw: null,
    lastSeconds: null,
    lastVideo: null,
    lastClock: null,    // video clock at the last non-ad tick
    inAd: false,
    adStartClock: null,
    settleUntil: 0,
    videoSince: 0,      // when this video was first seen

    reset() {
      this.videoSince = Date.now();
      this.offset = null;
      this.samples = [];
      this.candidate = null;
      this.lastRaw = null;
      this.lastSeconds = null;
      this.lastClock = null;
      this.inAd = false;
      this.adStartClock = null;
    },

    // A reading that disagrees with the estimate. True once confirmed.
    confirm(value) {
      if (this.candidate != null && Math.abs(this.candidate - value) <= 1.2) {
        this.candidate = null;
        return true;
      }
      this.candidate = value;
      this.candidateAt = Date.now();
      return false;
    },

    // While a disagreeing reading waits on confirmation, nobody can say
    // which offset is right, so nothing is read or seeked through it (see
    // getCurrentTime and doSeek below). Same for the first few seconds of a
    // new video before the time bar has given any reading at all: seeking
    // on a guessed offset of zero put someone joining mid-episode in the
    // wrong place. If the time bar never shows up (Prime changed its
    // markup), the plain video clock is used after that, which is still
    // right on any title without ads before the current point.
    get unsure() {
      return this.candidate != null || (this.offset == null && Date.now() - this.videoSince < 3000);
    },

    tick() {
      const box = playerBox();
      const v = box && findVideo();
      if (v !== this.lastVideo) { this.lastVideo = v; this.reset(); }
      if (!v) return;

      if (adPlaying(box)) {
        if (!this.inAd) { this.inAd = true; this.adStartClock = this.lastClock ?? v.currentTime; }
        this.lastRaw = null;
        return;
      }
      if (this.inAd) {
        this.inAd = false;
        if (this.offset != null && this.adStartClock != null) {
          this.offset += Math.max(0, v.currentTime - this.adStartClock);
        }
        this.samples = [];
        this.candidate = null;
      }
      if (v.seeking) { this.settleUntil = Date.now() + 600; this.lastRaw = null; return; }
      this.lastClock = v.currentTime;
      if (Date.now() < this.settleUntil) return;

      const shown = shownTime(box);
      if (!shown) return;
      if (shown.raw === this.lastRaw) {
        // The same reading, still standing half a second on, and still
        // consistent with the waiting one: the bar wasn't mid-update, so
        // that reading was right. Paused, this is the only way it can be
        // confirmed, since the bar won't tick again.
        if (this.unsure && Date.now() - this.candidateAt >= 500) {
          const again = v.currentTime - shown.seconds - 0.5;
          if (Math.abs(again - this.candidate) <= 1.2) {
            this.offset = this.candidate;
            this.samples = [];
            this.candidate = null;
          }
        }
        return;
      }
      const raw = v.currentTime - shown.seconds;
      const step = this.lastSeconds == null ? null : shown.seconds - this.lastSeconds;
      this.lastRaw = shown.raw;
      this.lastSeconds = shown.seconds;

      if (step === 1 && !v.paused) {
        // A normal one-second tick while playing: a precise sample.
        if (this.offset == null || Math.abs(raw - this.offset) <= 1.5) {
          this.candidate = null;
          this.samples.push(raw);
          if (this.samples.length > 8) this.samples.shift();
        } else if (this.confirm(raw)) {
          this.samples = [raw];
        } else {
          return;
        }
        this.offset = Math.min(...this.samples) - 0.1;
      } else {
        // A jump (a seek, the player opening, the controls coming back):
        // the episode is somewhere in the second shown, so the middle of it.
        const rough = raw - 0.5;
        if (this.offset == null || (Math.abs(rough - this.offset) > 1.5 && this.confirm(rough))) {
          this.samples = [];
          this.offset = rough;
        }
      }
    },
  };
  setInterval(() => OffsetTracker.tick(), 250);

  // ---------------------------------------------------------------------
  // Which title and episode. The URL's id is the series (or the movie), and
  // it stays the same from one episode to the next, so the episode comes
  // from the player's title line ("Season 1, Ep. 3 ..."), read as numbers
  // so it matches whatever language each of you has Prime in. Chrome's
  // media session metadata is a second source for the same.
  //
  // Two people can arrive at the same show by different ids (one on
  // primevideo.com, one on amazon.com, which number titles differently),
  // or see its name in different languages, so a show matches on either
  // one, and an episode matches if either side couldn't read it yet. Kept
  // as one string, the shape sync-core.js already sends.
  // ---------------------------------------------------------------------
  const ID = /\/(?:detail|dp)\/(?:[^/]+\/)?([A-Z0-9]{10,40}|amzn1\.dv\.gti\.[0-9a-f-]{36})(?:[/?#]|$)/i;

  function episodeOf(...texts) {
    for (const t of texts) {
      if (!/(season|staffel|temporada|saison|stagione|seizoen|sezon|\bs\s*\d)/i.test(t || '')) continue;
      const m = t.match(/(\d{1,3})\D{1,24}?(\d{1,4})/);
      if (m) return m[1] + '-' + m[2];
    }
    for (const t of texts) {
      const m = (t || '').match(/(?:ep\.?|episode|folge|episodio|épisode|aflevering|odcinek)\s*(\d{1,4})/i);
      if (m) return '0-' + m[1];
    }
    return '';
  }

  function contentKey() {
    const box = playerBox();
    const meta = navigator.mediaSession?.metadata;
    const id = (location.pathname.match(ID)?.[1] || '').toUpperCase();
    const titleText = (box && text(box, '.atvwebplayersdk-title-text')) || meta?.title || '';
    const title = titleText.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 80);
    const ep = episodeOf(box && text(box, '.atvwebplayersdk-subtitle-text'), meta?.artist, meta?.album);
    return ['pv', id, title, ep].join('|');
  }

  function parseKey(key) {
    const [site, id, title, ep] = String(key).split('|');
    return site === 'pv' ? { id, title, ep } : null;
  }

  function sameContent(theirs, mine) {
    const a = parseKey(theirs);
    const b = parseKey(mine);
    if (!a || !b) return theirs === mine;
    const aKnown = a.id || a.title;
    const bKnown = b.id || b.title;
    const sameShow = !aKnown || !bKnown || (a.id && a.id === b.id) || (a.title && a.title === b.title);
    // "0-3" is an episode number read without its season (see episodeOf);
    // against a full "1-3" from the other side, compare episode numbers only.
    const epNum = (ep) => ep.split('-')[1];
    const sameEpisode = !a.ep || !b.ep || a.ep === b.ep ||
      ((a.ep.startsWith('0-') || b.ep.startsWith('0-')) && epNum(a.ep) === epNum(b.ep));
    return !!(sameShow && sameEpisode);
  }

  // ---------------------------------------------------------------------
  // Controls, all through the <video> element: unlike Netflix and Disney+,
  // Prime has no player object to talk to, and this is what every working
  // Prime watch-party tool does. Seeks are spaced at least SEEK_SPACING_MS
  // apart; one that arrives sooner waits, and only the latest target is
  // kept, so a burst of corrections becomes a single seek.
  // ---------------------------------------------------------------------
  let lastSeekAt = 0;
  let pendingSeek = null;
  let pendingTimer = null;

  // Brought up to date on every read too, not just on the timer, so an ad
  // that ended a moment ago is already accounted for.
  function offsetNow() {
    OffsetTracker.tick();
    return OffsetTracker.offset ?? 0;
  }

  // `requestedAt` because a seek can wait here (spacing, or an offset not yet
  // known) while the show keeps playing; the target moves on with it, or it
  // lands exactly as far behind as it waited.
  function doSeek(episodeSeconds, requestedAt) {
    const v = findVideo();
    if (!v) return;
    offsetNow();
    if (OffsetTracker.unsure && Date.now() - requestedAt < 3500) {
      setTimeout(() => doSeek(episodeSeconds, requestedAt), 250);
      return;
    }
    const waited = v.paused ? 0 : (Date.now() - requestedAt) / 1000 * (v.playbackRate || 1);
    lastSeekAt = Date.now();
    try { v.currentTime = Math.max(0, episodeSeconds + waited + offsetNow()); } catch (e) { /* not seekable yet */ }
  }

  window.TetherSite.start(findVideo, {
    seek(seconds) {
      const now = Date.now();
      const wait = SEEK_SPACING_MS - (now - lastSeekAt);
      if (wait <= 0) { doSeek(seconds, now); return; }
      pendingSeek = { seconds, at: now };
      if (pendingTimer) return;
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        if (pendingSeek) doSeek(pendingSeek.seconds, pendingSeek.at);
        pendingSeek = null;
      }, wait);
    },
    play() {
      const v = findVideo();
      if (v && v.paused) v.play().catch(() => {});
    },
    pause() {
      const v = findVideo();
      if (v && !v.paused) v.pause();
    },
    getCurrentTime() {
      const v = findVideo();
      if (!v) return null;
      const offset = offsetNow();
      return OffsetTracker.unsure ? null : Math.max(0, v.currentTime - offset);
    },
    isAdPlaying() {
      if (!playerBox()) return null;
      OffsetTracker.tick();
      return OffsetTracker.inAd;
    },
    contentKey,
    sameContent,
    driftToleranceS: 1,
  });
})();
