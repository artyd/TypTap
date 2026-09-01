// Postgres connection pool + one-shot idempotent migration runner.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Небольшой пул: нагрузка у тренажёра лёгкая, сохранения дебаунсятся на клиенте.
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  // Не роняем процесс из-за отвалившегося idle-соединения — pg восстановит пул.
  console.error('[db] idle client error:', err.message);
});

// Прогоняет все .sql из migrations/ по порядку имён. Файлы написаны
// идемпотентно (create table if not exists / create or replace), поэтому
// повторный запуск при каждом старте контейнера безопасен.
async function migrate() {
  const dir = path.join(__dirname, 'migrations');
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    await pool.query(sql);
    console.log(`[db] applied migration ${f}`);
  }
}

// Ждём, пока Postgres поднимется (docker compose: контейнер БД может стартовать
// на пару секунд позже api даже при depends_on healthcheck).
async function waitForDb(retries = 30, delayMs = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query('select 1');
      return;
    } catch (e) {
      console.log(`[db] waiting for postgres (${i + 1}/${retries}): ${e.message}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('database not reachable after retries');
}

module.exports = { pool, migrate, waitForDb };
