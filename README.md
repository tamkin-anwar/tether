# Tether

Watch Netflix, Hulu, Disney+, Crunchyroll, Max, or YouTube together while you're apart. Playback stays in sync across both your tabs, plus a shared notes pad and chat, without needing six different apps.

## How it works

Same architecture as Teleparty/SyncUp: this never touches the actual video stream (which is DRM-protected and off-limits to any third party). Instead, each of you streams from your own account in your own browser tab, and the extension mirrors play/pause/seek events between your tabs through a small shared database. Because it only ever calls standard playback controls, it works within each service's terms rather than around them.

That also means **it only works when you're both watching in a desktop browser tab** (e.g. netflix.com in Chrome). It can't reach into any of these services' iPhone or Smart TV apps, since those don't expose any way for a third-party extension to see or control them.

**On the sync being tight:** the two of you being on opposite sides of the world means real physical latency (routing plus, at the extreme, speed-of-light delay). No tool, including Teleparty, can make a message arrive before it physically can. What Tether does do: it calibrates each tab's clock against the shared database's own clock (rather than trusting either laptop's system clock, which can already be a few hundred ms off), timestamps every play/pause/seek with that corrected time, and continuously nudges playback to compensate for exactly how long a message took in transit. So instead of "wherever the position was when the message was *sent*," you land on "wherever the position *actually is right now*, accounting for transit." That's the same principle behind any properly engineered low-latency sync, and it's the main lever available once the physical distance is fixed.

**On the VPN:** since Tether only ever calls the standard play/pause/seek controls on whichever tab is open, never touching the video stream itself, a VPN on her end (for Disney+/HBO Max) doesn't affect Tether at all. It only matters for whether Netflix/Disney+ let the stream through in the first place, which is entirely between her and them.

## One-time setup (you'll need to do this part)

Firebase Realtime Database is the shared "phone line" between your two tabs. I can't create this account for you, but it takes about two minutes:

1. Go to [firebase.google.com](https://firebase.google.com), click **Get started**, and sign in with any Google account.
2. Click **Add project**, name it anything (e.g. "tether"), skip Google Analytics, then **Create project**.
3. In the left sidebar, click **Build**, then **Realtime Database**, then **Create Database**. For the location, pick **Singapore (asia-southeast1)**. With one of you in Bangladesh, a database on the other side of the world (the US default) adds real, physical round-trip delay to every sync message; Singapore is the closest available region and meaningfully cuts that lag for both of you. Start in **test mode** for now (we'll paste in real rules below).
4. Once it's created, copy the URL shown at the top of the database page. It looks like `https://tether-xxxxx-default-rtdb.firebaseio.com`.
5. Click the **Rules** tab (next to Data) and replace the contents with:
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
   Anyone who knows your room code can still read/write it, same trust model as a Google Doc link, that part hasn't changed. What's new: each field is now shape- and size-checked (a chat message can't be gigabytes long, `playing` has to actually be a boolean, and so on), and anything that isn't one of the known fields (`sync`, `presence`, `nowWatching`, `reactions`, `notes`, `chat`, `_clock`) gets rejected outright via `$other`. That mostly guards against cost/storage abuse and outright garbage, not a determined attacker: Realtime Database rules alone can't rate-limit requests or block someone from scanning many room codes quickly, that needs real backend infra (Cloud Functions, App Check) that doesn't exist here. Worth knowing, not solved by this change: on the audience Tether has today, the room code's 32^8 keyspace and every session's low informational value (playback timing, not anything sensitive) make that an acceptable, disclosed tradeoff, the same one a shareable Google Doc link makes.
6. Click **Publish**. Test that sync, chat, notes, presence, and reactions still all work right after, since a validate rule that's stricter than it should be would silently reject a legitimate write rather than error loudly, better to catch that immediately than have it show up as "it just doesn't work" days later. The console keeps rule history if anything needs rolling back.

## Installing the extension

1. In Chrome, go to `chrome://extensions`, turn on **Developer mode** (top right).
2. Click **Load unpacked**, and select this `Tether` folder.
3. Click the Tether icon in your toolbar, paste the Database URL from step 4 above into **Firebase Database URL**, and click **Connect**.
4. Send your girlfriend this same folder (or once we're happy with it, publish it to the Chrome Web Store so she can just install it) and have her do steps 1 to 3 with the *same* Database URL.
5. One of you opens the popup and clicks **Copy invite link**, then sends that over. Clicking it drops the other person straight into the room, and once you've pressed play, straight to the exact title (see `content_scripts/join.js`). Pasting just the room code into **Their code** under "Join someone else's room" still works too, for anyone who'd rather send that instead.
6. Both open Netflix, Hulu, Disney+, Crunchyroll, Max, or YouTube, both hit play on the same title. Playback will mirror from here.

## What's here now, and what's next

- Done: play/pause/seek sync on Netflix, Hulu, Disney+, Crunchyroll, Max, and YouTube, with periodic drift correction so long viewing sessions don't slowly slip out of sync, and an automatic catch-up to wherever the other person already is the moment your own video loads
- Done: a real invite link, not just a room code, that drops the other person straight into the exact title once they've pressed play (`content_scripts/join.js`)
- Done: presence ("someone else is in this room," not just "connected"), with an optional nickname attached to it and to chat
- Done: a shared notes pad, a basic chat, and emoji reactions, the last two both in the popup and, for reactions, as a floating overlay on the video itself
- Not yet: Prime Video support (same approach as the others, just needs a small site-specific adapter, like `content_scripts/hulu.js`; Prime's player is more obfuscated and changes more often, so it'll likely need more upkeep than the rest)
- Not yet: a shared file drop (needs Firebase Storage, a bit more setup than Realtime Database)
- Not yet: an on-page chat overlay while watching, instead of only in the popup (reactions already work this way, chat itself still doesn't)

## Credits

Built by **Anwar Creative Studio**.
