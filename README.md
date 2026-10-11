# EssayMaker AI

A Telegram bot that marks Nigerian secondary school essays using **Grok-4.3** according to the official **WAEC/NECO COEM** rubric.

## Features

- Strict WAEC/NECO COEM marking (Content, Organisation, Expression, Mechanical Accuracy)
- Supports multiple pages (multi-image essays)
- Saves users, credits, essay history, and feedback in PostgreSQL
- Admin statistics (`/stats`)
- User history (`/history`)
- Feedback collection
- Credit purchase instructions (`/subscribe`)
- Admin credit management (`/credit`, `/users`)

## How to Use

1. Send your essay **topic/question**
2. Send clear photo(s) of your handwritten essay
3. Type `done` when finished
4. Get detailed marking + score out of 50

## Commands

- `/start` - Show welcome message
- `/history` - View your previous markings
- `/subscribe` - View credit purchase instructions
- `/stats` - Admin only: View usage, feedback, and credit totals
- `/credit <telegram_id> <units>` - Admin only: Add credits to a user
- `/users` - Admin only: List users and their credit balances

## Local Setup

Set `TELEGRAM_BOT_TOKEN`, `XAI_API_KEY`, and `DATABASE_URL` in your environment
or a `.env` file. `DATABASE_URL` must point to a PostgreSQL database. Tables
are created automatically at startup, and an existing `data/history.json` is
imported once when the bot first connects to the database.

## Tech Stack

- Node.js + TypeScript
- Telegraf (Telegram Bot)
- Grok-4.3 (xAI)
- Railway PostgreSQL

## Deployment

Deployed on Railway.

---

Made for Nigerian secondary school students & teachers.

By Ajiboye Oladapo 
