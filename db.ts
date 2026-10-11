import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

let pool: Pool | undefined;

function getPool(): Pool {
  if (!pool) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL must be set to connect to Postgres.');
    }
    pool = new Pool({ connectionString: databaseUrl });
  }
  return pool;
}

export interface EssayHistoryItem {
  id: string;
  topic: string;
  result: string;
  pages: number;
  createdAt: Date;
}

export interface BotStats {
  totalEssays: number;
  uniqueEssayUsers: number;
  totalUsers: number;
  totalFeedbacks: number;
  averageRating: number | null;
  outstandingCredits: number;
}

export interface UserCreditRow {
  telegramId: string;
  username: string | null;
  firstName: string | null;
  credits: number;
}

interface LegacyHistoryItem {
  userId: number;
  username?: string;
  topic: string;
  result: string;
  pages?: number;
  date: string;
  rating?: number;
}

export async function initializeDatabase(): Promise<void> {
  const database = getPool();
  await database.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      credits INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0),
      free_credits_granted BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await database.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS free_credits_granted BOOLEAN NOT NULL DEFAULT FALSE
  `);
  await database.query(`
    UPDATE users
    SET free_credits_granted = TRUE
    WHERE free_credits_granted = FALSE
      AND (username IS NOT NULL OR first_name IS NOT NULL)
  `);

  await database.query(`
    CREATE TABLE IF NOT EXISTS essays (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(telegram_id),
      topic TEXT NOT NULL,
      result TEXT NOT NULL,
      pages INTEGER NOT NULL CHECK (pages > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await database.query(`
    CREATE TABLE IF NOT EXISTS feedback (
      essay_id BIGINT PRIMARY KEY REFERENCES essays(id) ON DELETE CASCADE,
      rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await database.query(`
    CREATE TABLE IF NOT EXISTS app_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await migrateLegacyHistory();
}

export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

export async function upsertUser(
  telegramId: number,
  username?: string,
  firstName?: string
): Promise<void> {
  await getPool().query(
    `INSERT INTO users (telegram_id, username, first_name, credits, free_credits_granted)
     VALUES ($1, $2, $3, 5, TRUE)
     ON CONFLICT (telegram_id) DO UPDATE SET
       credits = users.credits + CASE WHEN users.free_credits_granted THEN 0 ELSE 5 END,
       free_credits_granted = TRUE,
       username = COALESCE(EXCLUDED.username, users.username),
       first_name = COALESCE(EXCLUDED.first_name, users.first_name),
       updated_at = NOW()`,
    [telegramId, username || null, firstName || null]
  );
}

export async function getUserCredits(telegramId: number): Promise<number> {
  const result = await getPool().query<{ credits: number }>(
    'SELECT credits FROM users WHERE telegram_id = $1',
    [telegramId]
  );
  return result.rows[0]?.credits ?? 0;
}

export async function findUserIdByUsername(username: string): Promise<number | null> {
  const normalizedUsername = username.replace(/^@/, '');
  const result = await getPool().query<{ telegram_id: string }>(
    `SELECT telegram_id
     FROM users
     WHERE LOWER(username) = LOWER($1)
     LIMIT 1`,
    [normalizedUsername]
  );
  if (!result.rows[0]) return null;

  const telegramId = Number(result.rows[0].telegram_id);
  if (!Number.isSafeInteger(telegramId)) {
    throw new Error(`Telegram ID for username "${normalizedUsername}" exceeds safe integer range.`);
  }
  return telegramId;
}

export async function addCredits(telegramId: number, units: number): Promise<number> {
  const result = await getPool().query<{ credits: number }>(
    `INSERT INTO users (telegram_id, credits)
     VALUES ($1, $2)
     ON CONFLICT (telegram_id) DO UPDATE SET
       credits = users.credits + EXCLUDED.credits,
       updated_at = NOW()
     RETURNING credits`,
    [telegramId, units]
  );
  return result.rows[0].credits;
}

export async function createEssayAndCharge(
  telegramId: number,
  topic: string,
  resultText: string,
  pages: number
): Promise<string | null> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    const charge = await client.query(
      `UPDATE users
       SET credits = credits - 1, updated_at = NOW()
       WHERE telegram_id = $1 AND credits > 0`,
      [telegramId]
    );

    if (charge.rowCount !== 1) {
      await client.query('ROLLBACK');
      return null;
    }

    const essay = await client.query<{ id: string }>(
      `INSERT INTO essays (user_id, topic, result, pages)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [telegramId, topic, resultText, pages]
    );

    await client.query('COMMIT');
    return essay.rows[0].id;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Failed to roll back essay/credit transaction:', rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function getUserHistory(telegramId: number): Promise<EssayHistoryItem[]> {
  const result = await getPool().query<{
    id: string;
    topic: string;
    result: string;
    pages: number;
    created_at: Date;
  }>(
    `SELECT id, topic, result, pages, created_at
     FROM essays
     WHERE user_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT 10`,
    [telegramId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    topic: row.topic,
    result: row.result,
    pages: row.pages,
    createdAt: row.created_at
  }));
}

export async function getLatestEssayId(telegramId: number): Promise<string | null> {
  const result = await getPool().query<{ id: string }>(
    `SELECT id FROM essays
     WHERE user_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [telegramId]
  );
  return result.rows[0]?.id ?? null;
}

export async function saveFeedback(essayId: string, rating: number): Promise<void> {
  await getPool().query(
    `INSERT INTO feedback (essay_id, rating)
     VALUES ($1, $2)
     ON CONFLICT (essay_id) DO UPDATE SET
       rating = EXCLUDED.rating,
       created_at = NOW()`,
    [essayId, rating]
  );
}

export async function getBotStats(): Promise<BotStats> {
  const result = await getPool().query<{
    total_essays: string;
    unique_essay_users: string;
    total_users: string;
    total_feedbacks: string;
    average_rating: string | null;
    outstanding_credits: string;
  }>(`
    SELECT
      (SELECT COUNT(*) FROM essays) AS total_essays,
      (SELECT COUNT(DISTINCT user_id) FROM essays) AS unique_essay_users,
      (SELECT COUNT(*) FROM users) AS total_users,
      (SELECT COUNT(*) FROM feedback) AS total_feedbacks,
      (SELECT AVG(rating)::text FROM feedback) AS average_rating,
      (SELECT COALESCE(SUM(credits), 0) FROM users) AS outstanding_credits
  `);
  const row = result.rows[0];

  return {
    totalEssays: Number(row.total_essays),
    uniqueEssayUsers: Number(row.unique_essay_users),
    totalUsers: Number(row.total_users),
    totalFeedbacks: Number(row.total_feedbacks),
    averageRating: row.average_rating === null ? null : Number(row.average_rating),
    outstandingCredits: Number(row.outstanding_credits)
  };
}

export async function getUsersWithCredits(): Promise<UserCreditRow[]> {
  const result = await getPool().query<{
    telegram_id: string;
    username: string | null;
    first_name: string | null;
    credits: number;
  }>(
    `SELECT telegram_id, username, first_name, credits
     FROM users
     ORDER BY telegram_id`
  );
  return result.rows.map((row) => ({
    telegramId: row.telegram_id,
    username: row.username,
    firstName: row.first_name,
    credits: row.credits
  }));
}

async function migrateLegacyHistory(): Promise<void> {
  const migrationName = 'legacy-history-json-v1';
  const client = await getPool().connect();

  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [migrationName]);

    const migration = await client.query(
      'SELECT 1 FROM app_migrations WHERE name = $1',
      [migrationName]
    );
    if (migration.rowCount) {
      await client.query('COMMIT');
      return;
    }

    const historyFile = path.join(process.cwd(), 'data', 'history.json');
    if (!fs.existsSync(historyFile)) {
      await client.query('ROLLBACK');
      return;
    }

    const data: unknown = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    if (!Array.isArray(data)) {
      throw new Error('Legacy data/history.json must contain a JSON array.');
    }

    for (const [index, rawItem] of data.entries()) {
      const item = validateLegacyHistoryItem(rawItem, index);
      await client.query(
        `INSERT INTO users (telegram_id, username, free_credits_granted)
         VALUES ($1, $2, TRUE)
         ON CONFLICT (telegram_id) DO UPDATE SET
           username = COALESCE(EXCLUDED.username, users.username),
           free_credits_granted = TRUE,
           updated_at = NOW()`,
        [item.userId, item.username || null]
      );

      const essay = await client.query<{ id: string }>(
        `INSERT INTO essays (user_id, topic, result, pages, created_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [item.userId, item.topic, item.result, item.pages ?? 1, item.date]
      );

      if (item.rating !== undefined) {
        await client.query(
          `INSERT INTO feedback (essay_id, rating, created_at)
           VALUES ($1, $2, $3)`,
          [essay.rows[0].id, item.rating, item.date]
        );
      }
    }

    await client.query('INSERT INTO app_migrations (name) VALUES ($1)', [migrationName]);
    await client.query('COMMIT');
    console.log(`Imported ${data.length} legacy essay record(s) from data/history.json.`);
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Failed to roll back legacy history import:', rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

function validateLegacyHistoryItem(value: unknown, index: number): LegacyHistoryItem {
  if (!value || typeof value !== 'object') {
    throw new Error(`Legacy history record ${index + 1} is not an object.`);
  }
  const item = value as Partial<LegacyHistoryItem>;
  const date = typeof item.date === 'string' ? new Date(item.date) : new Date(NaN);
  if (
    typeof item.userId !== 'number' ||
    !Number.isSafeInteger(item.userId) ||
    (item.userId ?? 0) <= 0 ||
    typeof item.topic !== 'string' ||
    typeof item.result !== 'string' ||
    Number.isNaN(date.getTime()) ||
    (item.pages !== undefined && (!Number.isInteger(item.pages) || item.pages < 1)) ||
    (item.rating !== undefined &&
      (!Number.isInteger(item.rating) || item.rating < 1 || item.rating > 5))
  ) {
    throw new Error(`Legacy history record ${index + 1} has invalid fields.`);
  }

  return {
    userId: item.userId,
    username: item.username,
    topic: item.topic,
    result: item.result,
    pages: item.pages,
    date: date.toISOString(),
    rating: item.rating
  };
}
