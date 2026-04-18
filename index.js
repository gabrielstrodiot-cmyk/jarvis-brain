require('dotenv').config()
const express = require('express')
const Anthropic = require('@anthropic-ai/sdk')
const fs = require('fs')
const path = require('path')

const app = express()
app.use(express.json())

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const VAULT_PATH = process.env.VAULT_PATH

// ── VAULT HELPERS ──────────────────────────────────────────────

function writeNote(filename, content) {
  const inboxPath = path.join(VAULT_PATH, '00_Jarvis', 'Inbox')
  if (!fs.existsSync(inboxPath)) fs.mkdirSync(inboxPath, { recursive: true })
  const filepath = path.join(inboxPath, filename)
  fs.writeFileSync(filepath, content, 'utf8')
  return filepath
}

function readNote(filename) {
  const inboxPath = path.join(VAULT_PATH, '00_Jarvis', 'Inbox')
  const filepath = path.join(inboxPath, filename)
  if (!fs.existsSync(filepath)) return null
  return fs.readFileSync(filepath, 'utf8')
}

function listRecentNotes(n = 5) {
  const inboxPath = path.join(VAULT_PATH, '00_Jarvis', 'Inbox')
  if (!fs.existsSync(inboxPath)) return []
  return fs.readdirSync(inboxPath)
    .filter(f => f.endsWith('.md'))
    .map(f => ({
      name: f,
      modified: fs.statSync(path.join(inboxPath, f)).mtime
    }))
    .sort((a, b) => b.modified - a.modified)
    .slice(0, n)
    .map(f => f.name)
}

function searchNotes(query) {
  const inboxPath = path.join(VAULT_PATH, '00_Jarvis', 'Inbox')
  if (!fs.existsSync(inboxPath)) return []
  const results = []
  const files = fs.readdirSync(inboxPath).filter(f => f.endsWith('.md'))
  for (const file of files) {
    const content = fs.readFileSync(path.join(inboxPath, file), 'utf8')
    if (content.toLowerCase().includes(query.toLowerCase()) ||
        file.toLowerCase().includes(query.toLowerCase())) {
      results.push({ file, preview: content.slice(0, 200) })
    }
  }
  return results
}

// ── SYSTEM PROMPT ──────────────────────────────────────────────

const SYSTEM_PROMPT = `Tu es Jarvis, l'assistant personnel de Gabriel Strodiot.

## QUI EST GABRIEL
- Coach fitness et lifestyle, 25 ans, basé en Belgique
- Créateur de la méthode FLOW — transformation physique et mentale pour hommes 20-35 ans
- Business en ligne : contenu Instagram, programmes, coaching 1-1
- Vault Obsidian : son second cerveau (notes, idées, projets, systèmes)
- Profil : ambitieux, direct, va à l'essentiel, aime les systèmes et l'automatisation
- Outils : Make/Zapier, iPhone, VS Code, Railway, GitHub

## TA PERSONNALITÉ
- Direct, concis, actionnable — pas de blabla, pas de listes inutiles
- Tu anticipes les besoins plutôt que d'attendre
- Tu peux challenger ses idées si tu vois mieux
- Ton ton : entre un CTO de startup et un coach de haut niveau
- Tu tutoies toujours Gabriel

## TES CAPACITÉS VAULT
- Pour écrire une note : réponds avec [WRITE_NOTE: titre du sujet] sur une ligne seule
- Pour lire les notes récentes : réponds avec [LIST_NOTES] sur une ligne seule
- Pour chercher dans le vault : réponds avec [SEARCH_NOTES: mot-clé] sur une ligne seule
- Tu peux combiner une commande vault ET du texte dans ta réponse

## RÈGLES
- Réponds TOUJOURS en français sauf si Gabriel écrit en anglais
- Réponses courtes par défaut — développe seulement si demandé
- Si Gabriel dit "note ça" / "écris" / "sauvegarde" → utilise [WRITE_NOTE: ...]
- Jamais de intro générique comme "Bien sûr !" ou "Absolument !"
- Si tu ne sais pas quelque chose, dis-le directement sans t'excuser`

// ── ROUTE PRINCIPALE ───────────────────────────────────────────

app.post('/chat', async (req, res) => {
  const { message } = req.body
  if (!message) return res.status(400).json({ error: 'Message requis' })

  // Contexte vault injecté dans chaque requête
  let vaultContext = ''
  try {
    const recentNotes = listRecentNotes(3)
    if (recentNotes.length > 0) {
      vaultContext = `\n\n[Contexte vault — notes récentes dans ton Inbox : ${recentNotes.join(', ')}]`
    }
  } catch (e) { /* vault non accessible (prod) */ }

  try {
    const response = await claude.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: message + vaultContext }]
    })

    let reply = response.content[0].text
    let noteCreated = null

    // Détecte commande WRITE_NOTE
    const writeMatch = reply.match(/\[WRITE_NOTE:\s*(.+?)\]/i)
    if (writeMatch) {
      const title = writeMatch[1].trim()
      const date = new Date().toISOString().split('T')[0]
      const time = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
      const cleanReply = reply.replace(/\[WRITE_NOTE:[^\]]+\]/i, '').trim()
      const noteContent = `# ${title}\n\n${cleanReply}\n\n---\n*Créé par Jarvis le ${date} à ${time}*`
      const filename = `${date}-${title.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')}.md`
      writeNote(filename, noteContent)
      noteCreated = filename
      reply = cleanReply + `\n\n📝 Note créée : \`${filename}\``
    }

    // Détecte commande LIST_NOTES
    if (reply.includes('[LIST_NOTES]')) {
      const notes = listRecentNotes(5)
      const listText = notes.length > 0 ? notes.join('\n- ') : 'Aucune note trouvée'
      reply = reply.replace('[LIST_NOTES]', `Notes récentes :\n- ${listText}`)
    }

    // Détecte commande SEARCH_NOTES
    const searchMatch = reply.match(/\[SEARCH_NOTES:\s*(.+?)\]/i)
    if (searchMatch) {
      const results = searchNotes(searchMatch[1].trim())
      const searchText = results.length > 0
        ? results.map(r => `**${r.file}** : ${r.preview}...`).join('\n\n')
        : 'Aucune note trouvée pour cette recherche'
      reply = reply.replace(/\[SEARCH_NOTES:[^\]]+\]/i, searchText)
    }

    res.json({ reply, model: 'claude-sonnet-4-5', timestamp: new Date().toISOString(), noteCreated })

  } catch (error) {
    console.error('Erreur Claude:', error)
    res.status(500).json({ error: error.message })
  }
})

// ── ROUTES VAULT DIRECTES ──────────────────────────────────────

app.get('/vault/notes', (req, res) => {
  try {
    const notes = listRecentNotes(20)
    res.json({ notes })
  } catch (e) {
    res.status(500).json({ error: 'Vault non accessible' })
  }
})

app.get('/vault/read/:filename', (req, res) => {
  try {
    const content = readNote(req.params.filename)
    if (!content) return res.status(404).json({ error: 'Note introuvable' })
    res.json({ filename: req.params.filename, content })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── SANTÉ ──────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'Jarvis is alive 🤖', timestamp: new Date().toISOString() })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`🤖 Jarvis Brain démarré sur le port ${PORT}`)
  console.log(`📁 Vault Obsidian : ${VAULT_PATH}`)
})