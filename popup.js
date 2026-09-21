// Talks to Firebase Realtime Database over plain REST.
// See content_scripts/sync-core.js for why there's no Firebase SDK involved.

// A shared database baked into the extension itself, so installing it is
// the whole setup: no Firebase account, no URL to find or paste in. Anyone
// who wants their own private backend instead can still switch it under
// "Use a different database (advanced)".
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
let chatPoll = null;
let presenceHeartbeat = null;
let presencePoll = null;
const PRESENCE_HEARTBEAT_MS = 5000;
const PRESENCE_STALE_MS = 12000; // a couple missed heartbeats before we call someone gone, not just between beats

function resolveClientId(cb) {
  chrome.storage.local.get(['clientId'], (stored) => {
    if (stored.clientId) { myClientId = stored.clientId; cb(); return; }
    myClientId = 'u_' + Math.random().toString(36).slice(2, 10);
    chrome.storage.local.set({ clientId: myClientId }, cb);
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
  statusText.textContent = state === 'connected' ? 'Connected' : state === 'disconnected' ? 'Offline' : 'Not set up';
}

// ---------------------------------------------------------------------
// tabs
// ---------------------------------------------------------------------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
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
    dbUrlStatus.textContent = "Couldn't reach that database. Check the URL and that it's a Realtime Database (not Firestore).";
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
  dbUrl = url;
  const ok = await testConnection();
  if (ok) {
    chrome.storage.sync.set({ dbUrl });
    loadNotes();
    loadChat();
  }
});

// ---------------------------------------------------------------------
// room
// ---------------------------------------------------------------------
function enterRoom(newRoomId) {
  roomId = newRoomId;
  roomCodeEl.textContent = roomId;
  chrome.storage.sync.set({ roomId });
  loadNotes();
  loadChat();
  clearInterval(chatPoll);
  chatPoll = setInterval(loadChat, 4000);

  clearInterval(presenceHeartbeat);
  writePresence();
  presenceHeartbeat = setInterval(writePresence, PRESENCE_HEARTBEAT_MS);
  clearInterval(presencePoll);
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
  fetch(roomUrl('presence/' + myClientId), {
    method: 'PUT',
    body: JSON.stringify({ ts: Date.now(), name: nickname || null }),
  }).catch(() => {});
}

function pollPresence() {
  if (!dbUrl || !roomId) return;
  fetch(roomUrl('presence')).then((r) => r.json()).then((data) => {
    const now = Date.now();
    const peer = Object.entries(data || {}).find(
      ([clientId, entry]) => clientId !== myClientId && entry && now - entry.ts < PRESENCE_STALE_MS
    );
    peerDot.className = 'dot' + (peer ? ' connected' : '');
    const peerName = peer && peer[1].name;
    peerText.textContent = peer
      ? (peerName ? `${peerName} is in this room` : 'Someone else is in this room')
      : "Waiting for the other person...";
  }).catch(() => {});
}

// See content_scripts/join.js for what actually happens when this link is
// opened: it sets the room code and redirects straight to whatever the host
// is currently watching, once they've pressed play.
const JOIN_URL_BASE = 'https://tamkin-anwar.github.io/tether/join.html';

copyLinkBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(`${JOIN_URL_BASE}?code=${roomId || ''}`);
  copyLinkBtn.textContent = 'Copied ✓';
  setTimeout(() => { copyLinkBtn.textContent = 'Copy invite link'; }, 1200);
});

copyCodeLink.addEventListener('click', () => {
  navigator.clipboard.writeText(roomId || '');
  copyCodeLink.textContent = 'Copied ✓';
  setTimeout(() => { copyCodeLink.textContent = 'Copy code only'; }, 1200);
});

joinRoomBtn.addEventListener('click', () => {
  const code = joinCodeInput.value.trim().toUpperCase();
  if (!code) return;
  joinCodeInput.value = '';
  enterRoom(code);
});

// The room code persists on purpose (see enterRoom/boot), so you and whoever
// you're watching with don't have to re-share a code every session. This is
// the escape hatch: only your own side leaves, the other person's room is
// untouched until they also leave or join elsewhere.
leaveRoomLink.addEventListener('click', () => {
  if (!confirm("Leave this room and start a new one? Whoever you're watching with will need your new code.")) return;
  enterRoom(randomRoomCode());
});

// ---------------------------------------------------------------------
// notes
// ---------------------------------------------------------------------
function loadNotes() {
  if (!dbUrl || !roomId) return;
  fetch(roomUrl('notes')).then((r) => r.json()).then((data) => {
    if (document.activeElement === notesArea) return; // don't clobber what they're mid-typing
    // A fresh room with no notes yet is a real, distinct state from "still
    // showing the previous room's text" - without the explicit else branch
    // here, leaving a room with notes and starting a new one left the old
    // text sitting in the box, looking exactly like it had carried over.
    notesArea.value = (data && typeof data.text === 'string') ? data.text : '';
  }).catch(() => {});
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
// chat
// ---------------------------------------------------------------------
function renderChat(messages) {
  const items = Object.values(messages || {}).sort((a, b) => a.ts - b.ts).slice(-30);
  if (!items.length) {
    chatLog.innerHTML = '<div class="empty-state">No messages yet</div>';
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
  chatLog.scrollTop = chatLog.scrollHeight;
}

function loadChat() {
  if (!dbUrl || !roomId) return;
  fetch(roomUrl('chat')).then((r) => r.json()).then(renderChat).catch(() => {});
}

function sendChat() {
  const text = chatInput.value.trim();
  if (!text || !dbUrl || !roomId) return;
  chatInput.value = '';
  fetch(roomUrl('chat'), {
    method: 'POST',
    body: JSON.stringify({ text, from: myClientId, name: nickname || null, ts: Date.now() }),
  }).then(loadChat).catch(() => {});
}
sendChatBtn.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

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
