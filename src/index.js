const express = require('express')
const config = require('./config')
const memory = require('./memory')
const notion = require('./notion')
const { getCalendarEvents } = require('./google')
const db = require('./db')

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

app.delete('/memory/history', async (req, res) => {
  memory.get().history = []
  await db.clearHistory()
  res.json({ ok: true })
})

app.post('/briefing', async (req, res) => {
  res.json({ ok: true, message: 'Briefing déclenché' })
  try {
    const telegramRouter = require('./routes/telegram')
    if (telegramRouter.__triggerBriefing) telegramRouter.__triggerBriefing()
  } catch (e) { console.error('Briefing trigger error:', e.message) }
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

async function start() {await db.init() 
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
require('./routes/telegram')

app.get('/me', async (req, res) => {
  try {
    const { google } = require('googleapis')
    const oauth2Client = new google.auth.OAuth2(config.google.clientId, config.google.clientSecret, config.google.redirectUri)
    oauth2Client.setCredentials({ refresh_token: config.google.refreshToken })
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client })
    const { data } = await oauth2.userinfo.get()
    res.json({ email: data.email, name: data.name })
  } catch (e) { res.status(500).json({ error: e.message }) }
})
