import { Telegraf } from 'telegraf';
import { generateText } from 'ai';
import { xai } from '@ai-sdk/xai';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
const model = xai('grok-4.3');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const historyFile = path.join(dataDir, 'history.json');
let history: any[] = [];
if (fs.existsSync(historyFile)) {
  history = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
}

const ADMIN_ID = 1693748981;

// Daily usage tracking: userId -> { date: string, count: number }
const dailyUsage = new Map<number, { date: string; count: number }>();

const userState = new Map<number, { topic?: string; images: string[] }>();

const SYSTEM_PROMPT = `You are a **very strict** WAEC/NECO examiner.

Use the official COEM rubric:
- Content (10 marks)
- Organisation (10 marks)
- Expression (20 marks)
- Mechanical Accuracy (10 marks)
**Total: 50 marks**

Be strict and realistic.`;

bot.start((ctx) => {
  ctx.reply(
    `👋 *Welcome to EssayMaker Bot!*\n\n` +
    `You can mark up to **3 essays per day**.\n\n` +
    `1. Send your essay topic first\n` +
    `2. Send clear photo(s)\n` +
    `3. Type *done* when finished`,
    { parse_mode: 'Markdown' }
  );
});

// Check daily limit
function canMarkToday(userId: number): { allowed: boolean; remaining: number } {
  const today = new Date().toISOString().split('T')[0];
  const usage = dailyUsage.get(userId);

  if (!usage || usage.date !== today) {
    dailyUsage.set(userId, { date: today, count: 0 });
    return { allowed: true, remaining: 3 };
  }

  const remaining = 3 - usage.count;
  return { allowed: remaining > 0, remaining };
}

// Commands
bot.command('history', (ctx) => { /* ... your history code */ });
bot.command('stats', (ctx) => { /* ... your stats code */ });

// Text Handler
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();
  const lower = text.toLowerCase();

  if (lower.startsWith('/')) return;

  // Check daily limit before allowing new topic
  if (lower !== 'done') {
    const limit = canMarkToday(userId);
    if (!limit.allowed) {
      return ctx.reply(`⛔️ You have reached your daily limit of 3 essays.\n\nCome back tomorrow for more markings.`);
    }
  }

  if (lower === 'done') {
    // ... (your existing done logic)
    const state = userState.get(userId);
    if (!state || state.images.length === 0) return ctx.reply("Please send at least one photo.");

    await ctx.reply("⏳ Marking your essay...");

    try {
      // ... marking logic (same as before)

      // Update daily usage after successful marking
      const today = new Date().toISOString().split('T')[0];
      const usage = dailyUsage.get(userId) || { date: today, count: 0 };
      usage.count += 1;
      dailyUsage.set(userId, usage);

      await ctx.reply("📝 Would you like to give feedback? Reply *yes* or *no*.");

    } catch (error) {
      console.error(error);
      await ctx.reply("❌ Failed to mark essay.");
    }
    userState.delete(userId);
    return;
  }

  // New Topic
  userState.set(userId, { topic: text, images: [] });
  const limit = canMarkToday(userId);
  await ctx.reply(`✅ Topic saved: "${text}"\n\nRemaining essays today: *${limit.remaining}*\n\nSend your essay photo(s). Type *done* when finished.`, { parse_mode: 'Markdown' });
});

// Photo Handler (same as before)
bot.on('photo', async (ctx) => {
  // ... your existing photo handler
});

bot.launch()
  .then(() => console.log('✅ Bot is running with 3 essays/day limit'))
  .catch(console.error);
