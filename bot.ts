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

const userState = new Map<number, { step: string; topic?: string; images: string[] }>();

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
    `1. Send your essay topic first\n` +
    `2. Send clear photo(s) of your answer\n` +
    `3. Type *done* when finished`,
    { parse_mode: 'Markdown' }
  );
});

// Commands
bot.command('history', (ctx) => {
  const myHistory = history.filter(h => h.userId === ctx.from.id);
  if (myHistory.length === 0) return ctx.reply("You have no previous markings yet.");

  let msg = "📜 *Your Marking History:*\n\n";
  myHistory.slice(-5).reverse().forEach((h, i) => {
    msg += `${i+1}. ${new Date(h.date).toLocaleDateString()} — ${h.topic.substring(0, 60)}...\n`;
  });
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.command('stats', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply("❌ Admin only.");
  ctx.reply(`📊 Total Essays: ${history.length}\nUnique Users: ${new Set(history.map(h => h.userId)).size}`);
});

// Text Handler
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();
  const lower = text.toLowerCase();

  if (lower.startsWith('/')) return;

  const state = userState.get(userId);

  if (lower === 'done') {
    if (!state || state.images.length === 0) {
      return ctx.reply("Please send at least one photo first.");
    }

    await ctx.reply("⏳ Marking your essay...");

    try {
      const imageContents = state.images.map(url => ({ type: 'image' as const, image: url }));

      const { text: result } = await generateText({
        model,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: `Topic: ${state.topic}\n\nMark this essay very strictly.` },
            ...imageContents
          ] as any
        }]
      });

      await ctx.reply(result || "✅ Marking completed.", { parse_mode: 'Markdown' });

      history.push({
        userId,
        username: ctx.from.username || ctx.from.first_name,
        topic: state.topic,
        result,
        pages: state.images.length,
        date: new Date().toISOString()
      });

      fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));

      await ctx.reply("📝 Would you like to give feedback? Reply *yes* or *no*.");

    } catch (error) {
      console.error(error);
      await ctx.reply("❌ Failed to mark essay.");
    }

    userState.delete(userId);
    return;
  }

  // Handle Feedback Flow
  if (state?.step === 'feedback') {
    if (lower === 'yes') {
      await ctx.reply("⭐️ Rate the bot from 1 to 5:");
      userState.set(userId, { step: 'rating', topic: '', images: [] });
    } else {
      await ctx.reply("Thank you! Send a new topic to start again.");
      userState.delete(userId);
    }
    return;
  }

  if (state?.step === 'rating') {
    const rating = parseInt(text);
    if (rating >= 1 && rating <= 5) {
      await ctx.reply("Thank you for your feedback! 🙏");
    } else {
      await ctx.reply("Please reply with a number between 1 and 5.");
      return;
    }
    userState.delete(userId);
    return;
  }

  // New Topic
  userState.set(userId, { step: 'photos', topic: text, images: [] });
  await ctx.reply(`✅ Topic saved: "${text}"\n\nNow send your essay photo(s).\nType *done* when finished.`);
});

// Photo Handler
bot.on('photo', async (ctx) => {
  const userId = ctx.from.id;
  let state = userState.get(userId);

  if (!state) {
    state = { step: 'photos', topic: 'No topic', images: [] };
    userState.set(userId, state);
  }

  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  const file = await ctx.telegram.getFile(photo.file_id);
  const imageUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

  state.images.push(imageUrl);
  await ctx.reply(`📸 Page ${state.images.length} received.\nSend more or type *done*.`);
});

bot.launch()
  .then(() => console.log('✅ EssayMaker Bot is running...'))
  .catch((err) => console.error('Bot failed to start:', err));