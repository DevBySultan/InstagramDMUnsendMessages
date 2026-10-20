# IG Unsend

A command-line tool that unsends **your own** messages in an Instagram DM conversation, for both sides. It drives the normal instagram.com website in a browser window on your computer, with menus you control from the terminal.

```
  ╔══════════════════════════════════════════════════════════════════════════╗
  ║   ██╗ ██████╗     ██╗   ██╗███╗   ██╗███████╗███████╗███╗   ██╗██████╗   ║
  ║   ██║██╔════╝     ██║   ██║████╗  ██║██╔════╝██╔════╝████╗  ██║██╔══██╗  ║
  ║   ██║██║  ███╗    ██║   ██║██╔██╗ ██║███████╗█████╗  ██╔██╗ ██║██║  ██║  ║
  ║   ██║██║   ██║    ██║   ██║██║╚██╗██║╚════██║██╔══╝  ██║╚██╗██║██║  ██║  ║
  ║   ██║╚██████╔╝    ╚██████╔╝██║ ╚████║███████║███████╗██║ ╚████║██████╔╝  ║
  ║   ╚═╝ ╚═════╝      ╚═════╝ ╚═╝  ╚═══╝╚══════╝╚══════╝╚═╝  ╚═══╝╚═════╝   ║
  ║                     ♦  Quod scripsi, delevi  ♦                           ║
  ╚══════════════════════════════════════════════════════════════════════════╝

♦ What do you want to do?
► 1. Test run
  2. Unsend my messages
```

Gold on dark in terminals with 24-bit color (Windows Terminal, modern cmd), plain yellow elsewhere. Choose with the arrow keys or the item's number, then Enter.

- Opens your installed Google Chrome as plain Chrome, with its own profile, and controls it from the terminal. It does not use the automation switches test tools add, which Instagram can treat differently from a normal browser.
- Runs only on your computer. You log in to Instagram yourself, in the browser window. Your password is never typed into the tool or saved by it.
- Touches only the conversation you choose, and only messages whose menu offers **Unsend**.
- **Unsending is permanent.** If you might want a copy, download it first (Instagram → Settings → Your activity → Download your information).

## Install (once)

You need [Node.js](https://nodejs.org) 20.17 or newer and Google Chrome.

```bat
git clone https://github.com/DevBySultan/InstagramDMUnsendMessages.git
cd InstagramDMUnsendMessages
npm install
npm link
```

`npm link` adds the `ig-unsend` command, so you can start the tool from any folder.

## Start

Open cmd (or any terminal) and type:

```bat
ig-unsend
```

Without `npm link`, run `start.cmd` in the tool's folder (or double-click it), or `npm start`.

Use the arrow keys and Enter to choose.

1. **Test run** first. A browser window opens. The first time, log in to Instagram there. Pick the conversation: paste its link (open the chat on instagram.com and copy the address bar), or open it in the browser window. The test checks a few of your messages and deletes nothing.
2. **Unsend my messages** when the test finds your messages. First a checklist: Instagram in English, Safe speed, no refusal or limit from Instagram in the last 24 hours, an hour since the last run, a test run done on this conversation, and what is left of today's cap. Then the conversation, speed and limit, and it starts only when you type `UNSEND`.
3. While it runs you see the count, the speed per minute and the time. Keep the browser window open (minimizing is fine). **Ctrl+C** stops safely after the current message; running it again continues where it stopped.

Conversations you used appear at the top of the list next time, with how many messages were unsent and how the last run ended (done, stopped partway, rate limited, or "web cannot unsend this"), so you know which ones not to retry.

**Saved conversations** lets you open one in the browser window, rename them, remove the ones you pick, or remove all of them. This only changes the list kept in the tool; it does not touch Instagram.

**The Chronicle** keeps a record of every run: when, which conversation, how many messages, how long, and how it ended, with all-time totals. It holds counts and outcomes only, never message text, and can be cleared from the same screen.

## Settings

| Setting | Options |
| --- | --- |
| Speed | **Safe** (default): 3-7 s between messages, 2 min break every 30 · **Normal**: 1.5-4 s, 90 s break every 40 · **Fast**: 0.8-2 s, 1 min break every 60 |
| Messages per run | Stop after this many, to spread a big conversation over several days. 0 = no limit |
| Bell when done | Rings the terminal bell when a run ends, so you know even with the window minimized. On by default |
| Daily cap | Most messages to unsend in one day, across all runs (default 300). A guard of our own: Instagram does not publish its limits. 0 = no cap |

Settings and the saved conversations are kept in `settings.json` in the tool's folder, the Chronicle in `history.json`, and the Instagram login in `.browser-profile/`. **Log out** erases all of it: the login, the saved conversations, the Chronicle, the settings and any diagnose reports. Messages you unsent stay unsent.

Closing the terminal window also closes the tool's browser window.

## Limits and risks

- **Instagram's rate limits are not published.** The tool stops as soon as Instagram shows "Try again later". Wait a day, then use the Safe speed.
- **Messages that vanish and come right back** mean Instagram's server refused the unsend: Instagram hides the message at once and restores it when the server says no. The tool checks every message after unsending, checks again at each break and at the end of the run, and does not count restored ones, so the record never counts a message that came back later. It recognizes a restored message by its place in the chat, so repeated texts like "ok" from older history are not mistaken for one. If the **first** message of a run comes back, it stops at once (the conversation does not take unsends from the web, or the account is limited) and tells you how to tell which with your phone. If messages come back **after others worked**, it is a rate limit: it stops after two. Either way it remembers, and warns you for the next 24 hours.
- **One conversation per sitting.** Trying several conversations in a row after Instagram refuses one only adds attempts against the account.
- **Automating Instagram is against its Terms of Use.** The tool clicks like a person and is slow on purpose, but the risk to your account is not zero.
- **It depends on how instagram.com is built.** Keep Instagram in English. If the tool cannot find your messages, choose **Diagnose**: it saves a report to `debug/` with the page structure and button names (no message text) that shows what to fix.
- Unsending does not undo what the other person already saw, saved, screenshotted or downloaded.

## Project layout

| Path | What it is |
| --- | --- |
| `bin/ig-unsend.mjs` | The `ig-unsend` command |
| `src/cli.mjs` | Menus, choosing a conversation, progress and summary |
| `src/unsender.mjs` | Browser automation: finding your messages and unsending them |
| `src/browser.mjs` | Starts Google Chrome as plain Chrome (no automation switches) and connects to it |
| `src/settings.mjs` | Speed presets, limits and saved conversations |
| `src/history.mjs` | The Chronicle: the record of past runs |
| `src/ui.mjs` | Terminal output helpers |
| `test/` | Tests against a local copy of a DM page (`mock-thread.html`), not against Instagram |

```bash
npm test
```
