const OpenAI = require('openai')
const config = require('./config')
const db = require('./db')
const { Client } = require('@notionhq/client')

const openai = new OpenAI({ apiKey: config.openai.apiKey })
const notion = new Client({ auth: config.notion.token })
const JOURNAL_PAGE_ID = config.notion.checkinPageId

// ─── CORE ────────────────────────────────────────────────────────────────────

async function generateEmbedding(text) {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 8000)
  if (!clean || clean.length < 10) return null
  const response = await openai.embeddings.create({
    model: 'text-embedding-ada-002',
    input: clean
  })
  return response.data[0].embedding
}

async function searchSimilar(query, limit = 5) {
  try {
    const embedding = await generateEmbedding(query)
    if (!embedding) return []
    const results = await db.searchEmbeddings(embedding, limit)
    return results.filter(r => r.similarity > 0.72)
  } catch (e) {
    console.error('🔴 searchSimilar:', e.message)
    return []
  }
}

// ─── INDEX CONVERSATIONS ──────────────────────────────────────────────────────

async function indexConversations(limit = 300) {
  const allConvs = await db.loadAllHistory(limit)
  const toIndex = allConvs.filter(c => c.role === 'user' && c.content.length > 40)

  let indexed = 0
  for (const conv of toIndex) {
    const crypto = require('crypto')
const sourceId = 'conv_' + crypto.createHash('md5').update(conv.content).digest('hex').slice(0, 16)
    try {
      const embedding = await generateEmbedding(conv.content)
      if (!embedding) continue
      await db.saveEmbedding(conv.content, embedding, 'conversation', sourceId)
      indexed++
      // Éviter rate limit OpenAI
      if (indexed % 20 === 0) await sleep(1000)
    } catch (e) {
      console.error(`🔴 embed conv_${conv.id}:`, e.message)
    }
  }
  console.log(`✅ Conversations indexées : ${indexed}`)
  return indexed
}

// ─── INDEX JOURNAL NOTION ─────────────────────────────────────────────────────

async function fetchNotionBlocks(pageId) {
  const blocks = []
  let cursor = undefined
  do {
    const response = await notion.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
      page_size: 100
    })
    blocks.push(...response.results)
    cursor = response.has_more ? response.next_cursor : undefined
  } while (cursor)
  return blocks
}

function extractJournalEntries(blocks) {
  const entries = []
  let currentDate = null
  let currentLines = []

  for (const block of blocks) {
    const type = block.type
    const richText = block[type]?.rich_text || []
    const text = richText.map(t => t.plain_text).join('').trim()

    if (!text) {
      if (currentLines.length > 0) {
        entries.push({ date: currentDate, content: currentLines.join('\n') })
        currentLines = []
        currentDate = null
      }
      continue
    }

    if (type === 'heading_1' || type === 'heading_2' || type === 'heading_3') {
      if (currentLines.length > 0) {
        entries.push({ date: currentDate, content: currentLines.join('\n') })
        currentLines = []
      }
      currentDate = text
    } else {
      currentLines.push(text)
    }
  }

  if (currentLines.length > 0) {
    entries.push({ date: currentDate, content: currentLines.join('\n') })
  }

  return entries
}

async function indexNotionJournal() {
  try {
    const blocks = await fetchNotionBlocks(JOURNAL_PAGE_ID)
    const entries = extractJournalEntries(blocks)

    let indexed = 0
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      if (entry.content.length < 40) continue

      const fullText = entry.date
        ? `[Journal — ${entry.date}]\n${entry.content}`
        : entry.content

      const sourceId = `journal_${JOURNAL_PAGE_ID}_${i}`

      try {
        const embedding = await generateEmbedding(fullText)
        if (!embedding) continue
        await db.saveEmbedding(fullText, embedding, 'journal', sourceId)
        indexed++
        if (indexed % 10 === 0) await sleep(500)
      } catch (e) {
        console.error(`🔴 embed journal_${i}:`, e.message)
      }
    }

    console.log(`✅ Journal indexé : ${indexed} entrées`)
    return indexed
  } catch (e) {
    console.error('🔴 indexNotionJournal:', e.message)
    return 0
  }
}

// ─── FULL INDEX ────────────────────────────────────────────────────────────────

async function indexAll() {
  console.log('🔄 RAG index démarré...')
  const conv = await indexConversations()
  const journal = await indexNotionJournal()
  const total = conv + journal
  console.log(`✅ RAG index terminé : ${conv} conv + ${journal} journal = ${total} total`)
  return { conversations: conv, journal, total }
}

// ─── UTILS ────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function indexSingleNote(content, sourceId) {
  try {
    const embedding = await generateEmbedding(content)
    if (!embedding) return
    await db.saveEmbedding(content, embedding, 'obsidian', sourceId)
    console.log(`✅ Note indexée : ${sourceId}`)
  } catch (e) {
    console.error('🔴 indexSingleNote:', e.message)
  }
}

module.exports = { generateEmbedding, searchSimilar, indexConversations, indexNotionJournal, indexAll, indexSingleNote }