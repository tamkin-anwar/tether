# Privacy Policy for Tether

Tether is a browser extension that synchronizes video playback between two people watching the same streaming service in separate browser tabs, plus a small shared notes pad, chat, and emoji reactions for people using it together.

## What Tether does and does not do

Tether never accesses, records, or transmits the video content you stream. It only reads the play/pause state and current timestamp of the video player already visible on the page you're on, and shares that timing information with the other person in your room so your playback stays in sync.

## What data is stored

Using Tether sends the following to a Firebase Realtime Database (a cloud database), so it can be shared between the people in your room:

- Playback state: whether the video is playing or paused, and its current timestamp
- Chat messages you type into the extension's Chat tab
- Emoji reactions you send
- Notes you type into the extension's Notes tab
- The nickname you optionally set under "Your name," shown to whoever you're in a room with, never required to use Tether
- The URL of the title you're currently watching, so an invite link can take the other person straight to it, not the wider list of everywhere you browse
- A randomly generated room code, used to keep separate groups of users from seeing each other's data
- Two randomly generated identifiers, one per browser install and one shared across your own signed-in browsers, used only so Tether can tell "the other person is here" apart from "your own other device is here." They aren't linked to your name, email, or Google account

This data lives under a room code that only you and whoever you share that code with know. It's sent over an encrypted (HTTPS) connection and stored in Firebase, which encrypts it at rest. Tether does not collect your legal name, email address, IP address, or any information about which websites you visit beyond the specific title you're currently watching together.

Because anyone with your room code or invite link can open that room, treat the link like a private link and only share it with the people you're watching with.

## Data sharing

Tether does not sell, rent, or share your data with any third party, other than Firebase (Google), which is the database used to relay it between your own devices and the people you choose to share a room code with. Tether's developer does not separately access, read, or use the contents of your chats or notes.

## Data retention and deletion

Chat and notes stay in the shared database until you delete them. To delete them, open Tether's Chat tab and choose **Clear chat and notes**. This removes every chat message and the shared notes for that room, for everyone in it, immediately and permanently. Playback state, the title you're watching, and your nickname are overwritten as you use Tether rather than kept as a history.

Leaving a room or uninstalling the extension does not delete that room's chat and notes, so clear them first if you want them gone.

Please never post your room code or invite link anywhere public, including GitHub issues, since anyone who sees it can open your room.

## Changes to this policy

This policy may be updated as Tether adds features. Check back here for the current version.

Contact: [github.com/tamkin-anwar/tether/issues](https://github.com/tamkin-anwar/tether/issues) (issues are public, so leave your room code out)

---

Tether is built and run by Anwar Creative Studio. If anything here ever stops matching what the extension actually does, tell us directly.
