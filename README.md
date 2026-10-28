# Telesyncra

Telesyncra forwards **new** Telegram messages from chats your own account can already access. A separate bot gives you a private button menu for the rules. The bot does not read your private conversations.

Forwarding is done with your user account through [GramJS](https://github.com/gram-js/gramjs) (`telegram` on npm) and Telegram's native forward. By default the original sender name is hidden, using Telegram's own hide-sender flag. The recipient sees the message as sent by your account. You can show the sender name again on that rule. Protected content is skipped. Telesyncra does not download and re-upload those messages, and it does not try to get around Telegram's restrictions.

## What each part can do

| Action | Your account (GramJS) | Management bot (Bot API) |
| --- | --- | --- |
| List chats you belong to | Yes | No |
| Read a private chat, group, or channel you can access | Yes | No. A bot cannot read your private chats. |
| Forward a message you are allowed to forward | Yes | Only if the bot itself is in that chat and has permission. This app does not use the bot for forwarding. |
| Show the control menu | No | Yes, and only to the user id in `ALLOWED_USER_ID` |

Supported rule directions are private user, group (including supergroups), and channel, in any combination. The destination must be a chat **your account** can post to. Posting into a channel usually requires your account to be allowed to post there.

Messages you send yourself are ignored. Messages from other chats are ignored. Messages already in the source when a rule is activated, when the app starts, or while a rule is paused are not backfilled.

## Security

The saved session file is a login for your Telegram account. Anyone who copies it can act as you until you revoke that session in Telegram (Settings → Devices).

- Keep `.env`, `data/telesyncra.session`, and `data/telesyncra.db` on the machine that runs Telesyncra.
- Do not commit them, paste them into chats, or upload them to a host, bot, or support form.
- Telesyncra stores the session only on local disk and tries to limit the file to your OS user (`chmod 600` on Unix, `icacls` on Windows).
- Login codes and the two-step password are typed in the terminal. They are not written to logs or sent to the management bot.
- Logs record rule ids, message ids, and error codes. They do not record message text, captions, login codes, the API hash, the bot token, or the session.
- Only forward messages you are allowed to share. Protected chats and `CHAT_FORWARDS_RESTRICTED` are left alone.
- Run one copy. A second process is refused so two clients cannot forward the same message.

The `telegram` package (GramJS 2.26) is archived upstream. This project uses it because the user client has to speak MTProto. The management UI uses the maintained Bot API through `node-telegram-bot-api`.

## Setup

Requirements: Node.js 22.13 or newer, pnpm, and an interactive terminal for the first login.

### 1. Telegram API credentials

1. Open <https://my.telegram.org> and sign in with your phone.
2. Open **API development tools**.
3. Create an application if you do not already have one.
4. Copy the numeric **App api_id** and the **App api_hash**.

The hash is a secret. Put it only in `.env`.

### 2. Management bot

1. In Telegram, open [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow the prompts.
3. Copy the bot token into `.env`.
4. Optional: send `/setjoingroups` and disable groups. Telesyncra also ignores updates that are not in a private chat with you.

The bot cannot see your private messages. It only receives the commands and button taps you send to it.

### 3. Your user id

`ALLOWED_USER_ID` is your numeric Telegram user id, not your phone number and not an `@username`.

You can read it from a client that shows numeric ids, or send `/start` to a public id bot you already trust, such as [@userinfobot](https://t.me/userinfobot). Only that id can open the menu. Everyone else gets "This bot is private."

### 4. Install and configure

```bash
pnpm install
cp .env.example .env
```

On Windows PowerShell you can use `Copy-Item .env.example .env`.

Edit `.env`:

```env
TG_API_ID=12345678
TG_API_HASH=your_32_character_hex_hash
BOT_TOKEN=123456789:your_bot_token
ALLOWED_USER_ID=1000000000
SESSION_PATH=./data/telesyncra.session
DATABASE_PATH=./data/telesyncra.db
LOG_LEVEL=info
```

The values above are placeholders. `.env.example` is the only env file that belongs in git.

### 5. Check and start

```bash
pnpm run check
pnpm start
```

`pnpm run check` runs the TypeScript typecheck, ESLint, and the test suite.

The first start must be an interactive terminal. Telesyncra asks for:

1. Your phone number in international format, for example `+15551234567`.
2. The login code Telegram sends to your account.
3. The two-step verification password, if you enabled it.

A later start reuses `data/telesyncra.session` and does not ask again. When the process is up it prints `Telesyncra is running`. Open your bot and send `/start`.

## Using the menu

Open the bot and send `/start`. The menu is one message. Tapping a button rewrites that message, the same way BotFather walks through a step. Blue is the main action, green confirms or starts a rule, and red deletes.

The button beside the message field opens the command list: `/start`, `/menu`, `/status`, `/cancel`, and `/help`.

- **Create a rule** — choose Private user, Group, or Channel for the source, pick a recent chat or enter a `@username` / numeric id, then do the same for the destination. On the review step, the original sender is hidden. Tap **Show original sender** if the recipient should see who wrote it. Confirm before the rule is saved.
- **My rules** — status, source, destination, and whether the sender is hidden. No message text.
- **Start or pause** — pausing stops forwarding. Starting again sets a new baseline, so messages from the pause are not sent later.
- **Edit a rule** — change the source, the destination, or whether the original sender name is hidden. Changing a chat refreshes the baseline.
- **Delete a rule** — removes the rule only. Messages already delivered stay in Telegram.
- **Logs** — successes and error codes.
- **Settings** — connection status, pause all, resume all, clear logs.

When a step needs a username or id, a short message opens Telegram's reply bar. Send the value there. Invite links (`t.me/+...`) are rejected. `/cancel` or Cancel leaves the step. A wizard step expires after 15 minutes.

Numeric ids use Telegram's bot-style form: a user id is positive, a basic group is negative, and a channel or supergroup looks like `-100...`. If you type the raw positive channel id while the selected type is Group or Channel, Telesyncra also tries the `-100` form. Invite links (`t.me/+...`) are rejected. Join the chat with your account first, then pick it or send its id.

The chat list is the most recent dialogs, including archived ones when Telegram returns them. Older chats can still be entered by username or id.

## What gets forwarded

Text, photos, videos, documents, and other normal message types are forwarded with `messages.forwardMessages`. Albums are collected briefly and forwarded together. Service messages (joins, title changes, and similar) are skipped. Your own outgoing messages are skipped. If a chat or message has forwarding disabled, Telesyncra records the skip and stops. It will not fall back to copying the file.

A short flood wait is retried once. A network error is not retried, because the forward may already have succeeded and a second try could duplicate it. The same message is not forwarded twice for the same rule: the database stores the rule id and message id. Two rules can still send one source message to two destinations.

On startup, every active rule's baseline moves to the latest source message. History from while the app was stopped is not forwarded. During a reconnect in the same run, the baseline stays put and Telegram's own update catch-up can deliver messages that arrived after the process started. Those still have to be newer than the baseline, and the database blocks duplicates.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| `TG_API_ID` / `TG_API_HASH` / `BOT_TOKEN` error | Compare `.env` with the values from my.telegram.org and BotFather. The hash is 32 hex characters. |
| Bot says "This bot is private." | `ALLOWED_USER_ID` is not the id of the account that tapped the button. |
| Bot does not answer | The process is not running, the token is wrong, or you have not sent `/start`. The bot cannot message you first. |
| Login code never arrives | Check the Telegram app, not only SMS. Wait before requesting another code. Repeated requests cause `FLOOD_WAIT`. |
| `FLOOD_WAIT` | Stop and wait. Do not start a second copy. |
| `API_ID_INVALID` | The id and hash do not match an application on my.telegram.org. |
| `CHAT_WRITE_FORBIDDEN` or `CHAT_ADMIN_REQUIRED` | Your account cannot post in the destination. Add that permission in Telegram. The bot is not used as a workaround. |
| `CHAT_FORWARDS_RESTRICTED` | The source disallows forwarding. This is expected. |
| `CHANNEL_PRIVATE` or chat not found | Join the chat with the same account that logged in, then try again. |
| `Telesyncra is already running` | Stop the other process. Only one instance may use the session and database. |
| Saved session stops working | Stop Telesyncra, delete `data/telesyncra.session`, and log in again. Or revoke the **Telesyncra** device under Telegram → Settings → Devices. |
| No interactive prompt on a server | Log in once on a machine with a terminal, then copy the session file to the server by a private channel you control. Do not put it in git. |

Logs are JSON lines on stdout and stderr. `LOG_LEVEL=debug` is noisier and still must not be pointed at a log shipper that you do not trust with account metadata.

## Deploying it

Run Telesyncra on a machine you control, under its own OS user, with disk encryption if the disk can be taken. The process has to stay running; it is not a serverless webhook.

- One instance only.
- Keep `data/` out of backups that other people can read, or encrypt those backups.
- Do not deploy the session to a public paste, a shared CI log, or a third-party file host.
- A process manager can restart it after a crash (`Restart=on-failure` in systemd, or Task Scheduler on Windows). The first login still needs a terminal. Later restarts reuse the session.
- Revoke the session from Telegram if the computer is lost.

Example systemd unit, after you have already logged in once and the files exist:

```ini
[Service]
WorkingDirectory=/opt/telesyncra
ExecStart=/usr/bin/pnpm start
Restart=on-failure
User=telesyncra
NoNewPrivileges=true
```

## Development

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run lint
pnpm run check
pnpm dev
```

Tests cover rule creation for every chat combination, menu access control, callback and manual-input validation, duplicate message claims, protected-content handling, flood waits, and permission errors. They do not call Telegram.

Optional native builds for `bufferutil` and `utf-8-validate` are disabled. GramJS falls back to the pure JavaScript websocket. `esbuild` is allowed to build so the TypeScript runner and tests work.
