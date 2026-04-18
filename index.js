require('dotenv').config()
const express = require('express')
const Anthropic = require('@anthropic-ai/sdk')
const fs = require('fs')
const path = require('path')

const app = express()
app.use(express.json())

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const VAULT_PATH = process.env.VAULT_PATH
const MEMORY_FILE = path.join(__dirname, 'memory.json')

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
  memory.history.push({
    role,
    content,
    timestamp: new Date().toISOString()
  })
  // Garde les 20 derniers échanges seulement
  if (memory.history.length > 20) {
    memory.history = memory.history.slice(-20)
  }
}

function buildHistoryMessages(memory) {
  // Retourne les 10 derniers pour le contexte Claude
  return memory.history.slice(-10).map(h => ({
    role: h.role,
    content: h.content
  }))
}

function formatFactsForPrompt(memory) {
  if (!memory.facts || memory.facts.length === 0) return ''
  return `\n\n## MÉMOIRE LONG TERME\nFaits importants retenus sur Gabriel :\n${memory.facts.map(f => `- ${f}`).join('\n')}`
}

// ── VAULT HELPERS ──────────────────────────────────────────────

function writeNote(filename, content) {
  const inboxPath = path.join(VAULT_PATH, '00_Jarvis', 'Inbox')
  if (!fs.existsSync(inboxPath)) fs.mkdirSync(inboxPath, { recursive: true })
  const filepath = path.join(inboxPath, filename)
  fs.writeFileSync(filepath, content, 'utf8')
  return filepath
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

function buildSystemPrompt(memory) {
  const facts = formatFactsForPrompt(memory)
  return `Tu es Jarvis, l'assistant personnel de Gabriel Strodiot.

## QUI EST GABRIEL
- Coach fitness et lifestyle, 25 ans, basé en Belgique
- Créateur de la méthode FLOW — transformation physique et mentale pour hommes 20-35 ans
- Business en ligne : contenu Instagram, programmes, coaching 1-1
- Vault Obsidian : son second cerveau (notes, idées, projets, systèmes)
- Profil : ambitieux, direct, va à l'essentiel, aime les systèmes et l'automatisation
- Outils : Make/Zapier, iPhone, VS Code, Railway, GitHub${facts}

## TA PERSONNALITÉ
- Direct, concis, actionnable — pas de blabla, pas de listes inutiles
- Tu anticipes les besoins plutôt que d'attendre
- Tu peux challenger ses idées si tu vois mieux
- Ton ton : entre un CTO de startup et un coach de haut niveau
- Tu tutoies toujours Gabriel

## TES CAPACITÉS VAULT
- Pour écrire une note : [WRITE_NOTE: titre]
- Pour lire les notes récentes : [LIST_NOTES]
- Pour chercher dans le vault : [SEARCH_NOTES: mot-clé]

## MÉMOIRE
- Pour retenir un fait important sur Gabriel : [REMEMBER: fait à retenir]
- Tu peux combiner plusieurs commandes dans une même réponse
- Utilise [REMEMBER: ...] quand Gabriel mentionne quelque chose d'important (projet, objectif, préférence, décision)

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

  // Contexte vault
  let vaultContext = ''
  try {
    const recentNotes = listRecentNotes(3)
    if (recentNotes.length > 0) {
      vaultContext = ` [Vault — notes récentes : ${recentNotes.join(', ')}]`
    }
  } catch (e) {}

  // Construit les messages avec historique
  const historyMessages = buildHistoryMessages(memory)
  const currentMessage = message + vaultContext

  // Ajoute le message user à l'historique
  addToHistory(memory, 'user', message)

  try {
    const response = await claude.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system: buildSystemPrompt(memory),
      messages: [...historyMessages, { role: 'user', content: currentMessage }]
    })

    let reply = response.content[0].text
    let noteCreated = null

    // ── Traite REMEMBER ──
    const rememberMatches = [...reply.matchAll(/\[REMEMBER:\s*(.+?)\]/gi)]
    for (const match of rememberMatches) {
      const fact = match[1].trim()
      if (!memory.facts.includes(fact)) {
        memory.facts.push(fact)
      }
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
      reply = cleanReply + `\n\n📝 Note créée : \`${filename}\``
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

    reply = reply.trim()

    // Ajoute la réponse à l'historique et sauvegarde
    addToHistory(memory, 'assistant', reply)
    saveMemory(memory)

    res.json({
      reply,
      model: 'claude-sonnet-4-5',
      timestamp: new Date().toISOString(),
      noteCreated,
      factsCount: memory.facts.length
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

// ── SANTÉ ──────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'Jarvis is alive 🤖', timestamp: new Date().toISOString() })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`🤖 Jarvis Brain démarré sur le port ${PORT}`)
  console.log(`📁 Vault Obsidian : ${VAULT_PATH}`)
  console.log(`🧠 Mémoire : ${MEMORY_FILE}`)
})// redeploy sam. 18 avr. 2026 08:26:36 CEST
