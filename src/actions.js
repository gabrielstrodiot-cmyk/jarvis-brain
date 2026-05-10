const notion = require('./notion')
const memory = require('./memory')
const obsidian = require('./obsidian')

async function processReply(reply) {
  let text = reply
  const sideEffects = {}
  const fetchedData = {}

  const rememberMatches = [...text.matchAll(/\[REMEMBER:\s*(.+?)\]/gi)]
  for (const match of rememberMatches) {
    memory.addFact(match[1].trim())
    text = text.replace(match[0], '')
  }

  // OBSIDIAN — stocke dans fetchedData au lieu de remplacer inline
  const obsidianReadMatch = text.match(/\[OBSIDIAN_READ:\s*(.+?)\]/i)
  if (obsidianReadMatch) {
    try {
      const content = await obsidian.readNote(obsidianReadMatch[1].trim())
      fetchedData.obsidianRead = `Note "${obsidianReadMatch[1].trim()}":\n${content.slice(0, 3000)}`
      text = text.replace(/\[OBSIDIAN_READ:[^\]]+\]/i, '')
    } catch (e) {
      fetchedData.obsidianRead = `Note introuvable : ${e.message}`
      text = text.replace(/\[OBSIDIAN_READ:[^\]]+\]/i, '')
    }
  }

  const obsidianListMatch = text.match(/\[OBSIDIAN_LIST:\s*(.+?)\]/i)
  if (obsidianListMatch) {
    try {
      const files = await obsidian.listFolder(obsidianListMatch[1].trim())
      fetchedData.obsidianList = `Dossier "${obsidianListMatch[1].trim()}":\n${files.join('\n') || 'Vide'}`
      text = text.replace(/\[OBSIDIAN_LIST:[^\]]+\]/i, '')
    } catch (e) {
      fetchedData.obsidianList = `Erreur : ${e.message}`
      text = text.replace(/\[OBSIDIAN_LIST:[^\]]+\]/i, '')
    }
  }

  const obsidianSearchMatch = text.match(/\[OBSIDIAN_SEARCH:\s*(.+?)\]/i)
  if (obsidianSearchMatch) {
    try {
      const results = await obsidian.searchNotes(obsidianSearchMatch[1].trim())
      fetchedData.obsidianSearch = `Résultats recherche "${obsidianSearchMatch[1].trim()}":\n${results.join('\n') || 'Aucun résultat'}`
      text = text.replace(/\[OBSIDIAN_SEARCH:[^\]]+\]/i, '')
    } catch (e) {
      fetchedData.obsidianSearch = `Erreur : ${e.message}`
      text = text.replace(/\[OBSIDIAN_SEARCH:[^\]]+\]/i, '')
    }
  }

  const obsidianWriteMatch = text.match(/\[OBSIDIAN_WRITE:\s*(.+?)\s*\|\s*([\s\S]+?)\]/i)
  if (obsidianWriteMatch) {
    try {
      await obsidian.writeNote(obsidianWriteMatch[1].trim(), obsidianWriteMatch[2].trim())
      text = text.replace(/\[OBSIDIAN_WRITE:[\s\S]+?\]/i, '').trim()
      text += `\nNote écrite : ${obsidianWriteMatch[1].trim()}`
    } catch (e) {
      text = text.replace(/\[OBSIDIAN_WRITE:[\s\S]+?\]/i, '').trim()
      text += `\nErreur écriture : ${e.message}`
    }
  }

  // NOTION
  const notionCreateMatch = text.match(/\[NOTION_CREATE:\s*(.+?)\s*\|\s*([\s\S]+?)\]/i)
  if (notionCreateMatch) {
    const title = notionCreateMatch[1].trim()
    const content = notionCreateMatch[2].trim()
    try {
      const page = await notion.createPage(title, content)
      sideEffects.notionCreated = { title, url: page.url || '' }
      text = text.replace(/\[NOTION_CREATE:[\s\S]+?\]/i, '').trim()
      text += `\nPage Notion créée : ${title}${page.url ? `\n${page.url}` : ''}`
    } catch (e) {
      text = text.replace(/\[NOTION_CREATE:[\s\S]+?\]/i, '').trim()
      text += `\nErreur Notion : ${e.message}`
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
        fetchedData.notionRead = `Page Notion "${notionReadMatch[1].trim()}":\n${page.textContent.slice(0, 1000)}`
        text = text.replace(/\[NOTION_READ:[^\]]+\]/i, '')
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
        text += `\nAjouté à ${pageName}`
      } else {
        text = text.replace(/\[NOTION_APPEND:[\s\S]+?\]/i, '').trim()
        text += `\nPage "${pageName}" introuvable`
      }
    } catch (e) {
      text = text.replace(/\[NOTION_APPEND:[\s\S]+?\]/i, '').trim()
      text += `\nErreur : ${e.message}`
    }
  }

  return { text: text.trim(), sideEffects, fetchedData }
}

module.exports = { processReply }