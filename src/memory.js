const db = require('./db')

let store = { facts: [], history: [] }

async function load() {
  store.facts = await db.loadFacts()
  store.history = await db.loadHistory()
  return store
}

function get() { return store }

function addToHistory(role, content) {
  const entry = { role, content, timestamp: new Date().toISOString() }
  store.history.push(entry)
  if (store.history.length > 20) store.history = store.history.slice(-20)
  db.saveMessage(role, content).catch(e => console.error('🔴 DB history save:', e.message))

  // Index RAG en temps réel — messages user uniquement
  if (role === 'user' && content.length > 40 && !content.startsWith('[IMAGE]')) {
const crypto = require('crypto')
const sourceId = 'conv_' + crypto.createHash('md5').update(content).digest('hex').slice(0, 16)    const { generateEmbedding } = require('./embeddings')
    generateEmbedding(content)
      .then(embedding => { if (embedding) db.saveEmbedding(content, embedding, 'conversation', sourceId) })
      .catch(e => console.error('🔴 RAG realtime:', e.message))
  }
}

function getHistoryMessages() {
  return store.history.slice(-10).map(h => ({ role: h.role, content: h.content }))
}

function addFact(fact) {
  const trimmed = fact.trim()
  if (trimmed && !store.facts.includes(trimmed)) {
    store.facts.push(trimmed)
    db.saveFacts(store.facts).catch(e => console.error('🔴 DB facts save:', e.message))
  }
}

// Remplace tous les facts commençant par `prefix` par `newFact`
function updateFact(prefix, newFact) {
  store.facts = store.facts.filter(f => !f.startsWith(prefix))
  const trimmed = newFact.trim()
  if (trimmed) {
    store.facts.push(trimmed)
    db.saveFacts(store.facts).catch(e => console.error('🔴 DB facts save:', e.message))
  }
}

async function persist() {
  await db.saveFacts(store.facts)
}

function formatFactsForPrompt() {
  if (!store.facts || store.facts.length === 0) return ''
  return `\n\n## CE QUE JARVIS SAIT SUR GABRIEL\n${store.facts.map(f => `- ${f}`).join('\n')}`
}

module.exports = { load, get, addToHistory, getHistoryMessages, addFact, updateFact, persist, formatFactsForPrompt }