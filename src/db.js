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
    console.log('🗄️  PostgreSQL tables ready (conversations + facts + quiz_log + embeddings)')
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
    `SELECT role, content, timestamp FROM conversations ORDER BY timestamp DESC LIMIT $1`,
    [limit]
  )
  return result.rows.reverse()
}

async function loadAllHistory(limit = 300) {
  const result = await pool.query(
    `SELECT id, role, content, timestamp FROM conversations ORDER BY timestamp ASC LIMIT $1`,
    [limit]
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
  try {
    await pool.query('DELETE FROM facts')
    for (const fact of facts) {
      await pool.query(
        'INSERT INTO facts (content) VALUES ($1) ON CONFLICT (content) DO NOTHING',
        [fact]
      )
    }
  } catch (e) {
    console.error('🔴 saveFacts error:', e.message)
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
      `SELECT DISTINCT note_path FROM quiz_log
       WHERE tested_at > NOW() - ($1 || ' days')::INTERVAL`,
      [days]
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
       ON CONFLICT (source_id) DO UPDATE
       SET content = $1, embedding = $2::vector, updated_at = NOW()`,
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
       FROM embeddings
       WHERE embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
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

module.exports = {
  init, saveMessage, loadHistory, loadAllHistory, clearHistory,
  loadFacts, saveFacts,
  logQuizNote, getRecentlyTestedPaths,
  saveEmbedding, searchEmbeddings, getEmbeddingsCount
}