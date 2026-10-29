// Talks to Firebase Realtime Database over plain REST.
// See content_scripts/sync-core.js for why there's no Firebase SDK involved.

// A shared database baked into the extension itself, so installing it is
// the whole setup: no Firebase account, no URL to find or paste in. Anyone
// who wants their own private backend instead can still switch it under
// "Use a different database (advanced)".
// Every string the person sees comes from _locales/<their Chrome language>,
// with English as the fallback (see tools/build_locales.py). The static
// markup is filled in from its data-i18n attributes here, before anything
// else renders.
const t = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String)) || key;
document.documentElement.lang = chrome.i18n.getUILanguage();
document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
document.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
document.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });

const DEFAULT_DB_URL = 'https://tether-643cf-default-rtdb.asia-southeast1.firebasedatabase.app';

const dbUrlInput = document.getElementById('dbUrlInput');
const saveDbUrlBtn = document.getElementById('saveDbUrl');
const dbUrlStatus = document.getElementById('dbUrlStatus');
const setupCard = document.getElementById('setupCard');
const roomCodeEl = document.getElementById('roomCode');
const copyLinkBtn = document.getElementById('copyLink');
const copyCodeLink = document.getElementById('copyCodeLink');
const joinCodeInput = document.getElementById('joinCodeInput');
const joinRoomBtn = document.getElementById('joinRoom');
const notesArea = document.getElementById('notesArea');
const notesStatus = document.getElementById('notesStatus');
const chatLog = document.getElementById('chatLog');
const chatInput = document.getElementById('chatInput');
const sendChatBtn = document.getElementById('sendChat');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const changeDbLink = document.getElementById('changeDbLink');
const peerDot = document.getElementById('peerDot');
const peerText = document.getElementById('peerText');
const leaveRoomLink = document.getElementById('leaveRoomLink');
const nicknameInput = document.getElementById('nicknameInput');
const sessionDot = document.getElementById('sessionDot');
const sessionText = document.getElementById('sessionText');
const sessionBtn = document.getElementById('sessionBtn');
const sessionHint = document.getElementById('sessionHint');

let dbUrl = null;
let roomId = null;
// A locally-remembered display name, not an account: no sign-up, nothing
// server-side tied to it, just chrome.storage the same as the room code.
// Entirely optional, everything falls back to today's generic wording if
// it's never set.
let nickname = '';
// Persisted (see resolveClientId), not regenerated per popup-open: it has to
// stay stable both so old chat bubbles don't flip from "me" to "them" the
// next time the popup is opened, and so presence can tell "my other tab"
// apart from an actual second person in the room.
let myClientId = null;
// Unlike clientId (chrome.storage.local, one per install), this lives in
// chrome.storage.sync, so it follows you to every browser Chrome signs into
// the same account, on purpose, the room code itself is stored there too so
// you can keep watching from a different device without retyping it. The
// side effect: your own laptop and desktop, both open at once, silently
// join the exact same room and each heartbeat under a different clientId,
// so without something that says "these both belong to the same person,"
// the presence check has no way to tell your other device apart from an
// actual second person, and permanently reports one to yourself.
let myOwnerId = null;
let chatEs = null;
let chatData = {};
let notesEs = null;
let presenceHeartbeat = null;
let presencePoll = null;
let clockTimer = null;
const PRESENCE_HEARTBEAT_MS = 5000;
const PRESENCE_STALE_MS = 12000; // a couple missed heartbeats before we call someone gone, not just between beats
const CLOCK_RECALIBRATE_MS = 60000;
let serverOffsetMs = 0; // add to Date.now() to estimate the Firebase server's clock

// Same trick sync-core.js uses for playback, needed here for the same
// reason: presence writes a server timestamp (see writePresence), and
// comparing that against this device's own raw Date.now() would make
// presence only as reliable as the two devices' clocks agree, exactly the
// two devices this app assumes are in different countries.
async function calibrateClock() {
  try {
    const t0 = Date.now();
    const res = await fetch(roomUrl('_clock'), { method: 'PUT', body: JSON.stringify({ '.sv': 'timestamp' }) });
    const t1 = Date.now();
    const serverTime = await res.json();
    if (typeof serverTime !== 'number') return;
    const rtt = t1 - t0;
    serverOffsetMs = (serverTime + rtt / 2) - t1;
  } catch (e) { /* keep the previous offset if this attempt fails */ }
}
function serverNow() { return Date.now() + serverOffsetMs; }

function resolveClientId(cb) {
  chrome.storage.local.get(['clientId'], (stored) => {
    if (stored.clientId) { myClientId = stored.clientId; cb(); return; }
    myClientId = 'u_' + Math.random().toString(36).slice(2, 10);
    chrome.storage.local.set({ clientId: myClientId }, cb);
  });
}

function resolveOwnerId(cb) {
  chrome.storage.sync.get(['ownerId'], (stored) => {
    if (stored.ownerId) { myOwnerId = stored.ownerId; cb(); return; }
    myOwnerId = 'o_' + Math.random().toString(36).slice(2, 10);
    chrome.storage.sync.set({ ownerId: myOwnerId }, cb);
  });
}

function randomRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  // 8, not 6: with a real invite link doing the sharing now (see
  // JOIN_URL_BASE below), almost nobody types this by hand anymore, so the
  // usual tradeoff against a longer code barely applies. What's actually
  // changed is the audience: at "anyone in the world" scale rather than just
  // two people, a code is worth being meaningfully harder to guess or scan
  // for. 32^8 (~1.1 trillion) versus 32^6 (~1.07 billion) is a real jump for
  // a cost that's now mostly just a couple more characters in a URL.
  let code = '';
  for (let i = 0; i < 8; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

function roomUrl(path) {
  return `${dbUrl.replace(/\/$/, '')}/rooms/${encodeURIComponent(roomId)}/${path}.json`;
}

function setConnectionStatus(state) {
  // state: 'connected' | 'disconnected' | 'unknown'
  statusDot.className = 'dot' + (state === 'connected' ? ' connected' : state === 'disconnected' ? ' disconnected' : '');
  statusText.textContent = t(state === 'connected' ? 'statusConnected' : state === 'disconnected' ? 'statusOffline' : 'statusNotSetUp');
}

// ---------------------------------------------------------------------
// tabs
// ---------------------------------------------------------------------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    document.getElementById('panel-' + btn.dataset.tab).classList.add('active');
  });
});

// ---------------------------------------------------------------------
// database connection
// ---------------------------------------------------------------------
async function testConnection() {
  try {
    // Check a path actually covered by the security rules (rooms/$roomId),
    // not the database root: our rules intentionally only grant access
    // under /rooms/<roomId>, so a root-level check would always come back
    // "permission denied" even on a perfectly working database.
    const checkRoomId = roomId || 'connection-check';
    const res = await fetch(`${dbUrl.replace(/\/$/, '')}/rooms/${encodeURIComponent(checkRoomId)}/.json?shallow=true`);
    if (!res.ok) throw new Error(res.status);
    dbUrlStatus.textContent = '';
    setupCard.style.display = 'none';
    setConnectionStatus('connected');
    return true;
  } catch (e) {
    dbUrlStatus.textContent = t('dbError');
    setConnectionStatus('disconnected');
    return false;
  }
}

changeDbLink.addEventListener('click', () => {
  setupCard.style.display = 'block';
  dbUrlInput.focus();
});

saveDbUrlBtn.addEventListener('click', async () => {
  const url = dbUrlInput.value.trim();
  if (!url) return;
  const previousDbUrl = dbUrl;
  dbUrl = url;
  const ok = await testConnection();
  if (ok) {
    chrome.storage.sync.set({ dbUrl });
    startNotesStream();
    startChatStream();
  } else {
    // Without this, a failed attempt left dbUrl pointed at the broken URL
    // for the rest of the popup session, even though nothing bad was ever
    // saved to storage: the error shows correctly, but every notes/chat/
    // presence call afterward would silently fail against that dead URL
    // until the popup was closed and reopened.
    dbUrl = previousDbUrl;
  }
});

// ---------------------------------------------------------------------
// room
// ---------------------------------------------------------------------
function enterRoom(newRoomId) {
  if (roomId && roomId !== newRoomId && myClientId && dbUrl) {
    // No longer here: say so in the old room right away, instead of
    // leaving an invite to a session there until it goes stale.
    fetch(roomUrl('presence/' + myClientId), { method: 'DELETE' }).catch(() => {});
    clearNowWatching(roomId);
  }
  roomId = newRoomId;
  roomCodeEl.textContent = roomId;
  chrome.storage.sync.set({ roomId });
  startNotesStream();
  startChatStream();

  clearInterval(clockTimer);
  calibrateClock();
  clockTimer = setInterval(calibrateClock, CLOCK_RECALIBRATE_MS);
  clearInterval(presenceHeartbeat);
  writePresence();
  presenceHeartbeat = setInterval(writePresence, PRESENCE_HEARTBEAT_MS);
  clearInterval(presencePoll);
  renderSession(); // a session belongs to one room; switching rooms ends it here
  pollPresence();
  presencePoll = setInterval(pollPresence, PRESENCE_HEARTBEAT_MS);
}

// ---------------------------------------------------------------------
// presence: is the other person's Tether actually active right now, in
// this same room, not just "did we both once type in a matching code".
// There's no true onDisconnect over plain REST (see sync-core.js for why
// this extension avoids the Firebase SDK), so this is a heartbeat: each
// side writes its own timestamp regularly, and anyone else's timestamp
// still being fresh is read as "they're here". The content script on an
// actual streaming tab writes the same heartbeat, so this also reflects
// someone who's watching right now even if their popup isn't open.
function writePresence() {
  if (!dbUrl || !roomId || !myClientId) return;
  // A server timestamp, not this device's own clock, same reasoning as
  // sync-core.js's copy of this: comparing two devices' own clocks against
  // each other is exactly how presence gets it backwards for a long-
  // distance pair, this app's entire premise.
  fetch(roomUrl('presence/' + myClientId), {
    method: 'PUT',
    // since: when this session began, on the server's clock. Same as
    // sync-core.js writes for this same entry; leaving it out here would
    // erase it every few seconds while the popup is open.
    body: JSON.stringify({ ts: { '.sv': 'timestamp' }, name: nickname || null, owner: myOwnerId || null, watching: sessionActive(),
      since: sessionActive() ? Math.round(session.startedAt + serverOffsetMs) : null }),
  }).catch(() => {});
}

function pollPresence() {
  if (!dbUrl || !roomId) return;
  fetch(roomUrl('presence')).then((r) => r.json()).then((data) => {
    const now = serverNow(); // not Date.now(): entry.ts is a server timestamp, compare it against the same clock
    const others = Object.entries(data || {}).filter(
      ([clientId, entry]) => clientId !== myClientId && entry && now - entry.ts < PRESENCE_STALE_MS
    );
    // Same owner, different clientId: your other device, not the person
    // you're actually watching with (see myOwnerId above). Only missing or
    // mismatched owner counts as a real peer, missing covers an older
    // version's presence entry that predates this field.
    const peer = others.find(([, entry]) => !entry.owner || entry.owner !== myOwnerId);
    partnerWatching = peer && peer[1].watching === true ? { name: peer[1].name || null } : null;
    renderSession();
    checkTheirShow();
    const myOtherDevice = !peer && others.find(([, entry]) => entry.owner === myOwnerId);
    peerDot.className = 'dot' + (peer ? ' connected' : '');
    if (peer) {
      const peerName = peer[1].name;
      peerText.textContent = peerName ? t('peerHere', peerName) : t('peerSomeone');
    } else if (myOtherDevice) {
      peerText.textContent = t('peerOtherDevice');
    } else {
      peerText.textContent = t('peerWaiting');
    }
  }).catch(() => {});
}

// See content_scripts/join.js for what actually happens when this link is
// opened: it sets the room code and redirects straight to whatever the host
// is currently watching, once they've pressed play.
const JOIN_URL_BASE = 'https://tamkin-anwar.github.io/tether/join.html';

copyLinkBtn.addEventListener('click', () => {
  if (!roomId) return; // still connecting; a link without a code leads nowhere
  navigator.clipboard.writeText(`${JOIN_URL_BASE}?code=${roomId}`);
  // Sending the link is starting to watch together: the link only takes
  // them to the show once this side is in a session (see join.js).
  if (!sessionActive()) startSession();
  copyLinkBtn.textContent = t('copied');
  setTimeout(() => { copyLinkBtn.textContent = t('copyInvite'); }, 1200);
});

copyCodeLink.addEventListener('click', () => {
  navigator.clipboard.writeText(roomId || '');
  copyCodeLink.textContent = t('copied');
  setTimeout(() => { copyCodeLink.textContent = t('copyCode'); }, 1200);
});

// Accepts the whole invite link too, not just a bare code: pasting the link
// someone sent you into this box is an easy, natural mistake, and before
// this it became the "room code" itself, joining an empty room with no
// sign anything was wrong. Anything that isn't part of a code (spaces,
// dashes, a "Code:" prefix) is dropped for the same reason.
function normalizeCode(input) {
  const s = (input || '').trim();
  const fromLink = s.match(/[?&]code=([A-Za-z0-9]+)/);
  // Safe to strip: generated codes never contain an O (see randomRoomCode),
  // so no real code can begin with "CODE" or "ROOM".
  const raw = fromLink ? fromLink[1] : s.replace(/^(room\s*)?code\s*[:#-]?\s*/i, '');
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Codes are 8 characters (6 for rooms made by older versions). Anything
// else is a typo, and would quietly open an empty room of its own.
const joinError = document.getElementById('joinError');
function joinRoom() {
  const code = normalizeCode(joinCodeInput.value);
  if (!code) return;
  const ok = code.length >= 6 && code.length <= 8;
  joinError.style.display = ok ? 'none' : 'block';
  if (!ok) return;
  joinCodeInput.value = '';
  enterRoom(code);
}
joinRoomBtn.addEventListener('click', joinRoom);
joinCodeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) joinRoom(); });
joinCodeInput.addEventListener('input', () => { joinError.style.display = 'none'; });

// The room code persists on purpose (see enterRoom/boot), so you and whoever
// you're watching with don't have to re-share a code every session. This is
// the escape hatch: only your own side leaves, the other person's room is
// untouched until they also leave or join elsewhere.
leaveRoomLink.addEventListener('click', () => {
  if (!confirm(t('leaveConfirm'))) return;
  enterRoom(randomRoomCode());
});

// ---------------------------------------------------------------------
// notes
// ---------------------------------------------------------------------
// A live stream, not a one-off fetch: notes are meant to be shared in real
// time, and a plain fetch only ever shows what was true the moment the
// popup happened to open. Without this, the other person editing the note
// while your popup is already open would never appear until you closed and
// reopened it, silent data loss disguised as "already up to date."
function startNotesStream() {
  if (notesEs) notesEs.close();
  if (!dbUrl || !roomId) return;
  const applyNotes = (data) => {
    if (document.activeElement === notesArea) return; // don't clobber what they're mid-typing
    // A fresh room with no notes yet is a real, distinct state from "still
    // showing the previous room's text" - without the explicit else branch
    // here, leaving a room with notes and starting a new one left the old
    // text sitting in the box, looking exactly like it had carried over.
    notesArea.value = (data && typeof data.text === 'string') ? data.text : '';
  };
  notesEs = new EventSource(roomUrl('notes'));
  const handle = (e) => {
    try { applyNotes(JSON.parse(e.data).data); } catch (err) { /* ignore malformed frames */ }
  };
  notesEs.addEventListener('put', handle);
  notesEs.addEventListener('patch', handle);
}

let notesSaveTimer = null;
function saveNotesNow() {
  notesSaveTimer = null;
  // keepalive lets this survive the popup actually closing mid-request: a
  // popup's whole JS context (and any fetch it started) is normally torn
  // down the instant it loses focus, so without this, typing a note and
  // immediately clicking away could silently drop that last edit.
  fetch(roomUrl('notes'), {
    method: 'PUT',
    body: JSON.stringify({ text: notesArea.value, updatedAt: Date.now() }),
    keepalive: true,
  }).then(() => {
    notesStatus.classList.add('show');
    setTimeout(() => notesStatus.classList.remove('show'), 1200);
  }).catch(() => {});
}
function saveNotesDebounced() {
  clearTimeout(notesSaveTimer);
  notesSaveTimer = setTimeout(saveNotesNow, 500);
}
notesArea.addEventListener('input', saveNotesDebounced);
// Flush a pending debounce immediately rather than losing it: 'pagehide'
// (not 'beforeunload', which popups don't reliably fire) covers both the
// popup closing and the user switching to another extension tab/panel.
window.addEventListener('pagehide', () => {
  if (notesSaveTimer) { clearTimeout(notesSaveTimer); saveNotesNow(); }
});

// ---------------------------------------------------------------------
// watching together: a session you start, not always on (see sync-core.js
// for the full picture). Kept in storage.local, which every streaming tab
// in this browser listens to, so starting or ending it here takes effect
// in all of them at once.
// ---------------------------------------------------------------------
const SESSION_KEY = 'tetherSession';
const SESSION_IDLE_MS = 30 * 60e3;
let session = null;
let partnerWatching = null;
function sessionActive() {
  return !!(session && roomId && session.roomId === roomId &&
    Date.now() - (session.lastVideoAt || session.startedAt) < SESSION_IDLE_MS);
}
function startSession() {
  if (!roomId) return;
  const now = Date.now();
  session = { roomId, startedAt: now, lastVideoAt: now };
  chrome.storage.local.set({ [SESSION_KEY]: session });
  writePresence();
  renderSession();
}
function endSession() {
  session = null;
  chrome.storage.local.remove(SESSION_KEY);
  writePresence();
  clearNowWatching(roomId);
  renderSession();
}
// What you were watching doesn't stay in the room once you end (see
// sync-core.js): removed if this browser is the one that wrote it.
function clearNowWatching(room) {
  if (!dbUrl || !room) return;
  const url = `${dbUrl.replace(/\/$/, '')}/rooms/${room}/nowWatching.json`;
  fetch(url).then((r) => r.json()).then((data) => {
    if (data && data.from === myClientId) return fetch(url, { method: 'DELETE' });
  }).catch(() => {});
}
function renderSession() {
  const on = sessionActive();
  sessionDot.className = 'dot' + (on ? ' connected' : '');
  sessionBtn.classList.toggle('secondary', on);
  if (on) {
    sessionText.textContent = t('sessionOn');
    sessionBtn.textContent = t('sessionEnd');
    sessionHint.textContent = t('sessionHintOn');
  } else if (partnerWatching) {
    sessionText.textContent = t('sessionPartner', partnerWatching.name || t('partnerFallback'));
    sessionBtn.textContent = t('join');
    sessionHint.textContent = t('sessionHintJoin');
  } else {
    sessionText.textContent = t('sessionOff');
    sessionBtn.textContent = t('sessionStart');
    sessionHint.textContent = t('sessionHintOff');
  }
}
sessionBtn.addEventListener('click', () => {
  if (sessionActive()) { endSession(); return; }
  markWelcomed();
  startSession();
});

// Joined from here, with nothing open yet: a way to get to their show.
const openTheirs = document.getElementById('openTheirs');
let theirUrl = null;
openTheirs.addEventListener('click', () => { if (theirUrl) chrome.tabs.create({ url: theirUrl }); });
function checkTheirShow() {
  if (!sessionActive() || !roomId) { theirUrl = null; openTheirs.style.display = 'none'; return; }
  fetch(roomUrl('nowWatching')).then((r) => r.json()).then((data) => {
    const url = data && data.from !== myClientId && safeUrl(data.url);
    theirUrl = url || null;
    openTheirs.style.display = theirUrl ? 'block' : 'none';
  }).catch(() => {});
}
// Only ever one of the streaming sites Tether works on (the same check as
// sync-core.js): the room can be written by anyone with its code.
function safeUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    if (/(^|\.)(netflix\.com|hulu\.com|disneyplus\.com|crunchyroll\.com|max\.com|hbomax\.com|youtube\.com|primevideo\.com)$/.test(u.hostname)) return u.href;
    if (/^www\.amazon\.(com|co\.uk|de|ca|co\.jp|in|com\.au|fr|it|es)$/.test(u.hostname) && /\/(gp\/video|dp)\//.test(u.pathname)) return u.href;
  } catch (e) { /* not a URL */ }
  return null;
}

// ---------------------------------------------------------------------
// first run: a short how-it-works at the top until it's dismissed, or the
// first time a session starts (by then they've figured it out). This page
// is also what opens in a tab right after installing (see background.js).
// ---------------------------------------------------------------------
const welcomeCard = document.getElementById('welcomeCard');
const roomHint = document.getElementById('roomHint'); // says the same thing in brief; one at a time
function markWelcomed() {
  welcomeCard.style.display = 'none';
  roomHint.style.display = '';
  chrome.storage.local.set({ tetherWelcomed: true });
}
document.getElementById('welcomeDone').addEventListener('click', markWelcomed);
chrome.storage.local.get(['tetherWelcomed'], (local) => {
  if (!local.tetherWelcomed) { welcomeCard.style.display = 'block'; roomHint.style.display = 'none'; }
});
chrome.storage.local.get([SESSION_KEY], (local) => { session = local[SESSION_KEY] || null; renderSession(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SESSION_KEY]) { session = changes[SESSION_KEY].newValue || null; renderSession(); }
});

// ---------------------------------------------------------------------
// chat
// ---------------------------------------------------------------------
function renderChat(messages) {
  const items = Object.values(messages || {}).sort((a, b) => a.ts - b.ts).slice(-30);
  // Only snap to the newest message if that's roughly where they already
  // were. A live stream can redraw at any moment, mid-conversation; without
  // this, scrolling up to reread something got yanked back to the bottom
  // the instant either side sent another message.
  const nearBottom = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 40;
  if (!items.length) {
    chatLog.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = t('noMessages');
    chatLog.appendChild(empty);
    return;
  }
  chatLog.innerHTML = '';
  let lastSender = null;
  for (const m of items) {
    const mine = m.from === myClientId;
    // Only label a message when the sender changes, same convention as most
    // chat apps: a name on every single bubble in a back-and-forth gets
    // noisy fast. Never label your own messages, you know who you are.
    if (!mine && m.name && m.from !== lastSender) {
      const label = document.createElement('div');
      label.className = 'bubble-name';
      label.textContent = m.name;
      chatLog.appendChild(label);
    }
    lastSender = m.from;
    const div = document.createElement('div');
    div.className = 'bubble ' + (mine ? 'me' : 'them');
    div.textContent = m.text;
    chatLog.appendChild(div);
  }
  if (nearBottom) chatLog.scrollTop = chatLog.scrollHeight;
}

// A live stream instead of polling every few seconds: messages should show
// up the instant they're sent, not on the next poll tick. Firebase's
// streaming API sends the whole collection once on connect, then just the
// added/changed child after that (a push() writes one new key, not the
// whole list), so this keeps its own running copy and patches it in place
// rather than re-fetching the entire chat log on every message.
function startChatStream() {
  if (chatEs) chatEs.close();
  chatData = {};
  if (!dbUrl || !roomId) return;
  // Only the newest 50, not the whole history: chat grows forever, and the
  // stream re-sent every message ever sent in the room each time the popup
  // opened, though only the last 30 are shown, steadily slower for a
  // couple who use it nightly. Push keys sort chronologically, so ordering
  // by key is ordering by time. Verified against the live database: the
  // initial event carries exactly the newest 50 in the same path "/" shape
  // handled below, and a new message still arrives as one added child.
  chatEs = new EventSource(roomUrl('chat') + '?orderBy=%22%24key%22&limitToLast=50');
  const handle = (e) => {
    try {
      const { path, data } = JSON.parse(e.data);
      if (path === '/') {
        chatData = data || {};
      } else {
        const key = path.slice(1);
        if (data === null) delete chatData[key];
        else chatData[key] = data;
      }
      renderChat(chatData);
    } catch (err) { /* ignore malformed frames */ }
  };
  chatEs.addEventListener('put', handle);
  chatEs.addEventListener('patch', handle);
}

function sendChat() {
  const text = chatInput.value.trim();
  if (!text || !dbUrl || !roomId) return;
  chatInput.value = '';
  // No need to re-fetch or optimistically render afterward: the stream
  // above is already listening to this same path and will reflect this
  // write, from this tab or the other side, the moment Firebase applies it.
  fetch(roomUrl('chat'), {
    method: 'POST',
    // A server timestamp, not this device's own clock: renderChat sorts
    // strictly by ts, and this app's whole premise is two people on
    // opposite sides of the world, exactly the situation where their
    // devices' clocks can genuinely disagree by seconds. A local Date.now()
    // here could show a reply rendered before the message it was replying
    // to, purely because one device's clock ran a little ahead.
    body: JSON.stringify({ text, from: myClientId, name: nickname || null, ts: { '.sv': 'timestamp' } }),
  }).catch(() => {});
}
// Real, self-serve deletion: chat and notes otherwise persist for as long
// as the room exists (see PRIVACY.md). Shared data, so it's gone for both
// people, and the confirmation says so. Both live streams above pick up
// the deletion, so the other person's open popup clears too.
const clearHistoryLink = document.getElementById('clearHistoryLink');
clearHistoryLink.addEventListener('click', () => {
  if (!dbUrl || !roomId) return;
  if (!confirm(t('clearConfirm'))) return;
  // A pending notes save would otherwise land right after the delete and
  // quietly bring the old text back.
  clearTimeout(notesSaveTimer);
  notesSaveTimer = null;
  notesArea.value = '';
  fetch(roomUrl('chat'), { method: 'DELETE' }).catch(() => {});
  fetch(roomUrl('notes'), { method: 'DELETE' }).catch(() => {});
});

sendChatBtn.addEventListener('click', sendChat);
// isComposing: typing through an input method (Bengali via Avro, Japanese,
// Chinese, and so on) uses Enter to confirm the word being composed, not to
// send; without this check, messages went out half-typed.
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) sendChat(); });

// ---------------------------------------------------------------------
// nickname
// ---------------------------------------------------------------------
let nicknameSaveTimer = null;
function saveNicknameNow() {
  nicknameSaveTimer = null;
  chrome.storage.sync.set({ nickname });
}
nicknameInput.addEventListener('input', () => {
  nickname = nicknameInput.value.trim();
  clearTimeout(nicknameSaveTimer);
  nicknameSaveTimer = setTimeout(saveNicknameNow, 400);
});
// Same fix as the notes debounce below: a pending timeout is destroyed,
// never fires, if the popup closes before it does. Typing a name and
// immediately clicking away would otherwise silently revert to the old one.
window.addEventListener('pagehide', () => {
  if (nicknameSaveTimer) { clearTimeout(nicknameSaveTimer); saveNicknameNow(); }
});

// ---------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------
resolveClientId(() => {
  resolveOwnerId(() => {
    chrome.storage.sync.get(['dbUrl', 'roomId', 'nickname'], async (stored) => {
      dbUrl = stored.dbUrl || DEFAULT_DB_URL;
      dbUrlInput.value = dbUrl;
      nickname = stored.nickname || '';
      nicknameInput.value = nickname;
      const ok = await testConnection();
      if (ok && !stored.dbUrl) chrome.storage.sync.set({ dbUrl }); // remember we're on the default, harmless either way
      enterRoom(stored.roomId || randomRoomCode());
    });
  });
});

// Mirrors the same listener sync-core.js already has, for the same reason:
// this popup and a content script tab aren't the only two places these
// values can change from, another of your own devices can leave the room,
// switch database, or rename itself at any moment. Without this, a popup
// left open during exactly that moment kept working off of, and writing
// back to, whatever was true when it was opened.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.ownerId) myOwnerId = changes.ownerId.newValue || myOwnerId;
  if (changes.nickname && changes.nickname.newValue !== nickname) {
    nickname = changes.nickname.newValue || '';
    if (document.activeElement !== nicknameInput) nicknameInput.value = nickname; // don't clobber what's mid-typing
  }
  if (changes.roomId && changes.roomId.newValue && changes.roomId.newValue !== roomId) {
    enterRoom(changes.roomId.newValue);
  }
  if (changes.dbUrl && changes.dbUrl.newValue && changes.dbUrl.newValue !== dbUrl) {
    dbUrl = changes.dbUrl.newValue;
    dbUrlInput.value = dbUrl;
    testConnection().then((ok) => { if (ok) { startNotesStream(); startChatStream(); } });
  }
});
