require('dotenv').config()
const express = require('express')
const Anthropic = require('@anthropic-ai/sdk')
const fs = require('fs')
const path = require('path')
const { google } = require('googleapis')

const app = express()
app.use(express.json())

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const VAULT_PATH = process.env.VAULT_PATH
const MEMORY_FILE = path.join(__dirname, 'memory.json')
const NOTION_TOKEN = process.env.NOTION_TOKEN
const NOTION_MEMORY_PAGE_ID = '346a16a5-dea2-811b-a3c2-e15932a2fb19'
const NOTION_CHECKIN_PAGE_ID = '347a16a5-dea2-81a0-b479-cb00f2f6d772'
const PUSHCUT_MORNING_URL = 'https://api.pushcut.io/SqkzZ_LTIkyZ00984Lh5F/notifications/Morning%20Briefing%20'
const PUSHCUT_CHECKIN_URL = 'https://api.pushcut.io/SqkzZ_LTIkyZ00984Lh5F/notifications/%20Check%20up%20'
const PUSHCUT_RECAP_URL = 'https://api.pushcut.io/SqkzZ_LTIkyZ00984Lh5F/notifications/%20R%C3%A9cap%20t%C3%A2ches%20'
const TOKEN_FILE = path.join(__dirname, 'google_token.json')

// ── GOOGLE OAUTH ───────────────────────────────────────────────

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'http://localhost:3000/auth/callback'
)

if (fs.existsSync(TOKEN_FILE)) {
  const token = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'))
  oauth2Client.setCredentials(token)
}

async function getGmailUnread() {
  try {
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client })
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread is:inbox',
      maxResults: 5
    })

    const messages = response.data.messages || []
    if (messages.length === 0) return 'Aucun mail non lu.'

    const details = await Promise.all(messages.map(async (msg) => {
      const full = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject']
      })
      const headers = full.data.payload.headers
      const from = headers.find(h => h.name === 'From')?.value || 'Inconnu'
      const subject = headers.find(h => h.name === 'Subject')?.value || 'Sans objet'
      return `- ${from} : ${subject}`
    }))

    return details.join('\n')
  } catch (e) {
    return 'Gmail non connecté.'
  }
}

async function getCalendarEvents() {
  try {
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client })
    const now = new Date()
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0)
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59)

    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    })

    const events = response.data.items || []
    if (events.length === 0) return 'Aucun événement aujourd\'hui.'

    return events.map(e => {
      const start = e.start.dateTime
        ? new Date(e.start.dateTime).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
        : 'Toute la journée'
      return `- ${start} : ${e.summary}`
    }).join('\n')
  } catch (e) {
    return 'Calendar non connecté.'
  }
}

// ── ROUTES AUTH GOOGLE ─────────────────────────────────────────

app.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly'
],
    prompt: 'consent'
  })
  res.redirect(url)
})

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query
  try {
    const { tokens } = await oauth2Client.getToken(code)
    oauth2Client.setCredentials(tokens)
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2))
    res.send('✅ Google Calendar connecté ! Tu peux fermer cet onglet et relancer Jarvis.')
  } catch (e) {
    res.status(500).send('Erreur auth : ' + e.message)
  }
})

// ── MÉMOIRE ────────────────────────────────────────────────────

function loadMemory() {
  if (!fs.existsSync(MEMORY_FILE)) {
    const init = { profile: {}, facts: [], history: [] }
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(init, null, 2))
    return init
  }
  return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'))
}

function saveMemory(memory) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2))
}

function addToHistory(memory, role, content) {
  memory.history.push({ role, content, timestamp: new Date().toISOString() })
  if (memory.history.length > 20) memory.history = memory.history.slice(-20)
}

function buildHistoryMessages(memory) {
  return memory.history.slice(-10).map(h => ({ role: h.role, content: h.content }))
}

function formatFactsForPrompt(memory) {
  if (!memory.facts || memory.facts.length === 0) return ''
  return `\n\n## MÉMOIRE LONG TERME\nFaits importants retenus sur Gabriel :\n${memory.facts.map(f => `- ${f}`).join('\n')}`
}

// ── VAULT HELPERS ──────────────────────────────────────────────

function writeNote(filename, content) {
  const inboxPath = path.join(VAULT_PATH, '00_Jarvis', 'Inbox')
  if (!fs.existsSync(inboxPath)) fs.mkdirSync(inboxPath, { recursive: true })
  fs.writeFileSync(path.join(inboxPath, filename), content, 'utf8')
}

function listRecentNotes(n = 5) {
  const inboxPath = path.join(VAULT_PATH, '00_Jarvis', 'Inbox')
  if (!fs.existsSync(inboxPath)) return []
  return fs.readdirSync(inboxPath)
    .filter(f => f.endsWith('.md'))
    .map(f => ({ name: f, modified: fs.statSync(path.join(inboxPath, f)).mtime }))
    .sort((a, b) => b.modified - a.modified)
    .slice(0, n)
    .map(f => f.name)
}

function searchNotes(query) {
  const inboxPath = path.join(VAULT_PATH, '00_Jarvis', 'Inbox')
  if (!fs.existsSync(inboxPath)) return []
  const results = []
  for (const file of fs.readdirSync(inboxPath).filter(f => f.endsWith('.md'))) {
    const content = fs.readFileSync(path.join(inboxPath, file), 'utf8')
    if (content.toLowerCase().includes(query.toLowerCase()) || file.toLowerCase().includes(query.toLowerCase())) {
      results.push({ file, preview: content.slice(0, 200) })
    }
  }
  return results
}

// ── NOTION HELPERS ─────────────────────────────────────────────

async function notionRequest(method, endpoint, body = null) {
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28'
    }
  }
  if (body) options.body = JSON.stringify(body)
  const res = await fetch(`https://api.notion.com/v1${endpoint}`, options)
  return res.json()
}

async function loadFactsFromNotion() {
  try {
    const page = await notionReadPage(NOTION_MEMORY_PAGE_ID)
    const lines = page.textContent.split('\n')
    const facts = lines
      .filter(l => l.trim().startsWith('- ') && l.trim().length > 2)
      .map(l => l.trim().slice(2).trim())
      .filter(f => f.length > 0)
    return facts
  } catch (e) {
    return []
  }
}

async function saveFactsToNotion(facts) {
  try {
    const factLines = facts.length > 0 ? facts.map(f => `- ${f}`).join('\n') : '- '
    const date = new Date().toLocaleDateString('fr-FR')
    const content = `## 🧩 Facts retenus\n\n${factLines}\n\n---\n\n## 📅 Dernière mise à jour\n\n→ ${date}`
    await notionAppendToPage(NOTION_MEMORY_PAGE_ID, content)
  } catch (e) {}
}

async function notionSearch(query) {
  const data = await notionRequest('POST', '/search', {
    query,
    page_size: 5
  })
  return data.results || []
}

async function notionCreatePage(parentId, title, content, isDatabase = false) {
  const blocks = contentToNotionBlocks(content)
  const body = {
    parent: isDatabase
      ? { database_id: parentId }
      : { page_id: parentId },
    properties: {
      title: {
        title: [{ text: { content: title } }]
      }
    },
    children: blocks
  }
  return notionRequest('POST', '/pages', body)
}

async function notionCreateStandalonePage(title, content) {
  const searchResults = await notionSearch('')
  const firstPage = searchResults.find(r => r.object === 'page' || r.object === 'database')
  const blocks = contentToNotionBlocks(content)
  const body = {
    parent: firstPage
      ? { page_id: firstPage.id }
      : { type: 'workspace', workspace: true },
    properties: {
      title: {
        title: [{ text: { content: title } }]
      }
    },
    children: blocks
  }
  return notionRequest('POST', '/pages', body)
}

function contentToNotionBlocks(content) {
  const lines = content.split('\n').filter(l => l.trim())
  const blocks = []

  for (const line of lines) {
    if (line.startsWith('# ')) {
      blocks.push({ object: 'block', type: 'heading_1', heading_1: { rich_text: [{ text: { content: line.slice(2) } }] } })
    } else if (line.startsWith('## ')) {
      blocks.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: [{ text: { content: line.slice(3) } }] } })
    } else if (line.startsWith('### ')) {
      blocks.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: [{ text: { content: line.slice(4) } }] } })
    } else if (line.startsWith('- ') || line.startsWith('• ')) {
      blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ text: { content: line.slice(2) } }] } })
    } else if (/^\d+\./.test(line)) {
      blocks.push({ object: 'block', type: 'numbered_list_item', numbered_list_item: { rich_text: [{ text: { content: line.replace(/^\d+\.\s*/, '') } }] } })
    } else if (line.startsWith('> ')) {
      blocks.push({ object: 'block', type: 'quote', quote: { rich_text: [{ text: { content: line.slice(2) } }] } })
    } else if (line.startsWith('---')) {
      blocks.push({ object: 'block', type: 'divider', divider: {} })
    } else {
      blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content: line } }] } })
    }
  }

  return blocks.slice(0, 100)
}

async function notionReadPage(pageId) {
  const page = await notionRequest('GET', `/pages/${pageId}`)
  const blocks = await notionRequest('GET', `/blocks/${pageId}/children?page_size=100`)
  const textContent = (blocks.results || []).map(block => {
    const type = block.type
    const richText = block[type]?.rich_text || []
    return richText.map(t => t.plain_text).join('')
  }).filter(Boolean).join('\n')
  return { page, textContent }
}

async function notionAppendToPage(pageId, content) {
  const blocks = contentToNotionBlocks(content)
  return notionRequest('PATCH', `/blocks/${pageId}/children`, { children: blocks })
}

// ── SYSTEM PROMPT ──────────────────────────────────────────────

function buildSystemPrompt(memory, calendarEvents, gmailUnread) {
  const facts = formatFactsForPrompt(memory)
  const calendar = calendarEvents ? `\n\n## AGENDA DU JOUR\n${calendarEvents}` : ''
const gmail = gmailUnread ? `\n\n## MAILS NON LUS\n${gmailUnread}` : ''
  return `Tu es Jarvis, l'assistant personnel de Gabriel Strodiot.

## QUI EST GABRIEL
- Coach fitness et lifestyle, 25 ans, basé en Belgique
- Créateur de la méthode FLOW — transformation physique et mentale pour hommes 20-35 ans
- Business en ligne : contenu Instagram, programmes, coaching 1-1
- Vault Obsidian : son second cerveau (notes, idées, projets, systèmes)
- Profil : ambitieux, direct, va à l'essentiel, aime les systèmes et l'automatisation
- Outils : Make/Zapier, iPhone, VS Code, Railway, GitHub${facts}${calendar}${gmail}

## TA PERSONNALITÉ
- Direct, concis, actionnable — pas de blabla, pas de listes inutiles
- Tu anticipes les besoins plutôt que d'attendre
- Tu peux challenger ses idées si tu vois mieux
- Ton ton : entre un CTO de startup et un coach de haut niveau
- Tu tutoies toujours Gabriel

## TES CAPACITÉS VAULT OBSIDIAN
- Pour écrire une note : [WRITE_NOTE: titre]
- Pour lire les notes récentes : [LIST_NOTES]
- Pour chercher dans le vault : [SEARCH_NOTES: mot-clé]

## TES CAPACITÉS NOTION
- Pour créer une page Notion : [NOTION_CREATE: titre | contenu complet de la page]
- Pour chercher dans Notion : [NOTION_SEARCH: mot-clé]
- Pour lire une page Notion : [NOTION_READ: nom de la page]
- Pour ajouter du contenu à une page : [NOTION_APPEND: nom de la page | contenu à ajouter]

### Règles Notion
- Utilise [NOTION_CREATE: ...] quand Gabriel veut créer une page, un document, une fiche, un résumé
- Le contenu après le | peut être du markdown (titres ##, listes -, etc.)
- Tu peux combiner [SEARCH_NOTES: ...] puis [NOTION_CREATE: ...] pour créer une page Notion depuis les données Obsidian
- Quand tu crées une page complète, structure-la avec des titres clairs

## MÉMOIRE
- Pour retenir un fait important : [REMEMBER: fait à retenir]
- Utilise [REMEMBER: ...] quand Gabriel mentionne quelque chose d'important

## RÈGLES
- Réponds TOUJOURS en français sauf si Gabriel écrit en anglais
- Réponses courtes par défaut — développe seulement si demandé
- Jamais de intro générique comme "Bien sûr !" ou "Absolument !"
- Si tu ne sais pas quelque chose, dis-le directement sans t'excuser`
}

// ── ROUTE PRINCIPALE ───────────────────────────────────────────

app.post('/chat', async (req, res) => {
  const { message } = req.body
  if (!message) return res.status(400).json({ error: 'Message requis' })

  const memory = loadMemory()
  memory.facts = await loadFactsFromNotion()

  const calendarEvents = await getCalendarEvents()
  const gmailUnread = await getGmailUnread()

  let vaultContext = ''
  try {
    const recentNotes = listRecentNotes(3)
    if (recentNotes.length > 0) vaultContext = ` [Vault — notes récentes : ${recentNotes.join(', ')}]`
  } catch (e) {}

  const historyMessages = buildHistoryMessages(memory)
  const currentMessage = message + vaultContext
  addToHistory(memory, 'user', message)

  try {
    const response = await claude.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 2048,
      system: buildSystemPrompt(memory, calendarEvents, gmailUnread),
      messages: [...historyMessages, { role: 'user', content: currentMessage }]
    })

    let reply = response.content[0].text
    let noteCreated = null
    let notionCreated = null

    // ── Traite REMEMBER ──
    const rememberMatches = [...reply.matchAll(/\[REMEMBER:\s*(.+?)\]/gi)]
    for (const match of rememberMatches) {
      const fact = match[1].trim()
      if (!memory.facts.includes(fact)) memory.facts.push(fact)
      reply = reply.replace(match[0], '')
    }

    // ── Traite WRITE_NOTE ──
    const writeMatch = reply.match(/\[WRITE_NOTE:\s*(.+?)\]/i)
    if (writeMatch) {
      const title = writeMatch[1].trim()
      const date = new Date().toISOString().split('T')[0]
      const time = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
      const cleanReply = reply.replace(/\[WRITE_NOTE:[^\]]+\]/i, '').trim()
      const noteContent = `# ${title}\n\n${cleanReply}\n\n---\n*Créé par Jarvis le ${date} à ${time}*`
      const filename = `${date}-${title.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')}.md`
      try { writeNote(filename, noteContent); noteCreated = filename } catch (e) {}
      reply = cleanReply + `\n\n📝 Note Obsidian créée : \`${filename}\``
    }

    // ── Traite LIST_NOTES ──
    if (reply.includes('[LIST_NOTES]')) {
      const notes = listRecentNotes(5)
      const listText = notes.length > 0 ? notes.join('\n- ') : 'Aucune note trouvée'
      reply = reply.replace('[LIST_NOTES]', `Notes récentes :\n- ${listText}`)
    }

    // ── Traite SEARCH_NOTES ──
    const searchMatch = reply.match(/\[SEARCH_NOTES:\s*(.+?)\]/i)
    if (searchMatch) {
      const results = searchNotes(searchMatch[1].trim())
      const searchText = results.length > 0
        ? results.map(r => `**${r.file}** : ${r.preview}...`).join('\n\n')
        : 'Aucune note trouvée'
      reply = reply.replace(/\[SEARCH_NOTES:[^\]]+\]/i, searchText)
    }

    // ── Traite NOTION_CREATE ──
    const notionCreateMatch = reply.match(/\[NOTION_CREATE:\s*(.+?)\s*\|\s*([\s\S]+?)\]/i)
    if (notionCreateMatch) {
      const title = notionCreateMatch[1].trim()
      const content = notionCreateMatch[2].trim()
      try {
        const page = await notionCreateStandalonePage(title, content)
        const pageUrl = page.url || ''
        notionCreated = { title, url: pageUrl }
        reply = reply.replace(/\[NOTION_CREATE:[\s\S]+?\]/i, '').trim()
        reply += `\n\n📄 Page Notion créée : **${title}**${pageUrl ? `\n🔗 ${pageUrl}` : ''}`
      } catch (e) {
        reply = reply.replace(/\[NOTION_CREATE:[\s\S]+?\]/i, '').trim()
        reply += `\n\n❌ Erreur Notion : ${e.message}`
      }
    }

    // ── Traite NOTION_SEARCH ──
    const notionSearchMatch = reply.match(/\[NOTION_SEARCH:\s*(.+?)\]/i)
    if (notionSearchMatch) {
      try {
        const results = await notionSearch(notionSearchMatch[1].trim())
        const titles = results.map(r => {
          const title = r.properties?.title?.title?.[0]?.plain_text || r.properties?.Name?.title?.[0]?.plain_text || 'Sans titre'
          return `- ${title} (${r.object})`
        }).join('\n')
        reply = reply.replace(/\[NOTION_SEARCH:[^\]]+\]/i, titles || 'Aucun résultat Notion')
      } catch (e) {
        reply = reply.replace(/\[NOTION_SEARCH:[^\]]+\]/i, `Erreur Notion : ${e.message}`)
      }
    }

    // ── Traite NOTION_APPEND ──
    const notionAppendMatch = reply.match(/\[NOTION_APPEND:\s*(.+?)\s*\|\s*([\s\S]+?)\]/i)
    if (notionAppendMatch) {
      const pageName = notionAppendMatch[1].trim()
      const content = notionAppendMatch[2].trim()
      try {
        const results = await notionSearch(pageName)
        if (results.length > 0) {
          await notionAppendToPage(results[0].id, content)
          reply = reply.replace(/\[NOTION_APPEND:[\s\S]+?\]/i, '').trim()
          reply += `\n\n✅ Contenu ajouté à la page Notion **${pageName}**`
        } else {
          reply = reply.replace(/\[NOTION_APPEND:[\s\S]+?\]/i, '').trim()
          reply += `\n\n❌ Page Notion "${pageName}" introuvable`
        }
      } catch (e) {
        reply = reply.replace(/\[NOTION_APPEND:[\s\S]+?\]/i, '').trim()
        reply += `\n\n❌ Erreur Notion : ${e.message}`
      }
    }

    reply = reply.trim()
    addToHistory(memory, 'assistant', reply)
    await saveFactsToNotion(memory.facts)
    saveMemory(memory)

    res.json({
      reply,
      model: 'claude-sonnet-4-5',
      timestamp: new Date().toISOString(),
      noteCreated,
      notionCreated,
      factsCount: memory.facts.length,
      calendarEvents
    })

  } catch (error) {
    console.error('Erreur Claude:', error)
    res.status(500).json({ error: error.message })
  }
})

// ── ROUTES MÉMOIRE ─────────────────────────────────────────────

app.get('/memory', (req, res) => {
  const memory = loadMemory()
  res.json({ facts: memory.facts, historyLength: memory.history.length })
})

app.delete('/memory/facts', (req, res) => {
  const memory = loadMemory()
  memory.facts = []
  saveMemory(memory)
  res.json({ ok: true, message: 'Faits effacés' })
})

app.delete('/memory/history', (req, res) => {
  const memory = loadMemory()
  memory.history = []
  saveMemory(memory)
  res.json({ ok: true, message: 'Historique effacé' })
})

// ── ROUTES VAULT ───────────────────────────────────────────────

app.get('/vault/notes', (req, res) => {
  try {
    res.json({ notes: listRecentNotes(20) })
  } catch (e) {
    res.status(500).json({ error: 'Vault non accessible' })
  }
})

// ── ROUTES NOTION DIRECTES ─────────────────────────────────────

app.get('/notion/search', async (req, res) => {
  const { q } = req.query
  if (!q) return res.status(400).json({ error: 'Paramètre q requis' })
  try {
    const results = await notionSearch(q)
    res.json({ results: results.map(r => ({
      id: r.id,
      type: r.object,
      title: r.properties?.title?.title?.[0]?.plain_text || r.properties?.Name?.title?.[0]?.plain_text || 'Sans titre',
      url: r.url
    }))})
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/notion/page', async (req, res) => {
  const { title, content, parentId } = req.body
  if (!title) return res.status(400).json({ error: 'Titre requis' })
  try {
    const page = parentId
      ? await notionCreatePage(parentId, title, content || '')
      : await notionCreateStandalonePage(title, content || '')
    res.json({ ok: true, id: page.id, url: page.url })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── ROUTES JARVIS PROACTIF ─────────────────────────────────────

app.post('/jarvis/checkin', async (req, res) => {
  try {
    // Lit l'historique des questions déjà posées
    const page = await notionReadPage(NOTION_CHECKIN_PAGE_ID)
    const previousQA = page.textContent

    // Génère une nouvelle question inédite
    const response = await claude.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 500,
      system: `Tu es Jarvis, assistant personnel de Gabriel Strodiot (coach fitness 25 ans, Belgique, méthode FLOW, business en ligne).
Tu poses UNE question personnelle courte et précise pour mieux connaître Gabriel.
Règles :
- Ne jamais répéter une question déjà posée
- Varier les thèmes : objectifs, santé, business, relations, mindset, finances, habitudes
- Question courte (1 phrase max)
- Ton direct, pas condescendant
- Réponds UNIQUEMENT avec la question, rien d'autre`,
      messages: [{
        role: 'user',
        content: `Voici les questions déjà posées :\n${previousQA}\n\nGénère une nouvelle question inédite.`
      }]
    })

    const question = response.content[0].text.trim()

    // Envoie la notification Pushcut
    await fetch(PUSHCUT_CHECKIN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '🤖 Jarvis — Question du jour',
        text: question
      })
    })

    // Stocke la question dans Notion (sans réponse pour l'instant)
    const date = new Date().toLocaleDateString('fr-FR')
    await notionAppendToPage(NOTION_CHECKIN_PAGE_ID, `## ${date}\n**Q : ${question}**\nR : *En attente*`)

    res.json({ ok: true, question })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/jarvis/checkin/answer', async (req, res) => {
  try {
    const { answer, question } = req.body
    if (!answer) return res.status(400).json({ error: 'Réponse requise' })

    const date = new Date().toLocaleDateString('fr-FR')
    const content = question
      ? `## ${date}\n**Q : ${question}**\nR : ${answer}`
      : `## ${date}\nR : ${answer}`

    await notionAppendToPage(NOTION_CHECKIN_PAGE_ID, content)

    // Sauvegarde aussi dans la mémoire long terme
    const memory = loadMemory()
    memory.facts = await loadFactsFromNotion()
    const fact = question ? `${question} → ${answer}` : answer
    if (!memory.facts.includes(fact)) memory.facts.push(fact)
    await saveFactsToNotion(memory.facts)
    saveMemory(memory)

    res.json({ ok: true, message: 'Réponse enregistrée dans Notion et mémoire' })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/jarvis/recap', async (req, res) => {
  try {
    const calendarEvents = await getCalendarEvents()
    const memory = loadMemory()
    memory.facts = await loadFactsFromNotion()

    const response = await claude.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 500,
      system: buildSystemPrompt(memory, calendarEvents, null),
      messages: [{
        role: 'user',
        content: 'Fais un récap ultra court de la journée : ce qui était prévu, ce qui a pu être fait ou raté, et 1 action clé pour demain. Max 5 lignes.'
      }]
    })

    const recap = response.content[0].text.trim()

    await fetch(PUSHCUT_RECAP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '✅ Jarvis — Récap de la journée',
        text: recap
      })
    })

    res.json({ ok: true, recap })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── ROUTE CALENDAR DIRECT ──────────────────────────────────────

app.get('/calendar/today', async (req, res) => {
  const events = await getCalendarEvents()
  res.json({ events })
})

// ── SANTÉ ──────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'Jarvis is alive 🤖',
    timestamp: new Date().toISOString(),
    integrations: {
      notion: !!NOTION_TOKEN,
      vault: !!VAULT_PATH,
      googleCalendar: fs.existsSync(TOKEN_FILE)
    }
  })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`🤖 Jarvis Brain démarré sur le port ${PORT}`)
  console.log(`📁 Vault Obsidian : ${VAULT_PATH}`)
  console.log(`🧠 Mémoire : ${MEMORY_FILE}`)
  console.log(`📄 Notion : ${NOTION_TOKEN ? '✅ connecté' : '❌ token manquant'}`)
  console.log(`📅 Google Calendar : ${fs.existsSync(TOKEN_FILE) ? '✅ connecté' : '⚠️ non autorisé — visite http://localhost:3000/auth/google'}`)
})
