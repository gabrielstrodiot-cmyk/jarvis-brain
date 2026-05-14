const OpenAI = require('openai')
const { Client } = require('@notionhq/client')
const config = require('./config')
const db = require('./db')

const openai = new OpenAI({ apiKey: config.openai.apiKey })
const notion = new Client({ auth: config.notion.token })

const JOURNAL_PAGE_ID = '347a16a5dea281a0b479cb00f2f6d772'
const SIMILARITY_THRESHOLD = 0.72

async function createEmbedding(text) {
  const response = await openai.embeddings.create({
    model: 'text-embedding-ada-002',
    input: text.slice(0, 8000)
  })
  return response.data[0].embedding
}

async function searchSimilar(query, limit = 5) {
  try {
    const count = await db.getEmbeddingsCount()
    if (count === 0) return []
    const queryEmbedding = await createEmbedding(query)
    const results = await db.searchEmbeddings(queryEmbedding, limit)
    return results.filter(r => parseFloat(r.similarity) > SIMILARITY_THRESHOLD)
  } catch (e) {
    console.error('🔴 searchSimilar error:', e.message)
    return []
  }
}

function extractTextFromBlocks(blocks) {
  const lines = []
  for (const block of blocks) {
    const type = block.type
    if (!block[type]) continue
    const richText = block[type].rich_text || []
    const text = richText.map(t => t.plain_text).join('')
    if (text.trim()) lines.push(text)
  }
  return lines.join('\n')
}

async function getPageBlocks(pageId) {
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

function chunkText(text, maxChars = 1200) {
  const paragraphs = text.split('\n\n').filter(p => p.trim())
  const chunks = []
  let current = ''
  for (const para of paragraphs) {
    if ((current + '\n\n' + para).length > maxChars && current) {
      chunks.push(current.trim())
      current = para
    } else {
      current = current ? current + '\n\n' + para : para
    }
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks.length > 0 ? chunks : [text.slice(0, maxChars)]
}

async function indexNotionJournal() {
  console.log('📚 Indexation journal Notion...')
  let indexed = 0, skipped = 0, errors = 0

  try {
    const blocks = await getPageBlocks(JOURNAL_PAGE_ID)
    const childPages = blocks.filter(b => b.type === 'child_page')

    if (childPages.length > 0) {
      console.log(`📄 ${childPages.length} entrées journal trouvées`)
      for (const page of childPages) {
        try {
          const title = page.child_page?.title || 'Sans titre'
          const pageBlocks = await getPageBlocks(page.id)
          const content = extractTextFromBlocks(pageBlocks)
          if (!content.trim() || content.length < 30) { skipped++; continue }

          const chunks = chunkText(content)
          for (let i = 0; i < chunks.length; i++) {
            const chunkContent = `Journal — ${title}\n\n${chunks[i]}`
            const embedding = await createEmbedding(chunkContent)
            await db.saveEmbedding(chunkContent, embedding, 'notion_journal', `journal_${page.id}_${i}`)
            indexed++
            await new Promise(r => setTimeout(r, 150))
          }
        } catch (e) {
          console.error(`🔴 Erreur page ${page.id}:`, e.message)
          errors++
        }
      }
    } else {
      // Page plate sans sous-pages — indexer directement les blocs
      const content = extractTextFromBlocks(blocks)
      if (content.trim() && content.length > 30) {
        const chunks = chunkText(content, 1000)
        for (let i = 0; i < chunks.length; i++) {
          const chunkContent = `Journal Gabriel\n\n${chunks[i]}`
          const embedding = await createEmbedding(chunkContent)
          await db.saveEmbedding(chunkContent, embedding, 'notion_journal', `journal_flat_${i}`)
          indexed++
          await new Promise(r => setTimeout(r, 150))
        }
      }
    }
  } catch (e) {
    console.error('🔴 indexNotionJournal error:', e.message)
  }

  const result = { indexed, skipped, errors }
  console.log('✅ Journal indexé:', result)
  return result
}

async function indexConversations() {
  console.log('💬 Indexation conversations...')
  let indexed = 0

  try {
    const messages = await db.loadAllHistory(300)
    if (messages.length < 5) {
      console.log('⚠️  Pas assez de conversations')
      return { indexed: 0 }
    }

    const chunkSize = 10
    for (let i = 0; i < messages.length; i += chunkSize) {
      const chunk = messages.slice(i, i + chunkSize)
      const content = chunk
        .map(m => `${m.role === 'user' ? 'Gabriel' : 'Jarvis'}: ${m.content}`)
        .join('\n')
      if (content.length < 80) continue

      const sourceId = `conv_${chunk[0].id}_${chunk[chunk.length - 1].id}`
      const embedding = await createEmbedding(content)
      await db.saveEmbedding(content, embedding, 'conversation', sourceId)
      indexed++
      await new Promise(r => setTimeout(r, 150))
    }
  } catch (e) {
    console.error('🔴 indexConversations error:', e.message)
  }

  const result = { indexed }
  console.log('✅ Conversations indexées:', result)
  return result
}

module.exports = { searchSimilar, indexNotionJournal, indexConversations }