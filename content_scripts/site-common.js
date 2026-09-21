// ---------------------------------------------------------------------------
// Shared by every site adapter (netflix.js, hulu.js, disneyplus.js). Each of
// these streaming sites is a single-page app that swaps a single <video>
// element in and out as you browse and watch, so the "find the video, watch
// for it changing, show a status badge" logic is identical across all of
// them. A site adapter only needs to say how to find its video element.
// ---------------------------------------------------------------------------

(function () {
  let statusBadge = null;

  function showStatus(status) {
    if (!statusBadge) {
      statusBadge = document.createElement('div');
      statusBadge.style.cssText = `
        position: fixed; bottom: 24px; right: 24px; z-index: 2147483647;
        font: 590 12.5px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
        padding: 8px 14px 8px 10px; border-radius: 999px; color: #fff;
        display: flex; align-items: center; gap: 7px; pointer-events: none;
        background: rgba(28,28,30,0.82); backdrop-filter: blur(14px) saturate(1.6);
        -webkit-backdrop-filter: blur(14px) saturate(1.6);
        box-shadow: 0 4px 20px rgba(0,0,0,0.35), 0 0 0 0.5px rgba(255,255,255,0.08) inset;
        transition: opacity 0.35s ease, transform 0.35s ease; opacity: 0; transform: translateY(6px);
      `;
      const dot = document.createElement('span');
      dot.style.cssText = 'width:7px;height:7px;border-radius:50%;flex-shrink:0;transition:background 0.25s;';
      statusBadge.appendChild(dot);
      const label = document.createElement('span');
      statusBadge.appendChild(label);
      document.documentElement.appendChild(statusBadge);
      statusBadge._dot = dot;
      statusBadge._label = label;
    }
    const labels = {
      connected: ['In sync', '#34c759'],
      disconnected: ['Reconnecting...', '#ff9f0a'],
      'no-room': ['Open Tether to join a room', '#8e8e93'],
    };
    const [text, color] = labels[status] || ['', '#8e8e93'];
    statusBadge._label.textContent = text;
    statusBadge._dot.style.background = color;
    statusBadge.style.opacity = '1';
    statusBadge.style.transform = 'translateY(0)';
    clearTimeout(showStatus._t);
    // Every other state is a passing ping ("yep, synced") that's fine to fade
    // after a few seconds. 'no-room' means nothing is set up at all, still
    // true indefinitely until someone joins a room, so it stays on screen
    // instead of quietly vanishing after 3.5s and leaving no indication
    // anything needs doing.
    if (status !== 'no-room') {
      showStatus._t = setTimeout(() => {
        statusBadge.style.opacity = '0';
        statusBadge.style.transform = 'translateY(6px)';
      }, 3500);
    }
  }

  // ---------------------------------------------------------------------
  // Reactions: a floating emoji burst either of you can send, seen on both
  // tabs. Deliberately on the page itself, not tucked in the popup, since
  // Teleparty's own reactions work the same way, an overlay on the video
  // you're both actually looking at, not somewhere you'd have to look away
  // from it to reach.
  // ---------------------------------------------------------------------
  const REACTIONS = [
    { emoji: '❤️', label: 'Love' },
    { emoji: '😂', label: 'Laughing' },
    { emoji: '😮', label: 'Surprised' },
    { emoji: '👏', label: 'Applause' },
    { emoji: '😢', label: 'Sad' },
  ];
  let reactionStyleInjected = false;

  function injectReactionStyle() {
    if (reactionStyleInjected) return;
    reactionStyleInjected = true;
    const style = document.createElement('style');
    style.textContent = `
      @keyframes tether-float-up {
        0% { transform: translateY(0) scale(0.6); opacity: 0; }
        15% { transform: translateY(-10px) scale(1); opacity: 1; }
        100% { transform: translateY(-160px) scale(1.15); opacity: 0; }
      }
    `;
    document.documentElement.appendChild(style);
  }

  // Shows the floating burst. Called both for a reaction that arrived from
  // the other person, and immediately, locally, the instant you send one
  // yourself, rather than waiting on a network round trip to see your own.
  function showReaction(emoji) {
    injectReactionStyle();
    const el = document.createElement('div');
    const jitter = (Math.random() - 0.5) * 40; // slight horizontal spread so simultaneous reactions don't perfectly overlap
    el.textContent = emoji;
    el.style.cssText = `
      position: fixed; bottom: 106px; right: ${40 - jitter}px; z-index: 2147483647;
      font-size: 34px; pointer-events: none;
      animation: tether-float-up 1.8s ease-out forwards;
    `;
    document.documentElement.appendChild(el);
    setTimeout(() => el.remove(), 1800);
  }

  let pickerOpen = false;
  function buildReactionTrigger() {
    const wrap = document.createElement('div');
    // Stacked directly above the status badge, same right edge, rather than
    // beside it: that badge's width varies with its text ("In sync" vs.
    // "Reconnecting..."), so a fixed horizontal offset would overlap it for
    // some states and leave an odd gap for others.
    wrap.style.cssText = `
      position: fixed; bottom: 68px; right: 24px; z-index: 2147483646;
      display: flex; align-items: center; gap: 6px;
    `;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; gap:4px; opacity:0; transform:translateX(6px); pointer-events:none; transition:opacity 0.2s, transform 0.2s;';
    REACTIONS.forEach(({ emoji, label }) => {
      const btn = document.createElement('button');
      btn.textContent = emoji;
      btn.setAttribute('aria-label', label);
      btn.title = label;
      btn.style.cssText = `
        width: 32px; height: 32px; border-radius: 50%; border: none; cursor: pointer;
        background: rgba(28,28,30,0.82); backdrop-filter: blur(14px) saturate(1.6);
        -webkit-backdrop-filter: blur(14px) saturate(1.6); font-size: 15px;
        box-shadow: 0 4px 14px rgba(0,0,0,0.3); display:flex; align-items:center; justify-content:center;
      `;
      btn.addEventListener('click', () => {
        showReaction(emoji);
        window.TetherSync.sendReaction(emoji);
        setPickerOpen(false);
      });
      row.appendChild(btn);
    });

    const toggle = document.createElement('button');
    toggle.textContent = '🙂';
    toggle.title = 'Send a reaction';
    toggle.style.cssText = `
      width: 32px; height: 32px; border-radius: 50%; border: none; cursor: pointer; flex-shrink: 0;
      background: rgba(28,28,30,0.82); backdrop-filter: blur(14px) saturate(1.6);
      -webkit-backdrop-filter: blur(14px) saturate(1.6); font-size: 15px;
      box-shadow: 0 4px 14px rgba(0,0,0,0.3); display:flex; align-items:center; justify-content:center;
    `;

    function setPickerOpen(open) {
      pickerOpen = open;
      row.style.opacity = open ? '1' : '0';
      row.style.transform = open ? 'translateX(0)' : 'translateX(6px)';
      row.style.pointerEvents = open ? 'auto' : 'none';
    }
    toggle.addEventListener('click', () => setPickerOpen(!pickerOpen));

    wrap.appendChild(row);
    wrap.appendChild(toggle);
    document.documentElement.appendChild(wrap);
  }

  window.TetherSite = {
    /** Call once per site adapter with a function that returns the current
     *  <video> element (or null). Handles watching for it being swapped out
     *  and wiring up the on-page status badge and reaction picker. */
    start(findVideo) {
      window.TetherSync.init(showStatus, showReaction);
      buildReactionTrigger();

      let current = null;
      const observer = new MutationObserver(() => {
        const v = findVideo();
        if (v !== current) {
          current = v;
          window.TetherSync.setVideo(v);
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });

      // catch the case where a video is already present on script injection
      current = findVideo();
      if (current) window.TetherSync.setVideo(current);
    },
  };
})();
