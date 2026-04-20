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
