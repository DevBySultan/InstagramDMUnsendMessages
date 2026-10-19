# IG Unsend

A command-line tool that unsends **your own** messages in an Instagram DM conversation, for both sides. It drives the normal instagram.com website in a browser window on your computer, with menus you control from the terminal.

```
  ┌─────────────────────────────────────────────────────┐
  │ IG Unsend  v1.0.0                                   │
  │ Unsend your own Instagram messages, for both sides. │
  └─────────────────────────────────────────────────────┘

  Speed Safe   Limit None   Saved login Yes

? What do you want to do?
> Test run
  Unsend my messages
 ──────────────
  Settings
  Diagnose
  Log out
  Help
 ──────────────
  Exit
```

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
2. **Unsend my messages** when the test finds your messages. The tool shows the conversation, speed and limit, and starts only when you type `UNSEND`.
3. While it runs you see the count, the speed per minute and the time. Keep the browser window open (minimizing is fine). **Ctrl+C** stops safely after the current message; running it again continues where it stopped.

Conversations you used appear at the top of the list next time, with how many messages were unsent.

## Settings

| Setting | Options |
| --- | --- |
| Speed | **Safe** (default): 3-7 s between messages, 2 min break every 30 · **Normal**: 1.5-4 s, 90 s break every 40 · **Fast**: 0.8-2 s, 1 min break every 60 |
| Messages per run | Stop after this many, to spread a big conversation over several days. 0 = no limit |

Settings and the recent conversations are saved in `settings.json` in the tool's folder. The Instagram login is kept in `.browser-profile/`; **Log out** deletes it.

## Limits and risks

- **Instagram's rate limits are not published.** The tool stops as soon as Instagram shows "Try again later". Wait a day, then use the Safe speed.
- **Automating Instagram is against its Terms of Use.** The tool clicks like a person and is slow on purpose, but the risk to your account is not zero.
- **It depends on how instagram.com is built.** Keep Instagram in English. If the tool cannot find your messages, choose **Diagnose**: it saves a report to `debug/` with the page structure and button names (no message text) that shows what to fix.
- Unsending does not undo what the other person already saw, saved, screenshotted or downloaded.

## Project layout

| Path | What it is |
| --- | --- |
| `bin/ig-unsend.mjs` | The `ig-unsend` command |
| `src/cli.mjs` | Menus, choosing a conversation, progress and summary |
| `src/unsender.mjs` | Browser automation: finding your messages and unsending them |
| `src/settings.mjs` | Speed presets, limit and recent conversations |
| `src/ui.mjs` | Terminal output helpers |
| `test/` | Tests against a local copy of a DM page (`mock-thread.html`), not against Instagram |

```bash
npm test
```
