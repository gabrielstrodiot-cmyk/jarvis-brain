const notion = require('./notion')

let store = { facts: [], history: [] }

async function load() {
  store.facts = await notion.loadFacts()
  return store
}

function get() { return store }

function addToHistory(role, content) {
  store.history.push({ role, content, timestamp: new Date().toISOString() })
  if (store.history.length > 20) store.history = store.history.slice(-20)
}

function getHistoryMessages() {
  return store.history.slice(-10).map(h => ({ role: h.role, content: h.content }))
}

function addFact(fact) {
  if (!store.facts.includes(fact)) store.facts.push(fact)
}

async function persist() { await notion.saveFacts(store.facts) }

function formatFactsForPrompt() {
  if (!store.facts || store.facts.length === 0) return ''
  return `\n\n## MÉMOIRE LONG TERME\n${store.facts.map(f => `- ${f}`).join('\n')}`
}

module.exports = { load, get, addToHistory, getHistoryMessages, addFact, persist, formatFactsForPrompt }
