# Discord Auto-Mod Bot

A Discord bot that automatically moderates servers by detecting and timing out users for spam, mass mentions, and webhook activity.

## Features

- **Spam detection**: Times out users who send 10+ messages within 4 seconds
- **Mass mention detection**: Times out users who mention more than 3 users in a single message
- **Webhook detection**: Times out members associated with suspicious webhook messages
- **Admin bypass**: Administrators are never affected by auto-mod actions

## Settings (bot.js)

| Constant | Value | Description |
|---|---|---|
| `MESSAGE_LIMIT` | 10 | Max messages allowed in the time frame |
| `TIME_FRAME` | 4000ms | Rolling window for spam detection |
| `TIMEOUT_DURATION` | 5 hours | Duration of the timeout |
| `MAX_MENTIONS` | 3 | Max user mentions allowed per message |

## Project Structure

- `bot.js` — Main bot file with all moderation logic
- `package.json` — Node.js project config and dependencies

## Secrets

- `DISCORD_BOT_TOKEN` — Discord bot token (set in Replit Secrets)

## Running

The bot runs via the "Start application" workflow using `node bot.js`.

## Dependencies

- `discord.js` v14
