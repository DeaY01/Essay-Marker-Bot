import { Telegraf } from 'telegraf';
import { generateText } from 'ai';
import { xai } from '@ai-sdk/xai';
import dotenv from 'dotenv';
import {
  addCredits,
  closeDatabase,
  createEssayAndCharge,
  findUserIdByUsername,
  getBotStats,
  getLatestEssayId,
  getUserCredits,
  getUserHistory,
  getUsersWithCredits,
  initializeDatabase,
  saveFeedback,
  upsertUser
} from './db';

dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  throw new Error('TELEGRAM_BOT_TOKEN must be set.');
}

const bot = new Telegraf(token);
const model = xai('grok-4.3');
const ADMIN_ID = 1693748981;

const userTopics = new Map<number, string>();
const userImages = new Map<number, string[]>();
const userFeedbackState = new Map<number, string>();
const userLatestEssay = new Map<number, string>();

const SYSTEM_PROMPT = `You are a **very strict** WAEC/NECO examiner.
Use the official COEM rubric:
- Content (10 marks)
- Organisation (10 marks)
- Expression (20 marks)
- Mechanical Accuracy (10 marks)
**Total: 50 marks**

Rules:
- Be realistic and strict. Excellent essays rarely exceed 42/50.
- Ideal length is 400-450 words. Penalize scores heavily if much shorter.
- Consider how well the essay answers the given topic.`;

bot.use(async (ctx, next) => {
  if (ctx.from) {
    await upsertUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  }
  await next();
});

bot.start((ctx) =>
  ctx.reply(
    `👋 *Welcome to EssayMaker Bot!*\n\n` +
      `1. Send topic\n` +
      `2. Send photos\n` +
      `3. Type *done*`,
    { parse_mode: 'Markdown' }
  )
);

bot.command('subscribe', (ctx) =>
  ctx.reply(
    `💳 Buy Credits

Price: ₦20 per essay

Minimum purchase: 100 units = ₦2,000

Bank Details:

Bank: KUDA

Account Name: AJIBOYE OLADAPO JACOB

Account Number: 2009378182

After payment:

1. DM the payment screenshot 08030730936/USER GROUP

2. Include your Telegram ID or username

- I will credit your account after confirmation.`
  )
);

bot.command('history', async (ctx) => {
  const myHistory = await getUserHistory(ctx.from.id);
  if (myHistory.length === 0) {
    return ctx.reply('You have no previous markings yet.');
  }

  let message = '📜 Your Marking History:\n\n';
  myHistory.forEach((essay, index) => {
    const topic = essay.topic.length > 60 ? `${essay.topic.substring(0, 60)}...` : essay.topic;
    message += `${index + 1}. ${essay.createdAt.toLocaleDateString()} — ${topic}\n`;
  });
  return ctx.reply(message);
});

bot.command('credit', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Admin only.');

  const args = ctx.message.text.trim().split(/\s+/);
  if (args.length !== 3 || !/^\d+$/.test(args[2])) {
    return ctx.reply('Usage: /credit <telegram_id|@username> <units>');
  }

  const target = args[1];
  const units = Number(args[2]);
  if (!Number.isSafeInteger(units) || units <= 0) {
    return ctx.reply('Units must be a positive whole number.');
  }

  let telegramId: number;
  if (/^\d+$/.test(target)) {
    telegramId = Number(target);
    if (!Number.isSafeInteger(telegramId) || telegramId <= 0) {
      return ctx.reply('Telegram ID must be a positive whole number.');
    }
  } else {
    const username = target.replace(/^@/, '');
    if (!/^[a-zA-Z0-9_]{1,32}$/.test(username)) {
      return ctx.reply('Usage: /credit <telegram_id|@username> <units>');
    }
    const matchedTelegramId = await findUserIdByUsername(username);
    if (matchedTelegramId === null) {
      return ctx.reply('User not found. Ask them to use the bot at least once first.');
    }
    telegramId = matchedTelegramId;
  }

  const balance = await addCredits(telegramId, units);
  return ctx.reply(
    `✅ Added ${units} credit(s) to ${target} (ID: ${telegramId}). New balance: ${balance}.`
  );
});

bot.command('users', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Admin only.');

  const users = await getUsersWithCredits();
  if (users.length === 0) return ctx.reply('No users found.');

  let message = '';
  for (const user of users) {
    const line =
      `Username: ${user.username ? `@${user.username}` : 'N/A'} | ` +
      `Telegram ID: ${user.telegramId} | Credits: ${user.credits}\n`;

    if (message.length + line.length > 3500) {
      await ctx.reply(message);
      message = '';
    }
    message += line;
  }
  if (message) await ctx.reply(message);
});

bot.command('stats', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Admin only.');

  const stats = await getBotStats();
  let message = `📊 Admin Statistics

Total Essays Marked: ${stats.totalEssays}
Unique Essay Users: ${stats.uniqueEssayUsers}
Total Users: ${stats.totalUsers}
Total Feedbacks: ${stats.totalFeedbacks}
Outstanding Credits: ${stats.outstandingCredits}`;
  if (stats.averageRating !== null) {
    message += `\nAverage Rating: ${stats.averageRating.toFixed(1)} / 5`;
  }

  return ctx.reply(message);
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();
  const lower = text.toLowerCase();

  if (lower.startsWith('/')) return;

  if (lower === 'done') {
    const topic = userTopics.get(userId) || 'No topic';
    const images = userImages.get(userId) || [];

    if (images.length === 0) return ctx.reply('Please send at least one photo first.');

    if ((await getUserCredits(userId)) < 1) {
      return ctx.reply(
        'You have used your 5 free units and have no credits remaining. Use /subscribe to buy more.'
      );
    }

    await ctx.reply('⏳ Marking your essay...');

    try {
      const imageContents = images.map((url) => ({ type: 'image' as const, image: url }));

      const { text: result } = await generateText({
        model,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: `Topic: ${topic}\n\nMark this essay very strictly.` },
              ...imageContents
            ] as any
          }
        ]
      });

      const savedEssayId = await createEssayAndCharge(
        userId,
        topic,
        result || '✅ Marking completed.',
        images.length
      );
      if (!savedEssayId) {
        await ctx.reply(
          'You have used your 5 free units and have no credits remaining. Use /subscribe to buy more.'
        );
        return;
      }

      await ctx.reply(result || '✅ Marking completed.', { parse_mode: 'Markdown' });
      userLatestEssay.set(userId, savedEssayId);

      await ctx.reply('📝 Would you like to give feedback? Reply *yes* or *no*.');
    } catch (error) {
      console.error('Failed to mark and save essay:', error);
      await ctx.reply('❌ Failed to mark essay.');
    }

    userTopics.delete(userId);
    userImages.delete(userId);
    return;
  }

  if (userFeedbackState.get(userId) === 'rating') {
    const rating = Number.parseInt(text, 10);
    if (rating >= 1 && rating <= 5) {
      const essayId = userLatestEssay.get(userId);
      if (essayId) {
        await saveFeedback(essayId, rating);
        userLatestEssay.delete(userId);
      }
      await ctx.reply('Thank you for your feedback! 🙏');
    } else {
      await ctx.reply('Please reply with a number between 1 and 5.');
      return;
    }
    userFeedbackState.delete(userId);
    return;
  }

  if (lower === 'yes' || lower === 'no') {
    if (lower === 'yes') {
      if (!userLatestEssay.has(userId)) {
        const latestEssayId = await getLatestEssayId(userId);
        if (latestEssayId) userLatestEssay.set(userId, latestEssayId);
      }
      await ctx.reply('⭐️ Rate the bot from 1 to 5:');
      userFeedbackState.set(userId, 'rating');
    } else {
      await ctx.reply('Thank you! Send a new topic to start again.');
      userFeedbackState.delete(userId);
      userLatestEssay.delete(userId);
    }
    return;
  }

  userTopics.set(userId, text);
  userImages.set(userId, []);
  const credits = await getUserCredits(userId);
  await ctx.reply(
    `✅ Topic saved: "${text}"\n\nCredits available: *${credits}*\n\nSend your essay photo(s). Type *done* when finished.`,
    { parse_mode: 'Markdown' }
  );
});

bot.on('photo', async (ctx) => {
  const userId = ctx.from.id;
  if (!userImages.has(userId)) userImages.set(userId, []);

  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  const file = await ctx.telegram.getFile(photo.file_id);
  const imageUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;

  userImages.get(userId)!.push(imageUrl);
  await ctx.reply(`📸 Page ${userImages.get(userId)!.length} received.\nSend more or type *done*.`);
});

bot.catch(async (error, ctx) => {
  console.error(`Unhandled error while processing Telegram update ${ctx.update.update_id}:`, error);
  try {
    await ctx.reply('❌ Something went wrong. Please try again.');
  } catch (replyError) {
    console.error('Failed to notify user about bot error:', replyError);
  }
});

async function startBot(): Promise<void> {
  await initializeDatabase();
  await bot.launch();
  console.log('✅ Bot is running...');
}

startBot().catch(async (error) => {
  console.error('Failed to start the bot:', error);
  await closeDatabase();
  process.exitCode = 1;
});

process.once('SIGINT', () => {
  bot.stop('SIGINT');
  void closeDatabase().catch((error) => console.error('Failed to close database:', error));
});
process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
  void closeDatabase().catch((error) => console.error('Failed to close database:', error));
});
