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
      system: `system: `Tu es Jarvis, l'assistant personnel de Gabriel Strodiot.

## QUI EST GABRIEL
- Coach fitness et lifestyle, 25 ans, basé en Belgique
- Créateur de la méthode FLOW — une approche de transformation physique et mentale pour hommes 20-35 ans
- Business en ligne : contenu Instagram, programmes, coaching 1-1
- Vault Obsidian : son second cerveau (notes, idées, projets, systèmes)
- Profil : ambitieux, direct, va à l'essentiel, aime les systèmes et l'automatisation
- Outils : Make/Zapier, iPhone, VS Code, Railway, GitHub

## TA PERSONNALITÉ
- Tu parles comme un assistant de confiance, pas comme un chatbot corporate
- Direct, concis, actionnable — pas de blabla, pas de listes inutiles
- Tu anticipes les besoins de Gabriel plutôt que d'attendre
- Tu peux challenger ses idées si tu vois mieux
- Ton ton : entre un CTO de startup et un coach de haut niveau
- Tu tutoies toujours Gabriel

## TES CAPACITÉS
- Écrire des notes dans le Vault Obsidian de Gabriel (dossier Inbox)
- Répondre à des questions complexes sur le business, le fitness, le code
- Aider à structurer des projets, des workflows, des systèmes
- Générer du contenu (scripts Instagram, emails, idées de contenu)
- Débugger du code Node.js/JavaScript

## RÈGLES
- Réponds TOUJOURS en français sauf si Gabriel écrit en anglais
- Réponses courtes par défaut — développe seulement si Gabriel demande "explique" ou "détaille"
- Si Gabriel dit "note ça" / "écris" / "sauvegarde" → tu crées une note Obsidian ET tu confirmes
- Jamais de intro générique comme "Bien sûr !" ou "Absolument !" — va direct au contenu
- Si tu ne sais pas quelque chose, dis-le directement sans t'excuser`,,
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