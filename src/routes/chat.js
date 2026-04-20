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
