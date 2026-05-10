const notion = require('./notion')
const db = require('./db')

let store = { facts: [], history: [] }

async function load() {
  store.facts = await notion.loadFacts()
  store.history = await db.loadHistory()
  return store
}

function get() { return store }

function addToHistory(role, content) {
  const entry = { role, content, timestamp: new Date().toISOString() }
  store.history.push(entry)
  if (store.history.length > 20) store.history = store.history.slice(-20)
  // Fire-and-forget — ne bloque pas la réponse Telegram
  db.saveMessage(role, content).catch(e => console.error('🔴 DB history save:', e.message))
}

function getHistoryMessages() {
  return store.history.slice(-10).map(h => ({ role: h.role, content: h.content }))
}

function addFact(fact) {
  if (!store.facts.includes(fact)) store.facts.push(fact)
}

async function persist() {
  await notion.saveFacts(store.facts)
  // History déjà persisté en temps réel via addToHistory → db.saveMessage
}

function formatFactsForPrompt() {
  if (!store.facts || store.facts.length === 0) return ''
  return `\n\n## MÉMOIRE LONG TERME\n${store.facts.map(f => `- ${f}`).join('\n')}`
}

module.exports = { load, get, addToHistory, getHistoryMessages, addFact, persist, formatFactsForPrompt }