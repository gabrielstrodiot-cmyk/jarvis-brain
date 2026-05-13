const notion = require('./notion')
const memory = require('./memory')
const obsidian = require('./obsidian')
const google = require('./google')

async function processReply(reply) {
  let text = reply
  const sideEffects = {}
  const fetchedData = {}

  // REMEMBER
  const rememberMatches = [...text.matchAll(/\[REMEMBER:\s*(.+?)\]/gi)]
  for (const match of rememberMatches) {
    memory.addFact(match[1].trim())
    text = text.replace(match[0], '')
  }

  // CALENDAR — créer un événement
  // Format : [CALENDAR_CREATE: titre | 2026-05-13T18:00:00 | 2026-05-13T19:00:00]
  // Format avec description : [CALENDAR_CREATE: titre | 2026-05-13T18:00:00 | 2026-05-13T19:00:00 | description]
  const calendarCreateMatches = [...text.matchAll(/\[CALENDAR_CREATE:\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)(?:\s*\|\s*([\s\S]+?))?\]/gi)]
  for (const match of calendarCreateMatches) {
    const summary = match[1].trim()
    const startDateTime = match[2].trim()
    const endDateTime = match[3].trim()
    const description = match[4] ? match[4].trim() : ''
    try {
      const result = await google.createCalendarEvent(summary, startDateTime, endDateTime, description)
      text = text.replace(match[0], '').trim()
      text += `\n${result}`
    } catch (e) {
      text = text.replace(match[0], '').trim()
      text += `\nErreur Calendar : ${e.message}`
    }
  }

  // GMAIL — envoyer un mail
  // Format : [GMAIL_SEND: destinataire@email.com | Sujet | Corps du message]
  const gmailSendMatch = text.match(/\[GMAIL_SEND:\s*(.+?)\s*\|\s*(.+?)\s*\|\s*([\s\S]+?)\]/i)
  if (gmailSendMatch) {
    const to = gmailSendMatch[1].trim()
    const subject = gmailSendMatch[2].trim()
    const body = gmailSendMatch[3].trim()
    try {
      const result = await google.sendEmail(to, subject, body)
      text = text.replace(/\[GMAIL_SEND:[\s\S]+?\]/i, '').trim()
      text += `\n${result}`
    } catch (e) {
      text = text.replace(/\[GMAIL_SEND:[\s\S]+?\]/i, '').trim()
      text += `\nErreur Gmail : ${e.message}`
    }
  }

  // GMAIL — répondre à un mail
  // Format : [GMAIL_REPLY: messageId | Corps de la réponse]
  const gmailReplyMatch = text.match(/\[GMAIL_REPLY:\s*(.+?)\s*\|\s*([\s\S]+?)\]/i)
  if (gmailReplyMatch) {
    const messageId = gmailReplyMatch[1].trim()
    const body = gmailReplyMatch[2].trim()
    try {
      const result = await google.replyEmail(messageId, body)
      text = text.replace(/\[GMAIL_REPLY:[\s\S]+?\]/i, '').trim()
      text += `\n${result}`
    } catch (e) {
      text = text.replace(/\[GMAIL_REPLY:[\s\S]+?\]/i, '').trim()
      text += `\nErreur Gmail reply : ${e.message}`
    }
  }

  // NOTION TASK — créer une tâche
  // Format : [NOTION_TASK_CREATE: titre | YYYY-MM-DD | Urgent]
  // Date et priorité optionnelles : [NOTION_TASK_CREATE: titre]
  const notionTaskCreateMatch = text.match(/\[NOTION_TASK_CREATE:\s*([^|\]]+?)(?:\s*\|\s*([^|\]]+?))?(?:\s*\|\s*([^|\]]+?))?\]/i)
  if (notionTaskCreateMatch) {
    const name = notionTaskCreateMatch[1].trim()
    const date = notionTaskCreateMatch[2]?.trim() || null
    const priority = notionTaskCreateMatch[3]?.trim() || null
    try {
      const result = await notion.createTask(name, date, priority)
      text = text.replace(/\[NOTION_TASK_CREATE:[\s\S]+?\]/i, '').trim()
      text += `\n${result}`
    } catch (e) {
      text = text.replace(/\[NOTION_TASK_CREATE:[\s\S]+?\]/i, '').trim()
      text += `\nErreur création tâche : ${e.message}`
    }
  }

  // NOTION TASK — mettre à jour le statut
  // Format : [NOTION_TASK_UPDATE: titre | nouveau statut]
  const notionTaskUpdateMatch = text.match(/\[NOTION_TASK_UPDATE:\s*(.+?)\s*\|\s*(.+?)\]/i)
  if (notionTaskUpdateMatch) {
    const taskName = notionTaskUpdateMatch[1].trim()
    const status = notionTaskUpdateMatch[2].trim()
    try {
      const result = await notion.updateTaskStatus(taskName, status)
      text = text.replace(/\[NOTION_TASK_UPDATE:[\s\S]+?\]/i, '').trim()
      text += `\n${result}`
    } catch (e) {
      text = text.replace(/\[NOTION_TASK_UPDATE:[\s\S]+?\]/i, '').trim()
      text += `\nErreur update tâche : ${e.message}`
    }
  }

  // NOTION TASK — marquer comme terminé
  // Format : [NOTION_TASK_DONE: titre]
  const notionTaskDoneMatch = text.match(/\[NOTION_TASK_DONE:\s*(.+?)\]/i)
  if (notionTaskDoneMatch) {
    const taskName = notionTaskDoneMatch[1].trim()
    try {
      const result = await notion.markTaskDone(taskName)
      text = text.replace(/\[NOTION_TASK_DONE:[^\]]+\]/i, '').trim()
      text += `\n${result}`
    } catch (e) {
      text = text.replace(/\[NOTION_TASK_DONE:[^\]]+\]/i, '').trim()
      text += `\nErreur done tâche : ${e.message}`
    }
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

  // NOTION — pages génériques
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
