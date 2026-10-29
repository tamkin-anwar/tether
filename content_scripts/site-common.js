// ---------------------------------------------------------------------------
// Shared by every site adapter (netflix.js, hulu.js, prime.js, ...). Each of
// these streaming sites is a single-page app that swaps a <video> element in
// and out as you browse and watch, so the "find the video, watch for it
// changing" logic is identical across all of them, as is everything Tether
// draws on the page: the status badge, reactions, chat, notices of what the
// other person did, and the offer to join them on another title. A site
// adapter only needs to say how to find its video element.
// ---------------------------------------------------------------------------

(function () {
  // Every string comes from _locales/<the person's Chrome language>, with
  // English as the fallback (see tools/build_locales.py).
  const tr = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String)) || key;
  const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif';
  const GLASS = `
    background: rgba(28,28,30,0.82); backdrop-filter: blur(14px) saturate(1.6);
    -webkit-backdrop-filter: blur(14px) saturate(1.6);
    box-shadow: 0 4px 20px rgba(0,0,0,0.35), 0 0 0 0.5px rgba(255,255,255,0.08) inset;
  `;

  // ---------------------------------------------------------------------
  // One container for everything Tether draws. It has to follow the player
  // into fullscreen: a fullscreen element is drawn above the rest of the
  // page, so anything left outside it (where all of this used to live) was
  // hidden for exactly the way most people watch. On every fullscreen
  // change it moves into the fullscreen element, and back out after.
  // ---------------------------------------------------------------------
  const root = document.createElement('div');
  root.setAttribute('data-tether-overlay', '');
  root.style.cssText = `all: initial; position: fixed; inset: 0; pointer-events: none;
    z-index: 2147483647; font-family: ${FONT}; color: #fff;`;
  let gone = false; // Tether was updated or reloaded under this tab (see start)
  function placeRoot() {
    if (gone) return;
    const fs = document.fullscreenElement || document.webkitFullscreenElement;
    // A bare <video> can't hold anything; the sites here fullscreen a
    // container around it, but just in case, stay put rather than vanish.
    const parent = fs && fs.tagName !== 'VIDEO' ? fs : document.documentElement;
    if (root.parentNode !== parent) parent.appendChild(root);
  }
  // In fullscreen this sits inside the player, so a click on the chat or a
  // reaction would bubble up to it: a click toggles pause, a double-click
  // leaves fullscreen, a key press on a focused button seeks. Nothing that
  // happens on Tether's own controls is the player's business.
  for (const type of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup',
    'touchstart', 'touchend', 'wheel', 'keydown', 'keyup', 'keypress', 'contextmenu']) {
    root.addEventListener(type, (e) => e.stopPropagation());
  }
  document.addEventListener('fullscreenchange', placeRoot);
  document.addEventListener('webkitfullscreenchange', placeRoot);
  placeRoot();

  // Where Tether sits: the middle of the right edge. Every streaming player
  // puts its own buttons along the bottom (play, volume, subtitles, speed,
  // fullscreen, "Skip intro", "Next episode", "Skip ad") and in the top
  // corners (back, report, and on Prime Video, volume and fullscreen too).
  // Halfway down the right edge is the one place none of them use.
  const EDGE = 16;
  const DOCK_HALF = 35; // half the height of the chat and reaction buttons stacked

  function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }

  // The buttons fade back once the mouse has been still for a few seconds,
  // the way the players' own controls do, so they're there when you reach
  // for them and out of the picture while you watch.
  let idleTimer = null;
  let controlsEl = null;
  function wake() {
    if (controlsEl) controlsEl.style.opacity = '1';
    clearTimeout(idleTimer);
    if (startButton) startButton.style.opacity = '1';
    idleTimer = setTimeout(() => {
      if (controlsEl && !chatOpen && !pickerOpen) controlsEl.style.opacity = '0';
      if (startButton) startButton.style.opacity = '0';
    }, 3000);
  }
  document.addEventListener('mousemove', wake, { passive: true });

  // ---------------------------------------------------------------------
  // Status badge
  // ---------------------------------------------------------------------
  // ---------------------------------------------------------------------
  // One-time tips: the first time someone sees the "Watch together" button,
  // and the first time they're in a session, a short note says what it's
  // for. Each shows once per browser, ever, and goes away on its own.
  // ---------------------------------------------------------------------
  const TIPS_KEY = 'tetherTips';
  let tipsSeen = null; // loaded from storage before any tip can show
  try { chrome.storage.local.get([TIPS_KEY], (l) => { tipsSeen = l[TIPS_KEY] || {}; }); } catch (e) { tipsSeen = {}; }
  let tipEl = null;
  let tipFor = null; // which status it explains; gone once that changes
  function closeTip() {
    if (!tipEl) return;
    const node = tipEl;
    tipEl = null;
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 300);
  }
  function showTip(id, text, top) {
    if (!tipsSeen || tipsSeen[id] || tipEl || chatOpen) return;
    tipsSeen = { ...tipsSeen, [id]: true };
    try { chrome.storage.local.set({ [TIPS_KEY]: tipsSeen }); } catch (e) { /* extension reloaded */ }
    tipEl = el('div', `position: fixed; top: ${top}; right: ${EDGE}px; max-width: 250px; pointer-events: auto;
      font: 400 12.5px/1.4 ${FONT}; color: #fff; padding: 10px 30px 10px 12px; border-radius: 12px; ${GLASS}
      transition: opacity 0.3s ease, transform 0.3s ease; opacity: 0; transform: translateY(6px);`, text);
    const x = el('button', `all: initial; position: absolute; top: 6px; right: 8px; cursor: pointer;
      font: 500 13px ${FONT}; color: rgba(255,255,255,0.6);`, '✕');
    x.setAttribute('aria-label', tr('dismiss'));
    const node = tipEl;
    const close = () => { if (tipEl === node) closeTip(); };
    x.addEventListener('click', close);
    tipEl.appendChild(x);
    root.appendChild(tipEl);
    requestAnimationFrame(() => { node.style.opacity = '1'; node.style.transform = 'translateY(0)'; });
    setTimeout(() => { node.style.opacity = '1'; node.style.transform = 'translateY(0)'; }, 50);
    setTimeout(close, 12000);
  }
  function maybeTip(status) {
    tipFor = status;
    if (status === 'off') showTip('start', tr('tipStart'), 'calc(50% + 26px)');
    if (status === 'connected') showTip('session', tr('tipSession'), `calc(50% + ${DOCK_HALF + 10}px)`);
  }

  let statusBadge = null;
  let currentStatus = null;
  let partnerNow = null;
  function onPartner({ partner, first }) {
    const was = partnerNow;
    partnerNow = partner;
    if (first) {
      if (partner) showNotice(tr('noticeWatchingWith', partner.name || tr('partnerFallback')));
    } else if (partner && !was) {
      showNotice(tr('noticeJoined', partner.name || tr('partnerFallback')));
    } else if (!partner && was) {
      showNotice(tr('noticeLeft', was.name || tr('partnerFallback')));
    }
    if (currentStatus === 'connected') showStatus('connected');
  }
  function showStatus(status) {
    currentStatus = status;
    if (tipEl && tipFor !== status) closeTip();
    // Tips load from storage a moment after the page does; give them that moment.
    setTimeout(() => { if (currentStatus === status) maybeTip(status); }, 1500);
    // Not watching together: none of the session's UI, just the offer to
    // start one on a player page (see buildStartButton).
    const off = status === 'off' || status === 'off-browse';
    // Chat and reactions only in the tab that's connected (see sync-core's
    // one-tab rule); a tab standing by isn't receiving either.
    const live = status === 'connected' || status === 'disconnected';
    if (controlsEl) controlsEl.style.display = live ? 'flex' : 'none';
    // The chat's connection belongs to the tab in charge; standing by or
    // idle, an open panel would be talking to nothing.
    if (!live && chatOpen) setChatOpen(false);
    if (startButton) startButton.style.display = status === 'off' ? 'flex' : 'none';
    if (off) {
      if (statusBadge) { statusBadge.style.opacity = '0'; statusBadge.style.transform = 'translateY(6px)'; }
      return;
    }
    if (!statusBadge) {
      statusBadge = el('div', `
        position: fixed; bottom: calc(50% + ${DOCK_HALF + 10}px); right: ${EDGE}px;
        font: 590 12.5px ${FONT}; padding: 8px 14px 8px 10px; border-radius: 999px; color: #fff;
        display: flex; align-items: center; gap: 7px; pointer-events: none; ${GLASS}
        transition: opacity 0.35s ease, transform 0.35s ease; opacity: 0; transform: translateY(6px);
      `);
      statusBadge._dot = el('span', 'width:7px;height:7px;border-radius:50%;flex-shrink:0;transition:background 0.25s;');
      statusBadge._label = el('span');
      statusBadge.append(statusBadge._dot, statusBadge._label);
      root.appendChild(statusBadge);
    }
    const who = partnerNow && partnerNow.name;
    const labels = {
      connected: partnerNow ? [who ? tr('statusInSyncWith', who) : tr('statusInSync'), '#34c759'] : [tr('statusWaitingJoin'), '#0a84ff'],
      idle: [tr('statusIdle'), '#8e8e93'],
      standby: [tr('statusStandby'), '#8e8e93'],
      disconnected: [tr('statusReconnecting'), '#ff9f0a'],
      'no-room': [tr('statusNoRoom'), '#8e8e93'],
    };
    const [text, color] = labels[status] || ['', '#8e8e93'];
    statusBadge._label.textContent = text;
    statusBadge._dot.style.background = color;
    clearTimeout(showStatus._t);
    if (chatOpen) return; // the open chat has that space; the label is updated for later
    statusBadge.style.opacity = '1';
    statusBadge.style.transform = 'translateY(0)';
    // Every other state is a passing ping ("yep, synced") that's fine to fade
    // after a few seconds. 'no-room' means nothing is set up at all, still
    // true indefinitely until someone joins a room, so it stays on screen.
    if (status !== 'no-room') {
      showStatus._t = setTimeout(() => {
        statusBadge.style.opacity = '0';
        statusBadge.style.transform = 'translateY(6px)';
      }, 3500);
    }
  }

  // ---------------------------------------------------------------------
  // Notices along the top: what the other person just did, and the offer to
  // join them when they're on another title.
  // ---------------------------------------------------------------------
  const noticeStack = el('div', `
    position: fixed; top: max(88px, 11vh); left: 50%; transform: translateX(-50%);
    display: flex; flex-direction: column; align-items: center; gap: 8px; pointer-events: none;
  `);
  root.appendChild(noticeStack);

  function pill(css) {
    return el('div', `font: 590 13px ${FONT}; color: #fff; padding: 8px 14px; border-radius: 999px; ${GLASS}
      transition: opacity 0.3s ease, transform 0.3s ease; opacity: 0; transform: translateY(-6px); ${css || ''}`);
  }
  function reveal(node) {
    requestAnimationFrame(() => { node.style.opacity = '1'; node.style.transform = 'translateY(0)'; });
    // rAF doesn't run in a background tab; make sure it still shows when you come back.
    setTimeout(() => { node.style.opacity = '1'; node.style.transform = 'translateY(0)'; }, 50);
  }
  function dismiss(node) {
    node.style.opacity = '0';
    node.style.transform = 'translateY(-6px)';
    setTimeout(() => node.remove(), 300);
  }

  let actionNotice = null;
  function showNotice(text) {
    if (actionNotice) actionNotice.remove();
    const n = pill();
    n.textContent = text;
    actionNotice = n;
    noticeStack.appendChild(n);
    reveal(n);
    setTimeout(() => { if (actionNotice === n) { actionNotice = null; } dismiss(n); }, 2600);
  }

  function clock(seconds) {
    const s = Math.max(0, Math.round(seconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }
  function describe(action) {
    const who = action.name || tr('partnerFallback');
    if (action.type === 'pause') return tr('actionPaused', who);
    if (action.type === 'play') return tr('actionPlayed', who);
    if (action.type === 'seek') return tr('actionSkipped', who, clock(action.time));
    if (action.type === 'rate') return action.rate === 1 ? tr('actionSpeedNormal', who) : tr('actionSpeed', who, action.rate);
    return null;
  }

  // The other person started watching together: offered, never forced.
  // Nothing about this tab changes until you choose to join.
  let inviteBanner = null;
  let dismissedInvite = null;
  function showInvite(info) {
    if (inviteBanner) { dismiss(inviteBanner); inviteBanner = null; }
    if (!info || info.key === dismissedInvite) return;
    const b = pill('display: flex; align-items: center; gap: 10px; padding: 6px 6px 6px 14px; pointer-events: auto;');
    b.append(el('span', '', tr('inviteStarted', info.name || tr('partnerFallback'))));
    const join = el('button', `all: initial; cursor: pointer; font: 600 12.5px ${FONT}; color: #fff;
      background: #007aff; padding: 6px 12px; border-radius: 999px;`, tr('join'));
    join.addEventListener('click', () => {
      window.TetherSync.startSession();
      showNotice(tr('watchingTogetherWith', info.name || tr('partnerFallback')));
    });
    const close = el('button', `all: initial; cursor: pointer; font: 500 14px ${FONT}; color: rgba(255,255,255,0.7);
      padding: 4px 8px;`, '✕');
    close.setAttribute('aria-label', tr('notNow'));
    close.addEventListener('click', () => {
      dismissedInvite = info.key; // until they start a new one
      dismiss(b);
      if (inviteBanner === b) inviteBanner = null;
    });
    b.append(join, close);
    inviteBanner = b;
    noticeStack.appendChild(b);
    reveal(b);
  }

  // Starting a session from the video itself. Also copies the invite link,
  // for someone who isn't in the room yet; someone who already is gets the
  // invite on their own screen.
  let startButton = null;
  function buildStartButton() {
    startButton = el('button', `all: initial; position: fixed; top: 50%; right: ${EDGE}px; transform: translateY(-50%); cursor: pointer;
      display: none; align-items: center; gap: 7px; font: 600 12.5px ${FONT}; color: #fff;
      padding: 8px 14px; border-radius: 999px; pointer-events: auto; transition: opacity 0.4s ease; ${GLASS}`);
    startButton.append(el('span', 'font-size: 13px;', '👥'), el('span', '', tr('startButton')));
    startButton.title = tr('sessionStart');
    startButton.addEventListener('click', async () => {
      const code = window.TetherSync.roomId;
      window.TetherSync.startSession();
      let copied = false;
      try {
        await navigator.clipboard.writeText(`https://tamkin-anwar.github.io/tether/join.html?code=${code}`);
        copied = true;
      } catch (e) { /* the popup has the link too */ }
      showNotice(tr(copied ? 'startedCopied' : 'startedShare'));
      closeTip();
    });
    root.appendChild(startButton);
  }

  let elsewhereBanner = null;
  function showElsewhere(info) {
    if (elsewhereBanner) { dismiss(elsewhereBanner); elsewhereBanner = null; }
    if (!info) return;
    const b = pill('display: flex; align-items: center; gap: 10px; padding: 6px 6px 6px 14px; pointer-events: auto;');
    b.append(el('span', '', tr('elsewhere', info.name || tr('partnerFallback'))));
    const go = el('button', `all: initial; cursor: pointer; font: 600 12.5px ${FONT}; color: #fff;
      background: #007aff; padding: 6px 12px; border-radius: 999px;`, tr('joinThem'));
    // The whole tab, even from a player in a frame of its own (Crunchyroll's).
    go.addEventListener('click', () => { const u = window.TetherSync.safeUrl(info.url); if (u) window.top.location.href = u; });
    const close = el('button', `all: initial; cursor: pointer; font: 500 14px ${FONT}; color: rgba(255,255,255,0.7);
      padding: 4px 8px;`, '✕');
    close.setAttribute('aria-label', tr('dismiss'));
    close.addEventListener('click', () => { dismiss(b); if (elsewhereBanner === b) elsewhereBanner = null; });
    b.append(go, close);
    elsewhereBanner = b;
    noticeStack.appendChild(b);
    reveal(b);
  }

  // ---------------------------------------------------------------------
  // Reactions: a floating emoji burst either of you can send, seen on both
  // tabs, right on the video you're both looking at.
  // ---------------------------------------------------------------------
  const REACTIONS = [
    { emoji: '❤️', label: tr('reactLove') },
    { emoji: '😂', label: tr('reactLaugh') },
    { emoji: '😮', label: tr('reactWow') },
    { emoji: '👏', label: tr('reactClap') },
    { emoji: '😢', label: tr('reactSad') },
  ];
  const style = document.createElement('style');
  style.textContent = `
    @keyframes tether-float-up {
      0% { transform: translateY(0) scale(0.6); opacity: 0; }
      15% { transform: translateY(-10px) scale(1); opacity: 1; }
      100% { transform: translateY(-160px) scale(1.15); opacity: 0; }
    }
    [data-tether-overlay] input::placeholder { color: rgba(255,255,255,0.45); }
  `;
  root.appendChild(style);

  // Shown for a reaction from the other person, and immediately for your own
  // rather than after a network round trip.
  // Only the five on offer: the room is shared, and anything else sent this
  // way would be someone's text drawn large over the video.
  function showReaction(emoji) {
    if (!REACTIONS.some((x) => x.emoji === emoji)) return;
    const jitter = (Math.random() - 0.5) * 40; // simultaneous reactions don't perfectly overlap
    const r = el('div', `position: fixed; top: calc(50% - ${DOCK_HALF + 90}px); right: ${EDGE + 20 - jitter}px; font-size: 34px;
      pointer-events: none; animation: tether-float-up 1.8s ease-out forwards;`, emoji);
    root.appendChild(r);
    setTimeout(() => r.remove(), 1800);
  }

  function roundButton(label, glyph) {
    const b = el('button', `all: initial; width: 32px; height: 32px; border-radius: 50%; cursor: pointer;
      font-size: 15px; display: flex; align-items: center; justify-content: center; position: relative;
      flex-shrink: 0; ${GLASS}`, glyph);
    b.title = label;
    b.setAttribute('aria-label', label);
    return b;
  }

  let pickerOpen = false;
  let chatOpen = false;

  // ---------------------------------------------------------------------
  // Chat, on the page. The popup has always had chat, but the popup closes
  // the moment you click back onto the video, so talking meant reopening it
  // for every message. This is the same conversation (same messages, both
  // ways), always a click away while you watch. While it's closed, a new
  // message from the other person shows up briefly on its own, with a count
  // on the button until you open it.
  // ---------------------------------------------------------------------
  let chatPanel = null;
  let chatLog = null;
  let chatInput = null;
  let chatButton = null;
  let unreadBadge = null;
  let messages = {};
  const seen = new Set();
  let unread = 0;
  // Newest on top, nearest the buttons. Clipped above the bottom quarter of
  // the screen, where the players keep "Skip intro" and "Next episode".
  const toastStack = el('div', `position: fixed; top: calc(50% + ${DOCK_HALF + 10}px); right: ${EDGE}px; display: flex;
    flex-direction: column; align-items: flex-end; gap: 6px; pointer-events: none; max-width: 300px;
    max-height: calc(25% - ${DOCK_HALF + 10}px); overflow: hidden;`);
  root.appendChild(toastStack);

  function setUnread(n) {
    unread = n;
    if (!unreadBadge) return;
    unreadBadge.textContent = n > 9 ? '9+' : String(n);
    unreadBadge.style.display = n ? 'flex' : 'none';
  }

  function renderChat() {
    if (!chatLog) return;
    const me = window.TetherSync.clientId;
    const items = Object.values(messages).filter((m) => m && m.text).sort((a, b) => a.ts - b.ts).slice(-40);
    const nearBottom = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 40;
    chatLog.textContent = '';
    if (!items.length) {
      chatLog.appendChild(el('div', `font: 400 12px ${FONT}; color: rgba(255,255,255,0.5); text-align: center; padding: 24px 0;`,
        tr('chatEmpty')));
      return;
    }
    let lastSender = null;
    for (const m of items) {
      const mine = m.from === me;
      if (!mine && m.name && m.from !== lastSender) {
        chatLog.appendChild(el('div', `font: 600 10.5px ${FONT}; color: rgba(255,255,255,0.55); margin: 4px 2px 0;`, m.name));
      }
      lastSender = m.from;
      chatLog.appendChild(el('div', `font: 400 13px/1.35 ${FONT}; max-width: 80%; padding: 7px 11px; border-radius: 16px;
        overflow-wrap: anywhere; white-space: pre-wrap; align-self: ${mine ? 'flex-end' : 'flex-start'};
        background: ${mine ? '#007aff' : 'rgba(255,255,255,0.14)'}; color: #fff;
        ${mine ? 'border-bottom-right-radius: 4px;' : 'border-bottom-left-radius: 4px;'}`, m.text));
    }
    if (nearBottom || !chatLog._scrolled) { chatLog.scrollTop = chatLog.scrollHeight; chatLog._scrolled = true; }
  }

  function toastMessage(m) {
    const t = el('div', `font: 400 13px/1.35 ${FONT}; color: #fff; padding: 8px 12px; border-radius: 14px; ${GLASS}
      overflow-wrap: anywhere; transition: opacity 0.3s ease, transform 0.3s ease; opacity: 0; transform: translateY(6px);`);
    if (m.name) t.appendChild(el('div', `font: 600 11px ${FONT}; color: rgba(255,255,255,0.6); margin-bottom: 2px;`, m.name));
    t.appendChild(el('div', '', m.text.length > 140 ? m.text.slice(0, 140) + '…' : m.text));
    closeTip(); // it sits in the same spot
    toastStack.prepend(t);
    while (toastStack.children.length > 3) toastStack.lastChild.remove();
    requestAnimationFrame(() => { t.style.opacity = '1'; t.style.transform = 'translateY(0)'; });
    setTimeout(() => { t.style.opacity = '1'; t.style.transform = 'translateY(0)'; }, 50);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 6000);
  }

  function onChat({ messages: next, initial }) {
    messages = next;
    const me = window.TetherSync.clientId;
    for (const [key, m] of Object.entries(next)) {
      if (seen.has(key)) continue;
      seen.add(key);
      // History already there when the page loaded isn't news.
      if (initial || !m || m.from === me || !m.text) continue;
      if (!chatOpen) { setUnread(unread + 1); toastMessage(m); }
    }
    renderChat();
  }

  function setChatOpen(open) {
    chatOpen = open;
    chatPanel.style.display = open ? 'flex' : 'none';
    toastStack.style.display = open ? 'none' : 'flex';
    if (open) {
      // The panel takes the space beside the buttons; nothing else stays there.
      closeTip();
      if (statusBadge) { statusBadge.style.opacity = '0'; statusBadge.style.transform = 'translateY(6px)'; }
      setUnread(0);
      chatLog._scrolled = false;
      renderChat();
      setTimeout(() => chatInput.focus(), 0);
    } else {
      chatInput.blur();
      // Whatever the status became while the panel had its spot.
      if (currentStatus && currentStatus !== 'off' && currentStatus !== 'off-browse') showStatus(currentStatus);
    }
    wake();
  }

  function buildChat() {
    chatPanel = el('div', `position: fixed; top: 50%; transform: translateY(-50%); right: ${EDGE + 44}px; width: 300px;
      max-height: min(420px, calc(100vh - 2 * max(88px, 11vh) - 80px));
      display: none; flex-direction: column; border-radius: 16px; overflow: hidden; pointer-events: auto; ${GLASS}`);
    const head = el('div', `display: flex; align-items: center; justify-content: space-between; padding: 10px 12px 6px 14px;
      font: 600 13px ${FONT}; color: #fff;`);
    head.append(el('span', '', tr('chatTitle')));
    const end = el('button', `all: initial; cursor: pointer; font: 500 12px ${FONT}; color: rgba(255,255,255,0.6);
      padding: 2px 6px; margin-left: auto; margin-right: 4px;`, tr('sessionEnd'));
    end.title = tr('endSessionTitle');
    end.addEventListener('click', () => { window.TetherSync.endSession(); showNotice(tr('stoppedTogether')); });
    head.append(end);
    const close = el('button', `all: initial; cursor: pointer; font: 500 14px ${FONT}; color: rgba(255,255,255,0.7); padding: 2px 6px;`, '✕');
    close.setAttribute('aria-label', tr('closeChat'));
    close.addEventListener('click', () => setChatOpen(false));
    head.append(close);
    chatLog = el('div', `flex: 1; min-height: 120px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px;
      padding: 4px 12px 8px;`);
    const row = el('div', 'display: flex; gap: 6px; padding: 8px 10px 10px; border-top: 0.5px solid rgba(255,255,255,0.12);');
    chatInput = el('input', `all: initial; flex: 1; min-width: 0; font: 400 13px ${FONT}; color: #fff;
      background: rgba(255,255,255,0.12); border-radius: 10px; padding: 8px 10px;`);
    chatInput.type = 'text';
    chatInput.maxLength = 500;
    chatInput.placeholder = tr('messagePlaceholder');
    chatInput.setAttribute('aria-label', tr('messagePlaceholder'));
    const send = el('button', `all: initial; cursor: pointer; font: 600 12.5px ${FONT}; color: #fff;
      background: #007aff; border-radius: 10px; padding: 8px 12px;`, tr('send'));
    const submit = () => {
      if (!chatInput.value.trim()) return;
      window.TetherSync.sendChat(chatInput.value);
      chatInput.value = '';
    };
    send.addEventListener('click', submit);
    // Typing here must never reach the player: the space bar would pause,
    // "f" would go fullscreen, arrows would seek. Stopped at the field itself,
    // before the site's own keyboard shortcuts hear it. isComposing: Enter
    // also confirms a word typed through an input method (Bengali, Japanese,
    // Chinese, ...) and mustn't send it half-typed.
    for (const type of ['keydown', 'keyup', 'keypress']) {
      chatInput.addEventListener(type, (e) => {
        e.stopPropagation();
        if (type === 'keydown' && e.key === 'Enter' && !e.isComposing) submit();
        if (type === 'keydown' && e.key === 'Escape') setChatOpen(false);
      });
    }
    row.append(chatInput, send);
    chatPanel.append(head, chatLog, row);
    root.appendChild(chatPanel);
  }

  function buildControls() {
    controlsEl = el('div', `position: fixed; top: 50%; right: ${EDGE}px; transform: translateY(-50%);
      display: flex; flex-direction: column; align-items: center; gap: 6px; pointer-events: auto; transition: opacity 0.4s ease;`);
    const row = el('div', `position: absolute; top: 0; right: 38px; display:flex; gap:4px; opacity:0; transform:translateX(6px);
      pointer-events:none; transition:opacity 0.2s, transform 0.2s;`);
    function setPickerOpen(open) {
      pickerOpen = open;
      row.style.opacity = open ? '1' : '0';
      row.style.transform = open ? 'translateX(0)' : 'translateX(6px)';
      row.style.pointerEvents = open ? 'auto' : 'none';
      wake();
    }
    for (const { emoji, label } of REACTIONS) {
      const b = roundButton(label, emoji);
      b.addEventListener('click', () => {
        showReaction(emoji);
        window.TetherSync.sendReaction(emoji);
        setPickerOpen(false);
      });
      row.appendChild(b);
    }
    const reactToggle = roundButton(tr('sendReaction'), '🙂');
    reactToggle.addEventListener('click', () => { if (chatOpen) setChatOpen(false); setPickerOpen(!pickerOpen); });

    chatButton = roundButton(tr('chatTitle'), '💬');
    unreadBadge = el('span', `position: absolute; top: -4px; right: -4px; min-width: 16px; height: 16px; padding: 0 4px;
      box-sizing: border-box; border-radius: 999px; background: #ff3b30; color: #fff; font: 700 10px ${FONT};
      display: none; align-items: center; justify-content: center;`);
    chatButton.appendChild(unreadBadge);
    chatButton.addEventListener('click', () => { setPickerOpen(false); setChatOpen(!chatOpen); });

    controlsEl.append(row, reactToggle, chatButton);
    root.appendChild(controlsEl);
    wake();
  }

  window.TetherSite = {
    /** Call once per site adapter with a function that returns the current
     *  <video> element (or null), and an optional { seek(s), play(), pause() }
     *  for sites where setting video.currentTime/play()/pause() directly
     *  isn't safe (see netflix.js). Handles watching for the video being
     *  swapped out and wiring up everything drawn on the page. */
    start(findVideo, playerControls) {
      buildControls();
      buildChat();
      buildStartButton();
      window.TetherSync.on('invite', showInvite);
      window.TetherSync.on('partner', onPartner);
      window.TetherSync.on('chat', onChat);
      window.TetherSync.on('action', (a) => { const t = describe(a); if (t) showNotice(t); });
      window.TetherSync.on('elsewhere', showElsewhere);
      window.TetherSync.init(showStatus, showReaction, playerControls);

      let current = null;
      // Coalesced, not run once per mutation: this observer watches the
      // entire page for any DOM change, and a busy streaming site re-renders
      // constantly (carousels, subtitles, UI chrome) even when the video
      // itself never changes. findVideo() re-scans every <video> element on
      // some sites, so running it on every single mutation batch is real,
      // needless CPU work.
      //
      // setTimeout, deliberately not requestAnimationFrame: Chrome pauses
      // rAF entirely in background tabs and minimized windows, so an episode
      // autoplaying while this tab wasn't in front never got attached until
      // someone came back to it, silently unsynced the whole time. setTimeout
      // is only throttled in the background, never stopped.
      let checkScheduled = false;
      function check() {
        placeRoot(); // a site can rebuild the page around us; stay attached
        const v = findVideo();
        if (v !== current) {
          current = v;
          window.TetherSync.setVideo(v);
        }
      }
      const observer = new MutationObserver(() => {
        if (checkScheduled) return;
        checkScheduled = true;
        setTimeout(() => {
          checkScheduled = false;
          check();
        }, 50);
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      // Plus a slow check on a timer, for changes no element is added or
      // removed for: Prime Video shows and hides its player overlay with CSS
      // alone, and a <video> becoming ready to play (which some adapters wait
      // for) changes nothing in the DOM at all.
      const checkTimer = setInterval(check, 1000);
      // Tether was updated or reloaded under this tab (see sync-core's
      // orphaned): stop watching the page and take everything down.
      window.TetherSync.on('gone', () => {
        gone = true;
        observer.disconnect();
        clearInterval(checkTimer);
        root.remove();
      });

      // catch the case where a video is already present on script injection
      current = findVideo();
      if (current) window.TetherSync.setVideo(current);
    },
  };
})();
