# Instagram DM Unsend

Unsends **your own** messages in one Instagram DM conversation, for both sides, by driving the normal instagram.com web UI in a browser window on your computer.

- Runs on your machine, in a browser profile kept in `.browser-profile/`. You log in yourself in the window. Your password never goes into the code or a file.
- It only touches the one conversation you pick, and only messages whose menu offers **Unsend** (the other person's messages are skipped).
- **Unsending is permanent.** Download a copy first if you might want it later (Instagram → Settings → Your activity → Download your information).

## Requirements

- Node.js 20 or newer
- Google Chrome (otherwise run `npx playwright install chromium` once)

```bash
npm install
```

## Usage

1. Switch Instagram web to **English** (the language selector at the bottom of instagram.com). The bot looks for the English button names; Arabic is supported on a best-effort basis.
2. Copy the conversation link from instagram.com, e.g. `https://www.instagram.com/direct/t/1234567890/`.
3. Do a dry run first. It opens each message's menu and closes it without unsending:

   ```bash
   npm start -- "https://www.instagram.com/direct/t/1234567890/" --dry-run --limit 5
   ```

   On the first run, log in inside the window that opens, then press Enter in the terminal.
4. Try a real run on a few messages, then on the whole conversation:

   ```bash
   npm start -- "https://www.instagram.com/direct/t/1234567890/" --limit 5
   npm start -- "https://www.instagram.com/direct/t/1234567890/"
   ```

   Type `YES` to confirm. Keep the window open; you can minimize it. Press `Ctrl+C` to stop, and run the same command again to continue where it stopped.

Without a link, the bot opens your inbox and asks you to open the conversation in the window.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--dry-run` | off | Count your messages without unsending |
| `--limit N` | all | Stop after N messages |
| `--min-delay` / `--max-delay` | 1500 / 4000 | Random wait between unsends, in ms |
| `--break-every N` | 40 | Take a longer break every N unsends (0 = never) |
| `--break-seconds S` | 90 | Length of that break |
| `--yes` | off | Skip the `YES` confirmation |
| `--inspect` | off | Save the button labels on the page to `debug/` (no message text) |

## Limits and risks

- **Instagram rate limits are not published.** The bot stops as soon as Instagram shows "Try again later" / action blocked. If that happens, wait a day and raise the delays.
- **Automating Instagram is against its Terms of Use.** The bot behaves like a person clicking, slowly, but the risk to your account is not zero.
- **It depends on Instagram's page structure.** If Instagram changes it, the bot finds nothing or stops after 5 unsends that did not go through. Run `npm run inspect -- "<conversation link>"` and use the file in `debug/` to update the labels in `unsend.mjs`.
- Unsending does not undo what the other person already saw, saved, screenshotted, or downloaded.

## Tests

The tests run the bot against a local copy of a DM thread (`test/mock-thread.html`), not against Instagram:

```bash
npm test
```
