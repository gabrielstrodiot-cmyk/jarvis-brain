const notion = require('./notion')
const memory = require('./memory')

async function processReply(reply) {
  let text = reply
  const sideEffects = {}

  const rememberMatches = [...text.matchAll(/\[REMEMBER:\s*(.+?)\]/gi)]
  for (const match of rememberMatches) {
    memory.addFact(match[1].trim())
    text = text.replace(match[0], '')
  }

  const notionCreateMatch = text.match(/\[NOTION_CREATE:\s*(.+?)\s*\|\s*([\s\S]+?)\]/i)
  if (notionCreateMatch) {
    const title = notionCreateMatch[1].trim()
    const content = notionCreateMatch[2].trim()
    try {
      const page = await notion.createPage(title, content)
      sideEffects.notionCreated = { title, url: page.url || '' }
      text = text.replace(/\[NOTION_CREATE:[\s\S]+?\]/i, '').trim()
      text += `\n\n📄 Page Notion créée : **${title}**${page.url ? `\n🔗 ${page.url}` : ''}`
    } catch (e) {
      text = text.replace(/\[NOTION_CREATE:[\s\S]+?\]/i, '').trim()
      text += `\n\n❌ Erreur Notion : ${e.message}`
    }
  }

  const notionSearchMatch = text.match(/\[NOTION_SEARCH:\s*(.+?)\]/i)
  if (notionSearchMatch) {
    try {
      const results = await notion.search(notionSearchMatch[1].trim())
      const titles = results.map(r => `- ${r.properties?.title?.title?.[0]?.plain_text || 'Sans titre'}`).join('\n')
      text = text.replace(/\[NOTION_SEARCH:[^\]]+\]/i, titles || 'Aucun résultat')
    } catch (e) {
      text = text.replace(/\[NOTION_SEARCH:[^\]]+\]/i, `Erreur : ${e.message}`)
    }
  }

  const notionReadMatch = text.match(/\[NOTION_READ:\s*(.+?)\]/i)
  if (notionReadMatch) {
    try {
      const results = await notion.search(notionReadMatch[1].trim())
      if (results.length > 0) {
        const page = await notion.readPage(results[0].id)
        text = text.replace(/\[NOTION_READ:[^\]]+\]/i, page.textContent.slice(0, 1000) || 'Page vide')
      } else {
        text = text.replace(/\[NOTION_READ:[^\]]+\]/i, 'Page introuvable')
      }
    } catch (e) {
      text = text.replace(/\[NOTION_READ:[^\]]+\]/i, `Erreur : ${e.message}`)
    }
  }

  const notionAppendMatch = text.match(/\[NOTION_APPEND:\s*(.+?)\s*\|\s*([\s\S]+?)\]/i)
  if (notionAppendMatch) {
    const pageName = notionAppendMatch[1].trim()
    const content = notionAppendMatch[2].trim()
    try {
      const results = await notion.search(pageName)
      if (results.length > 0) {
        await notion.appendToPage(results[0].id, content)
        text = text.replace(/\[NOTION_APPEND:[\s\S]+?\]/i, '').trim()
        text += `\n\n✅ Ajouté à **${pageName}**`
      } else {
        text = text.replace(/\[NOTION_APPEND:[\s\S]+?\]/i, '').trim()
        text += `\n\n❌ Page "${pageName}" introuvable`
      }
    } catch (e) {
      text = text.replace(/\[NOTION_APPEND:[\s\S]+?\]/i, '').trim()
      text += `\n\n❌ Erreur : ${e.message}`
    }
  }

  return { text: text.trim(), sideEffects }
}

module.exports = { processReply }
