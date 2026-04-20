#!/bin/bash
set -e

# package.json
cat > package.json << 'EOF'
{
  "name": "jarvis-brain",
  "version": "2.0.0",
  "description": "Jarvis — assistant personnel de Gabriel",
  "main": "src/index.js",
  "scripts": {
    "start": "node src/index.js",
    "dev": "node --watch src/index.js"
  },
  "engines": {
    "node": ">=18.0.0"
  },
  "license": "ISC",
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "googleapis": "^144.0.0",
    "multer": "^1.4.5-lts.1",
    "node-fetch": "^2.7.0",
    "form-data": "^4.0.0"
  }
}
EOF

# nixpacks.toml
cat > nixpacks.toml << 'EOF'
[phases.setup]
nixPkgs = ["nodejs_20", "python3"]

[phases.install]
cmds = ["npm ci --omit=dev"]

[start]
cmd = "node src/index.js"
EOF

# .gitignore
cat > .gitignore << 'EOF'
node_modules/
.env
*.json.bak
.DS_Store
google_token.json
EOF

# .env.example
cat > .env.example << 'EOF'
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=F9KUTOne5xOKqAbIU7yg
NOTION_TOKEN=secret_...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/callback
GOOGLE_REFRESH_TOKEN=
PORT=3000
EOF

mkdir -p src/routes

# src/config.js
cat > src/config.js << 'EOF'
require('dotenv').config()

const config = {
  port: process.env.PORT || 3000,
  anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
  openai: { apiKey: process.env.OPENAI_API_KEY },
  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY,
    voiceId: process.env.ELEVENLABS_VOICE_ID,
  },
  notion: {
    token: process.env.NOTION_TOKEN,
    memoryPageId: '346a16a5-dea2-811b-a3c2-e15932a2fb19',
    checkinPageId: '347a16a5-dea2-81a0-b479-cb00f2f6d772',
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/callback',
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
  },
  pushcut: {
    morningUrl: 'https://api.pushcut.io/SqkzZ_LTIkyZ00984Lh5F/notifications/Morning%20Briefing%20',
    checkinUrl: 'https://api.pushcut.io/SqkzZ_LTIkyZ00984Lh5F/notifications/%20Check%20up%20',
    recapUrl: 'https://api.pushcut.io/SqkzZ_LTIkyZ00984Lh5F/notifications/%20R%C3%A9cap%20t%C3%A2ches%20',
  },
}

module.exports = config
EOF

# src/google.js
cat > src/google.js << 'EOF'
const { google } = require('googleapis')
const config = require('./config')

const oauth2Client = new google.auth.OAuth2(
  config.google.clientId,
  config.google.clientSecret,
  config.google.redirectUri
)

if (config.google.refreshToken) {
  oauth2Client.setCredentials({ refresh_token: config.google.refreshToken })
}

function getAuthUrl() {
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/gmail.readonly',
    ],
    prompt: 'consent',
  })
}

async function handleCallback(code) {
  const { tokens } = await oauth2Client.getToken(code)
  oauth2Client.setCredentials(tokens)
  return tokens
}

async function getCalendarEvents() {
  if (!config.google.refreshToken) return 'Google Calendar non configuré — visite /auth/google'
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
      orderBy: 'startTime',
    })
    const events = response.data.items || []
    if (events.length === 0) return "Aucun événement aujourd'hui."
    return events.map(e => {
      const start = e.start.dateTime
        ? new Date(e.start.dateTime).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
        : 'Toute la journée'
      return `- ${start} : ${e.summary}`
    }).join('\n')
  } catch (e) {
    return 'Erreur Calendar : ' + e.message
  }
}

async function getGmailUnread() {
  if (!config.google.refreshToken) return 'Gmail non configuré.'
  try {
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client })
    const response = await gmail.users.messages.list({ userId: 'me', q: 'is:unread is:inbox', maxResults: 5 })
    const messages = response.data.messages || []
    if (messages.length === 0) return 'Aucun mail non lu.'
    const details = await Promise.all(messages.map(async (msg) => {
      const full = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'metadata', metadataHeaders: ['From', 'Subject'] })
      const headers = full.data.payload.headers
      const from = headers.find(h => h.name === 'From')?.value || 'Inconnu'
      const subject = headers.find(h => h.name === 'Subject')?.value || 'Sans objet'
      return `- ${from} : ${subject}`
    }))
    return details.join('\n')
  } catch (e) {
    return 'Erreur Gmail : ' + e.message
  }
}

module.exports = { getAuthUrl, handleCallback, getCalendarEvents, getGmailUnread }
EOF

# src/notion.js
cat > src/notion.js << 'EOF'
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
EOF

# src/memory.js
cat > src/memory.js << 'EOF'
const notion = require('./notion')

let store = { facts: [], history: [] }

async function load() {
  store.facts = await notion.loadFacts()
  return store
}

function get() { return store }

function addToHistory(role, content) {
  store.history.push({ role, content, timestamp: new Date().toISOString() })
  if (store.history.length > 20) store.history = store.history.slice(-20)
}

function getHistoryMessages() {
  return store.history.slice(-10).map(h => ({ role: h.role, content: h.content }))
}

function addFact(fact) {
  if (!store.facts.includes(fact)) store.facts.push(fact)
}

async function persist() { await notion.saveFacts(store.facts) }

function formatFactsForPrompt() {
  if (!store.facts || store.facts.length === 0) return ''
  return `\n\n## MÉMOIRE LONG TERME\n${store.facts.map(f => `- ${f}`).join('\n')}`
}

module.exports = { load, get, addToHistory, getHistoryMessages, addFact, persist, formatFactsForPrompt }
EOF

# src/claude.js
cat > src/claude.js << 'EOF'
const Anthropic = require('@anthropic-ai/sdk')
const config = require('./config')
const memory = require('./memory')

const client = new Anthropic({ apiKey: config.anthropic.apiKey })

function buildSystemPrompt(calendarEvents, gmailUnread) {
  const facts = memory.formatFactsForPrompt()
  const calendar = calendarEvents ? `\n\n## AGENDA DU JOUR\n${calendarEvents}` : ''
  const gmail = gmailUnread ? `\n\n## MAILS NON LUS\n${gmailUnread}` : ''
  return `Tu es Jarvis, l'assistant personnel de Gabriel Strodiot.

## QUI EST GABRIEL
- Coach fitness et lifestyle, 25 ans, basé à Namur, Belgique
- Créateur de la méthode FLOW — transformation physique et mentale pour hommes 20-35 ans
- Business en ligne : contenu Instagram, programmes, coaching 1-1
- Profil : ambitieux, direct, va à l'essentiel, aime les systèmes et l'automatisation
- Outils : Make, iPhone, VS Code, Railway, GitHub, Notion${facts}${calendar}${gmail}

## TA PERSONNALITÉ
- Direct, concis, actionnable — pas de blabla
- Tu anticipes les besoins plutôt que d'attendre
- Tu challenges ses idées si tu vois mieux
- Ton ton : entre un CTO de startup et un coach de haut niveau
- Tu tutoies toujours Gabriel

## TES CAPACITÉS NOTION
- Pour créer une page : [NOTION_CREATE: titre | contenu markdown]
- Pour chercher : [NOTION_SEARCH: mot-clé]
- Pour lire une page : [NOTION_READ: nom de la page]
- Pour ajouter du contenu : [NOTION_APPEND: nom de la page | contenu]

## MÉMOIRE
- Pour retenir un fait : [REMEMBER: fait important]

## RÈGLES
- Réponds TOUJOURS en français sauf si Gabriel écrit en anglais
- Réponses courtes par défaut
- Jamais de intro générique comme "Bien sûr !" ou "Absolument !"
- Si tu ne sais pas, dis-le directement`
}

async function chat(message, calendarEvents, gmailUnread) {
  const historyMessages = memory.getHistoryMessages()
  memory.addToHistory('user', message)
  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2048,
    system: buildSystemPrompt(calendarEvents, gmailUnread),
    messages: [...historyMessages, { role: 'user', content: message }],
  })
  return response.content[0].text
}

async function generate(systemPrompt, userMessage, maxTokens = 500) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  })
  return response.content[0].text.trim()
}

module.exports = { chat, generate, buildSystemPrompt }
EOF

# src/actions.js
cat > src/actions.js << 'EOF'
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
EOF

# src/routes/auth.js
cat > src/routes/auth.js << 'EOF'
const express = require('express')
const router = express.Router()
const { getAuthUrl, handleCallback } = require('../google')

router.get('/google', (req, res) => {
  res.redirect(getAuthUrl())
})

router.get('/callback', async (req, res) => {
  const { code } = req.query
  if (!code) return res.status(400).send('Code manquant')
  try {
    const tokens = await handleCallback(code)
    res.send(`<html><body style="font-family:monospace;padding:2rem;background:#0d1117;color:#e6edf3">
      <h2>✅ Google connecté !</h2>
      <p>Ajoute cette variable dans Railway :</p>
      <pre style="background:#161b22;padding:1rem;border-radius:8px;word-break:break-all">GOOGLE_REFRESH_TOKEN=${tokens.refresh_token || '(déjà existant)'}</pre>
      <p style="color:#8b949e">Une fois ajouté, redéploie. Tu n'auras plus jamais besoin de refaire ça.</p>
    </body></html>`)
  } catch (e) {
    res.status(500).send('Erreur auth : ' + e.message)
  }
})

module.exports = router
EOF

# src/routes/chat.js
cat > src/routes/chat.js << 'EOF'
const express = require('express')
const router = express.Router()
const claudeClient = require('../claude')
const memory = require('../memory')
const actions = require('../actions')
const { getCalendarEvents, getGmailUnread } = require('../google')

router.post('/', async (req, res) => {
  const { message } = req.body
  if (!message) return res.status(400).json({ error: 'Message requis' })
  try {
    await memory.load()
    const [calendarEvents, gmailUnread] = await Promise.all([getCalendarEvents(), getGmailUnread()])
    const rawReply = await claudeClient.chat(message, calendarEvents, gmailUnread)
    const { text: reply, sideEffects } = await actions.processReply(rawReply)
    memory.addToHistory('assistant', reply)
    await memory.persist()
    res.json({ reply, timestamp: new Date().toISOString(), ...sideEffects })
  } catch (error) {
    console.error('Chat error:', error)
    res.status(500).json({ error: error.message })
  }
})

module.exports = router
EOF

# src/routes/jarvis.js
cat > src/routes/jarvis.js << 'EOF'
const express = require('express')
const router = express.Router()
const claudeClient = require('../claude')
const memory = require('../memory')
const notion = require('../notion')
const config = require('../config')
const { getCalendarEvents } = require('../google')

async function pushcut(url, title, text) {
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, text }) })
  } catch (e) { console.error('Pushcut error:', e.message) }
}

router.post('/checkin', async (req, res) => {
  try {
    const page = await notion.readPage(config.notion.checkinPageId)
    const question = await claudeClient.generate(
      `Tu es Jarvis, assistant personnel de Gabriel Strodiot (coach fitness 25 ans, Belgique, méthode FLOW).
Tu poses UNE question personnelle courte et précise pour mieux connaître Gabriel.
- Ne jamais répéter une question déjà posée
- Varier les thèmes : objectifs, santé, business, relations, mindset, finances, habitudes
- Question courte (1 phrase max), ton direct
- Réponds UNIQUEMENT avec la question`,
      `Questions déjà posées :\n${page.textContent}\n\nNouvelle question inédite.`
    )
    await pushcut(config.pushcut.checkinUrl, '🤖 Jarvis — Question du jour', question)
    const date = new Date().toLocaleDateString('fr-FR')
    await notion.appendToPage(config.notion.checkinPageId, `## ${date}\n**Q : ${question}**\nR : *En attente*`)
    res.json({ ok: true, question })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.post('/checkin/answer', async (req, res) => {
  const { answer, question } = req.body
  if (!answer) return res.status(400).json({ error: 'Réponse requise' })
  try {
    const date = new Date().toLocaleDateString('fr-FR')
    await notion.appendToPage(config.notion.checkinPageId, question ? `## ${date}\n**Q : ${question}**\nR : ${answer}` : `## ${date}\nR : ${answer}`)
    await memory.load()
    memory.addFact(question ? `${question} → ${answer}` : answer)
    await memory.persist()
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.post('/recap', async (req, res) => {
  try {
    await memory.load()
    const calendarEvents = await getCalendarEvents()
    const recap = await claudeClient.generate(
      claudeClient.buildSystemPrompt(calendarEvents, null),
      'Fais un récap ultra court de la journée : ce qui était prévu, ce qui a pu être fait ou raté, et 1 action clé pour demain. Max 5 lignes.'
    )
    await pushcut(config.pushcut.recapUrl, '✅ Jarvis — Récap de la journée', recap)
    res.json({ ok: true, recap })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

module.exports = router
EOF

# src/routes/voice.js
cat > src/routes/voice.js << 'EOF'
const express = require('express')
const router = express.Router()

router.post('/', async (req, res) => {
  res.status(501).json({ message: 'Voice endpoint — Session 2' })
})

module.exports = router
EOF

# src/index.js
cat > src/index.js << 'EOF'
const express = require('express')
const config = require('./config')
const memory = require('./memory')
const notion = require('./notion')
const { getCalendarEvents } = require('./google')

const app = express()
app.use(express.json({ limit: '10mb' }))

app.use('/auth', require('./routes/auth'))
app.use('/chat', require('./routes/chat'))
app.use('/jarvis', require('./routes/jarvis'))
app.use('/voice', require('./routes/voice'))

app.get('/notion/search', async (req, res) => {
  const { q } = req.query
  if (!q) return res.status(400).json({ error: 'Paramètre q requis' })
  try {
    const results = await notion.search(q)
    res.json({ results: results.map(r => ({ id: r.id, type: r.object, title: r.properties?.title?.title?.[0]?.plain_text || 'Sans titre', url: r.url })) })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/calendar/today', async (req, res) => {
  res.json({ events: await getCalendarEvents() })
})

app.get('/memory', async (req, res) => {
  const mem = memory.get()
  res.json({ factsCount: mem.facts.length, facts: mem.facts, historyLength: mem.history.length })
})

app.delete('/memory/facts', async (req, res) => {
  memory.get().facts = []
  await memory.persist()
  res.json({ ok: true })
})

app.delete('/memory/history', (req, res) => {
  memory.get().history = []
  res.json({ ok: true })
})

app.get('/health', (req, res) => {
  res.json({
    status: '🤖 Jarvis is alive',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    integrations: {
      anthropic: !!config.anthropic.apiKey,
      notion: !!config.notion.token,
      googleCalendar: !!config.google.refreshToken,
      elevenlabs: !!config.elevenlabs.apiKey,
      openai: !!config.openai.apiKey,
    },
  })
})

async function start() {
  try {
    await memory.load()
    console.log(`🧠 Mémoire chargée : ${memory.get().facts.length} facts`)
  } catch (e) {
    console.warn('⚠️  Mémoire non chargée :', e.message)
  }
  app.listen(config.port, () => {
    console.log(`🤖 Jarvis v2.0 démarré sur le port ${config.port}`)
    console.log(`📅 Google : ${config.google.refreshToken ? '✅' : '⚠️  visite /auth/google'}`)
    console.log(`📄 Notion : ${config.notion.token ? '✅' : '❌'}`)
    console.log(`🎙️  Voice : prêt pour session 2`)
  })
}

start()
EOF

echo "✅ Tous les fichiers créés."
