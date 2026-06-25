# EssayMaker Bot

A Telegram bot that marks Nigerian secondary school essays using **Grok-4.3** according to the official **WAEC/NECO COEM** rubric.

## Features

- Strict WAEC/NECO COEM marking (Content, Organisation, Expression, Mechanical Accuracy)
- Supports multiple pages (multi-image essays)
- Saves marking history locally
- Admin statistics (`/stats`)
- User history (`/history`)
- Feedback collection

## How to Use

1. Send your essay **topic/question**
2. Send clear photo(s) of your handwritten/printed essay
3. Type `done` when finished
4. Get detailed marking + score out of 50

## Commands

- `/start` - Show welcome message
- `/history` - View your previous markings
- `/stats` - Admin only: View total usage

## Tech Stack

- Node.js + TypeScript
- Telegraf (Telegram Bot)
- Grok-4.3 (xAI)
- Local JSON storage

## Deployment

Deployed on Railway.

---

Made for Nigerian secondary school students & teachers.

By Ajiboye Oladapo 