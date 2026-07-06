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

const dailyUsage = new Map<number, { date: string; count: number }>();
const userTopics = new Map<number, string>();
const userImages = new Map<number, string[]>();
const userFeedbackState = new Map<number, string>(); // 'rating'

const SYSTEM_PROMPT = `You are a **very strict** WAEC/NECO examiner.
Use the official COEM rubric:
- Content (10 marks)
- Organisation (10 marks)
- Expression (20 marks)
- Mechanical Accuracy (10 marks)
**Total: 50 marks**
Be strict and consistent. Similar quality essays should receive similar scores. If the essay has little or no relevance to the given topic, give very low Content score (0-3/10).`;

bot.start((ctx) => {
  ctx.reply(
    `👋 *Welcome to EssayMaker Bot!*\n\n` +
    `1. Send topic\n` +
    `2. Send photos\n` +
    `3. Type *done*`,
    { parse_mode: 'Markdown' }
  );
});

// Commands
bot.command('history', (ctx) => {
  const myHistory = history.filter(h => h.userId === ctx.from.id);
  if (myHistory.length === 0) return ctx.reply("You have no previous markings yet.");
  let msg = "📜 *Your Marking History:*\n\n";
  myHistory.slice(-10).reverse().forEach((h, i) => {
    msg += `${i+1}. ${new Date(h.date).toLocaleDateString()} — ${h.topic.substring(0, 60)}...\n`;
  });
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.command('stats', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply("❌ Admin only.");

  const totalEssays = history.length;
  const uniqueUsers = new Set(history.map(h => h.userId)).size;

  // Feedback statistics
  const feedbacks = history.filter(h => h.rating);
  const totalFeedbacks = feedbacks.length;
  let avgRating = 0;
  if (totalFeedbacks > 0) {
    avgRating = feedbacks.reduce((sum, h) => sum + h.rating, 0) / totalFeedbacks;
  }

  let statsMsg = `📊 *Admin Statistics*\n\n`;
  statsMsg += `Total Essays Marked: ${totalEssays}\n`;
  statsMsg += `Unique Users: ${uniqueUsers}\n`;
  statsMsg += `Total Feedbacks: ${totalFeedbacks}\n`;
  if (totalFeedbacks > 0) statsMsg += `Average Rating: ${avgRating.toFixed(1)} / 5\n\n`;

  ctx.reply(statsMsg, { parse_mode: 'Markdown' });
});

// Text Handler
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();
  const lower = text.toLowerCase();

  if (lower.startsWith('/')) return;

  // Handle "done"
  if (lower === 'done') {
    const topic = userTopics.get(userId) || "No topic";
    const images = userImages.get(userId) || [];

    if (images.length === 0) return ctx.reply("Please send at least one photo first.");

    const limit = canMarkToday(userId);
    if (!limit.allowed) return ctx.reply("⛔️ Daily limit reached. Come back tomorrow.");

    await ctx.reply("⏳ Marking your essay...");

    try {
      const imageContents = images.map(url => ({ type: 'image' as const, image: url }));

      const { text: result } = await generateText({
        model,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: `Topic: ${topic}\n\nMark this essay very strictly.` },
            ...imageContents
          ] as any
        }]
      });

      await ctx.reply(result || "✅ Marking completed.", { parse_mode: 'Markdown' });

      const today = new Date().toISOString().split('T')[0];
      const usage = dailyUsage.get(userId) || { date: today, count: 0 };
      usage.count += 1;
      dailyUsage.set(userId, usage);

      history.push({
        userId,
        username: ctx.from.username || ctx.from.first_name,
        topic,
        result,
        pages: images.length,
        date: new Date().toISOString()
      });

      fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));

      await ctx.reply("📝 Would you like to give feedback? Reply *yes* or *no*.");

    } catch (error) {
      console.error(error);
      await ctx.reply("❌ Failed to mark essay.");
    }

    userTopics.delete(userId);
    userImages.delete(userId);
    return;
  }

  // Feedback handling
  if (userFeedbackState.get(userId) === 'rating') {
    const rating = parseInt(text);
    if (rating >= 1 && rating <= 5) {
      // Save rating to the last essay
      const userHistory = history.filter(h => h.userId === userId);
      if (userHistory.length > 0) {
        userHistory[userHistory.length - 1].rating = rating;
        fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));
      }
      await ctx.reply("Thank you for your feedback! 🙏");
    } else {
      await ctx.reply("Please reply with a number between 1 and 5.");
      return;
    }
    userFeedbackState.delete(userId);
    return;
  }

  if (lower === 'yes' || lower === 'no') {
    if (lower === 'yes') {
      await ctx.reply("⭐️ Rate the bot from 1 to 5:");
      userFeedbackState.set(userId, 'rating');
    } else {
      await ctx.reply("Thank you! Send a new topic to start again.");
      userFeedbackState.delete(userId);
    }
    return;
  }

  // New Topic
  userTopics.set(userId, text);
  userImages.set(userId, []);
  const limit = canMarkToday(userId);
  await ctx.reply(`✅ Topic saved: "${text}"\n\nRemaining essays today: *${limit.remaining}*\n\nSend your essay photo(s). Type *done* when finished.`, { parse_mode: 'Markdown' });
});

// Photo Handler
bot.on('photo', async (ctx) => {
  const userId = ctx.from.id;
  if (!userImages.has(userId)) userImages.set(userId, []);

  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  const file = await ctx.telegram.getFile(photo.file_id);
  const imageUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

  userImages.get(userId)!.push(imageUrl);
  await ctx.reply(`📸 Page ${userImages.get(userId)!.length} received.\nSend more or type *done*.`);
});

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

bot.launch()
  .then(() => console.log('✅ Bot is running...'))
  .catch(console.error);

console.log('Bot started.');
