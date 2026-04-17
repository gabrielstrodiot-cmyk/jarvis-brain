require('dotenv').config()
const express = require('express')
const Anthropic = require('@anthropic-ai/sdk')
const fs = require('fs')
const path = require('path')

const app = express()
app.use(express.json())

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const VAULT_PATH = process.env.VAULT_PATH

// Fonction pour écrire une note dans Obsidian
function writeNote(filename, content) {
  const inboxPath = path.join(VAULT_PATH, '00_Jarvis', 'Inbox')
  const filepath = path.join(inboxPath, filename)
  fs.writeFileSync(filepath, content, 'utf8')
  return filepath
}

// Route principale : parler à Jarvis
app.post('/chat', async (req, res) => {
  const { message } = req.body
  
  if (!message) {
    return res.status(400).json({ error: 'Message requis' })
  }

  try {
    const response = await claude.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system: `Tu es Jarvis, l'assistant personnel de Gabriel Strodiot, coach fitness et lifestyle, créateur de la méthode FLOW.
      
Tu connais Gabriel : il est ambitieux, direct, il aime aller à l'essentiel. Pas de blabla inutile.
Tu peux écrire des notes dans son vault Obsidian quand il te le demande.
Réponds toujours en français, de façon concise et actionnable.
Si Gabriel te demande de noter quelque chose, indique-lui que tu vas créer une note dans son Inbox Obsidian.`,
      messages: [{ role: 'user', content: message }]
    })

    const reply = response.content[0].text

    // Détecte si Jarvis doit écrire une note
    if (message.toLowerCase().includes('note') || message.toLowerCase().includes('écris') || message.toLowerCase().includes('sauvegarde')) {
      const date = new Date().toISOString().split('T')[0]
      const time = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
      const noteContent = `# Note Jarvis — ${date} ${time}\n\n${reply}\n\n---\n*Créé par Jarvis le ${date} à ${time}*`
      const filename = `${date}-jarvis-note.md`
      writeNote(filename, noteContent)
    }

    res.json({ 
      reply,
      model: 'claude-sonnet-4-5',
      timestamp: new Date().toISOString()
    })

  } catch (error) {
    console.error('Erreur Claude:', error)
    res.status(500).json({ error: error.message })
  }
})

// Route de santé
app.get('/health', (req, res) => {
  res.json({ status: 'Jarvis is alive 🤖', timestamp: new Date().toISOString() })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`🤖 Jarvis Brain démarré sur le port ${PORT}`)
  console.log(`📁 Vault Obsidian : ${VAULT_PATH}`)
})