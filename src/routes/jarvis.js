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
