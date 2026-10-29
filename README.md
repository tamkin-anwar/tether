# Tether

Watch Netflix, Prime Video, Hulu, Disney+, Max, Crunchyroll, or YouTube together while you're apart. Playback stays in sync between your two browsers, with chat and reactions right on the video and a shared notes pad in the popup.

[Add to Chrome](https://chromewebstore.google.com/detail/tether-watch-together/hbdlgagknjnijflkgjdelehjibapehpi) · [Website](https://tamkin-anwar.github.io/tether/) · [Privacy](PRIVACY.md)

## How it works

Tether never touches the video stream, which is DRM-protected. Each of you streams from your own account in your own browser tab, and the extension mirrors play, pause, seek and speed between the two tabs through a small shared database. It only uses the player's standard controls.

That also means it only works in a desktop browser. It can't reach the phone or TV apps.

**Accuracy.** Each tab calibrates its clock against the database's clock (best of several round trips), stamps every change with that corrected time, and projects forward by however long the message took to arrive. Small drift is closed with a speed change of a few percent, which you can't hear or see; larger gaps are a seek that aims ahead by the seek time it has measured. In testing across two separate browsers, the two players stay within about a tenth of a second.

**Sessions.** Nothing about what you watch is shared until you start a session (Watch together, on the video or in the popup) or accept the other person's invite. A session ends when you end it, or after 30 minutes without a video.

## Features

- Sync on Netflix, Prime Video, Hulu, Disney+, Max, Crunchyroll, and YouTube, with drift correction and catch-up when one of you joins late
- Ad breaks handled: an ad's position is never shared, and whoever's ad ends catches back up. On Prime Video, positions are exchanged in the episode's own time, so different ads never put you out of step
- Playback speed syncs; live streams sync play and pause only
- An invite link that takes the other person to the same show at the same moment
- Chat and reactions on the video, including in fullscreen, placed halfway down the right edge, clear of every player's own controls
- Notices of what the other person did ("Sam paused"), and "Join them" when they're on a different title
- Shared notes and chat in the popup, nicknames, no accounts
- One tab per browser holds the live connections, so several streaming tabs never stall sync
- Available in English, Spanish, Portuguese, French, German, Hindi, and Japanese

## Installing from source

1. In Chrome, open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.

Tether uses a shared database out of the box, so there's nothing to set up.

## Using your own database (optional)

To run on a Firebase Realtime Database of your own:

1. Create a project at [firebase.google.com](https://firebase.google.com), then **Build → Realtime Database → Create Database**. Pick the region closest to both of you.
2. Copy the database URL (`https://<project>-default-rtdb.<region>.firebasedatabase.app`).
3. Under **Rules**, paste:

```json
{
  "rules": {
    "rooms": {
      "$roomId": {
        ".read": true,
        ".write": true,
        "sync": {
          ".validate": "newData.hasChildren(['type','time','playing','ts','from']) && newData.child('type').isString() && newData.child('time').isNumber() && newData.child('playing').isBoolean() && newData.child('ts').isNumber() && newData.child('from').isString() && newData.child('from').val().length <= 40"
        },
        "_clock": {
          ".validate": "newData.isNumber()"
        },
        "presence": {
          "$clientId": {
            ".validate": "newData.hasChild('ts') && newData.child('ts').isNumber() && (!newData.hasChild('name') || newData.child('name').val() == null || (newData.child('name').isString() && newData.child('name').val().length <= 24))"
          }
        },
        "nowWatching": {
          ".validate": "newData.hasChildren(['url','ts']) && newData.child('url').isString() && newData.child('url').val().length <= 2000 && newData.child('ts').isNumber()"
        },
        "reactions": {
          ".validate": "newData.hasChildren(['emoji','from','ts']) && newData.child('emoji').isString() && newData.child('emoji').val().length <= 8 && newData.child('from').isString() && newData.child('ts').isNumber()"
        },
        "notes": {
          ".validate": "newData.hasChildren(['text','updatedAt']) && newData.child('text').isString() && newData.child('text').val().length <= 5000 && newData.child('updatedAt').isNumber()"
        },
        "chat": {
          "$messageId": {
            ".validate": "newData.hasChildren(['text','from','ts']) && newData.child('text').isString() && newData.child('text').val().length <= 1000 && newData.child('from').isString() && newData.child('ts').isNumber() && (!newData.hasChild('name') || newData.child('name').val() == null || (newData.child('name').isString() && newData.child('name').val().length <= 24))"
          }
        },
        "$other": {
          ".validate": false
        }
      }
    }
  }
}
```

   Each field is checked for shape and size, and anything outside the known fields is rejected. Rules can't rate-limit or stop someone from guessing room codes; the 8-character codes (32^8 combinations) make that impractical, the same trade-off a shareable document link makes.
4. In the Tether popup, open **Use a different database (advanced)**, paste the URL, and click **Connect**. Whoever you watch with needs the same URL.

## Translations

UI strings live in `tools/messages_*.py`. Run `python3 tools/build_locales.py` to regenerate `_locales/`.

## Credits

Made by [Anwar Creative Studio](https://anwarcreativestudio.com/).
