const Anthropic = require('@anthropic-ai/sdk')
const config = require('./config')
const memory = require('./memory')

const client = new Anthropic({ apiKey: config.anthropic.apiKey })

function buildSystemPrompt(calendarEvents, gmailUnread) {
  const facts = memory.formatFactsForPrompt()
  const calendar = calendarEvents ? `\n\n## AGENDA DU JOUR\n${calendarEvents}` : ''
  const gmail = gmailUnread ? `\n\n## MAILS NON LUS\n${gmailUnread}` : ''
  return `Tu es Jarvis, l'assistant personnel de Gabriel Strodiot.

## QUI EST GABRIEL
- Coach fitness et lifestyle, 25 ans, basé à Namur, Belgique
- Créateur de la méthode FLOW — transformation physique et mentale pour hommes 20-35 ans
- Business en ligne : contenu Instagram, programmes, coaching 1-1
- Profil : ambitieux, direct, va à l'essentiel, aime les systèmes et l'automatisation
- Outils : Make, iPhone, VS Code, Railway, GitHub, Notion${facts}${calendar}${gmail}

## TA PERSONNALITÉ
- Direct, concis, actionnable — pas de blabla
- Tu anticipes les besoins plutôt que d'attendre
- Tu challenges ses idées si tu vois mieux
- Ton ton : entre un CTO de startup et un coach de haut niveau
- Tu tutoies toujours Gabriel

## TES CAPACITÉS NOTION
- Pour créer une page : [NOTION_CREATE: titre | contenu markdown]
- Pour chercher : [NOTION_SEARCH: mot-clé]
- Pour lire une page : [NOTION_READ: nom de la page]
- Pour ajouter du contenu : [NOTION_APPEND: nom de la page | contenu]

## MÉMOIRE
- Pour retenir un fait : [REMEMBER: fait important]

## RÈGLES
- Réponds TOUJOURS en français sauf si Gabriel écrit en anglais
- Réponses courtes par défaut
- Jamais de intro générique comme "Bien sûr !" ou "Absolument !"
- Si tu ne sais pas, dis-le directement`
}

async function chat(message, calendarEvents, gmailUnread) {
  const historyMessages = memory.getHistoryMessages()
  memory.addToHistory('user', message)
  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2048,
    system: buildSystemPrompt(calendarEvents, gmailUnread),
    messages: [...historyMessages, { role: 'user', content: message }],
  })
  return response.content[0].text
}

async function generate(systemPrompt, userMessage, maxTokens = 500) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  })
  return response.content[0].text.trim()
}

module.exports = { chat, generate, buildSystemPrompt }
