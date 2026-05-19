const { Pool } = require('pg')
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false
})

async function init() {
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id        SERIAL PRIMARY KEY,
        role      VARCHAR(20) NOT NULL,
        content   TEXT        NOT NULL,
        timestamp TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS facts (
        id         SERIAL PRIMARY KEY,
        content    TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS quiz_log (
        id        SERIAL PRIMARY KEY,
        note_path TEXT        NOT NULL,
        tested_at TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS embeddings (
        id         SERIAL       PRIMARY KEY,
        content    TEXT         NOT NULL,
        embedding  vector(1536),
        source     VARCHAR(50)  NOT NULL,
        source_id  TEXT         UNIQUE,
        created_at TIMESTAMPTZ  DEFAULT NOW(),
        updated_at TIMESTAMPTZ  DEFAULT NOW()
      )
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS draft_notes (
        id                  SERIAL      PRIMARY KEY,
        subject             TEXT        NOT NULL,
        content             TEXT        NOT NULL,
        obsidian_path       TEXT,
        status              VARCHAR(30) DEFAULT 'awaiting_validation',
        telegram_message_id BIGINT,
        revision_count      INTEGER     DEFAULT 0,
        revision_feedback   TEXT,
        created_at          TIMESTAMPTZ DEFAULT NOW(),
        updated_at          TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    console.log('🗄️  PostgreSQL tables ready (conversations + facts + quiz_log + embeddings + draft_notes)')
  } catch (e) {
    console.error('🔴 PostgreSQL init error:', e.message)
    throw e
  }
}

async function saveMessage(role, content) {
  await pool.query('INSERT INTO conversations (role, content) VALUES ($1, $2)', [role, content])
}

async function loadHistory(limit = 20) {
  const result = await pool.query(
    `SELECT role, content, timestamp FROM conversations ORDER BY timestamp DESC LIMIT $1`, [limit]
  )
  return result.rows.reverse()
}

async function loadAllHistory(limit = 300) {
  const result = await pool.query(
    `SELECT id, role, content, timestamp FROM conversations ORDER BY timestamp ASC LIMIT $1`, [limit]
  )
  return result.rows
}

async function clearHistory() {
  await pool.query('DELETE FROM conversations')
}

async function loadFacts() {
  try {
    const result = await pool.query('SELECT content FROM facts ORDER BY created_at ASC')
    return result.rows.map(r => r.content)
  } catch (e) {
    console.error('🔴 loadFacts error:', e.message)
    return []
  }
}

async function saveFacts(facts) {
  // Batch transactionnel — 3 requêtes au lieu de N+1 séquentielles
  // 35 facts : 6 000ms → ~50ms
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM facts')
    if (facts.length > 0) {
      const placeholders = facts.map((_, i) => `($${i + 1})`).join(', ')
      await client.query(
        `INSERT INTO facts (content) VALUES ${placeholders} ON CONFLICT (content) DO NOTHING`,
        facts
      )
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('🔴 saveFacts error:', e.message)
  } finally {
    client.release()
  }
}

async function logQuizNote(notePath) {
  try {
    await pool.query('INSERT INTO quiz_log (note_path) VALUES ($1)', [notePath])
  } catch (e) {
    console.error('🔴 logQuizNote error:', e.message)
  }
}

async function getRecentlyTestedPaths(days = 7) {
  try {
    const result = await pool.query(
      `SELECT DISTINCT note_path FROM quiz_log WHERE tested_at > NOW() - ($1 || ' days')::INTERVAL`, [days]
    )
    return result.rows.map(r => r.note_path)
  } catch (e) {
    console.error('🔴 getRecentlyTestedPaths error:', e.message)
    return []
  }
}

async function saveEmbedding(content, embedding, source, sourceId) {
  try {
    await pool.query(
      `INSERT INTO embeddings (content, embedding, source, source_id, updated_at)
       VALUES ($1, $2::vector, $3, $4, NOW())
       ON CONFLICT (source_id) DO UPDATE SET content = $1, embedding = $2::vector, updated_at = NOW()`,
      [content, JSON.stringify(embedding), source, sourceId]
    )
  } catch (e) {
    console.error('🔴 saveEmbedding error:', e.message)
  }
}

async function searchEmbeddings(queryEmbedding, limit = 5) {
  try {
    const result = await pool.query(
      `SELECT content, source, 1 - (embedding <=> $1::vector) AS similarity
       FROM embeddings WHERE embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector LIMIT $2`,
      [JSON.stringify(queryEmbedding), limit]
    )
    return result.rows
  } catch (e) {
    console.error('🔴 searchEmbeddings error:', e.message)
    return []
  }
}

async function getEmbeddingsCount() {
  try {
    const result = await pool.query('SELECT COUNT(*) FROM embeddings')
    return parseInt(result.rows[0].count)
  } catch (e) {
    return 0
  }
}

async function saveDraft(subject, content, obsidianPath) {
  const result = await pool.query(
    `INSERT INTO draft_notes (subject, content, obsidian_path) VALUES ($1, $2, $3) RETURNING id`,
    [subject, content, obsidianPath]
  )
  return result.rows[0].id
}

async function getDraft(id) {
  const result = await pool.query('SELECT * FROM draft_notes WHERE id = $1', [id])
  return result.rows[0] || null
}

async function updateDraft(id, fields) {
  const { content, status, telegramMessageId, revisionFeedback, revisionCount } = fields
  await pool.query(
    `UPDATE draft_notes SET
      content             = COALESCE($2, content),
      status              = COALESCE($3, status),
      telegram_message_id = COALESCE($4, telegram_message_id),
      revision_feedback   = COALESCE($5, revision_feedback),
      revision_count      = COALESCE($6, revision_count),
      updated_at          = NOW()
     WHERE id = $1`,
    [id, content ?? null, status ?? null, telegramMessageId ?? null, revisionFeedback ?? null, revisionCount ?? null]
  )
}

async function getPendingDrafts() {
  const result = await pool.query(
    `SELECT * FROM draft_notes WHERE status = 'awaiting_validation' ORDER BY created_at ASC`
  )
  return result.rows
}

module.exports = {
  init, saveMessage, loadHistory, loadAllHistory, clearHistory,
  loadFacts, saveFacts,
  logQuizNote, getRecentlyTestedPaths,
  saveEmbedding, searchEmbeddings, getEmbeddingsCount,
  saveDraft, getDraft, updateDraft, getPendingDrafts,
}
