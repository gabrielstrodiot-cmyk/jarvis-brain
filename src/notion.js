const config = require('./config')

async function notionRequest(method, endpoint, body = null) {
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${config.notion.token}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
  }
  if (body) options.body = JSON.stringify(body)
  const res = await fetch(`https://api.notion.com/v1${endpoint}`, options)
  if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`)
  return res.json()
}

function contentToBlocks(content) {
  const lines = content.split('\n').filter(l => l.trim())
  const blocks = []
  for (const line of lines) {
    if (line.startsWith('# ')) blocks.push({ object: 'block', type: 'heading_1', heading_1: { rich_text: [{ text: { content: line.slice(2) } }] } })
    else if (line.startsWith('## ')) blocks.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: [{ text: { content: line.slice(3) } }] } })
    else if (line.startsWith('### ')) blocks.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: [{ text: { content: line.slice(4) } }] } })
    else if (line.startsWith('- ') || line.startsWith('• ')) blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ text: { content: line.slice(2) } }] } })
    else if (/^\d+\./.test(line)) blocks.push({ object: 'block', type: 'numbered_list_item', numbered_list_item: { rich_text: [{ text: { content: line.replace(/^\d+\.\s*/, '') } }] } })
    else if (line.startsWith('> ')) blocks.push({ object: 'block', type: 'quote', quote: { rich_text: [{ text: { content: line.slice(2) } }] } })
    else if (line.startsWith('---')) blocks.push({ object: 'block', type: 'divider', divider: {} })
    else blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content: line } }] } })
  }
  return blocks.slice(0, 100)
}

async function search(query) {
  const data = await notionRequest('POST', '/search', { query, page_size: 5 })
  return data.results || []
}

async function readPage(pageId) {
  const page = await notionRequest('GET', `/pages/${pageId}`)
  const blocks = await notionRequest('GET', `/blocks/${pageId}/children?page_size=100`)
  const textContent = (blocks.results || []).map(block => {
    const type = block.type
    const richText = block[type]?.rich_text || []
    return richText.map(t => t.plain_text).join('')
  }).filter(Boolean).join('\n')
  return { page, textContent }
}

async function appendToPage(pageId, content) {
  return notionRequest('PATCH', `/blocks/${pageId}/children`, { children: contentToBlocks(content) })
}

async function createPage(title, content) {
  const results = await search('')
  const firstPage = results.find(r => r.object === 'page' || r.object === 'database')
  return notionRequest('POST', '/pages', {
    parent: firstPage ? { page_id: firstPage.id } : { type: 'workspace', workspace: true },
    properties: { title: { title: [{ text: { content: title } }] } },
    children: contentToBlocks(content),
  })
}

async function loadFacts() {
  try {
    const page = await readPage(config.notion.memoryPageId)
    return page.textContent.split('\n')
      .filter(l => l.trim().startsWith('- ') && l.trim().length > 2)
      .map(l => l.trim().slice(2).trim())
      .filter(f => f.length > 0)
  } catch (e) { return [] }
}

async function saveFacts(facts) {
  try {
    const date = new Date().toLocaleDateString('fr-FR')
    const content = `## Facts\n\n${facts.map(f => `- ${f}`).join('\n')}\n\n---\n→ ${date}`
    await appendToPage(config.notion.memoryPageId, content)
  } catch (e) { console.error('saveFacts:', e.message) }
}

module.exports = { search, readPage, appendToPage, createPage, loadFacts, saveFacts }
