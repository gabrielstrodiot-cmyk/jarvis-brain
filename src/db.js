const { Pool } = require('pg')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false
})

async function init() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id        SERIAL PRIMARY KEY,
        role      VARCHAR(20)  NOT NULL,
        content   TEXT         NOT NULL,
        timestamp TIMESTAMPTZ  DEFAULT NOW()
      )
    `)
    console.log('🗄️ PostgreSQL conversations table ready')
  } catch (e) {
    console.error('🔴 PostgreSQL init error:', e.message)
    throw e
  }
}

async function saveMessage(role, content) {
  await pool.query(
    'INSERT INTO conversations (role, content) VALUES ($1, $2)',
    [role, content]
  )
}

async function loadHistory(limit = 20) {
  const result = await pool.query(
    `SELECT role, content, timestamp
     FROM conversations
     ORDER BY timestamp DESC
     LIMIT $1`,
    [limit]
  )
  return result.rows.reverse()
}

async function clearHistory() {
  await pool.query('DELETE FROM conversations')
}

module.exports = { init, saveMessage, loadHistory, clearHistory }