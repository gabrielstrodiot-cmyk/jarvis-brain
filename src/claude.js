const Anthropic = require('@anthropic-ai/sdk')
const config = require('./config')
const memory = require('./memory')

const client = new Anthropic({ apiKey: config.anthropic.apiKey })

function buildSystemPrompt(calendarEvents, gmailUnread, tasks, projects, obsidianNote) {
  const facts = memory.formatFactsForPrompt()
  const calendar = calendarEvents ? `\n\n## AGENDA DU JOUR\n${calendarEvents}` : ''
  const gmail = gmailUnread ? `\n\n## MAILS NON LUS\n${gmailUnread}` : ''
  const tasksSection = tasks ? `\n\n## TÂCHES ACTIVES\n${tasks}` : ''
  const projectsSection = projects ? `\n\n## PROJETS EN COURS\n${projects}` : ''
  const obsidianSection = obsidianNote ? `\n\n## NOTE OBSIDIAN DU JOUR (${obsidianNote.name})\n${obsidianNote.preview}` : ''

  return `Tu es Jarvis, l'assistant personnel de Gabriel Strodiot.

## QUI EST GABRIEL
- Coach fitness et lifestyle, 25 ans, basé à Namur, Belgique
- Créateur de la méthode FLOW — transformation physique et mentale pour hommes 20-35 ans
- Business en ligne : contenu Instagram, programmes, coaching 1-1
- Profil : ambitieux, direct, va à l'essentiel, aime les systèmes et l'automatisation
- Outils : Make, iPhone, VS Code, Railway, GitHub, Notion${facts}${calendar}${gmail}${tasksSection}${projectsSection}${obsidianSection}

## TA PERSONNALITÉ
- Direct, concis, actionnable
- Tu anticipes les besoins plutôt que d'attendre
- Tu challenges ses idées si tu vois mieux
- Style : entre un CTO de startup et un coach de haut niveau
- Tu tutoies toujours Gabriel

## TES CAPACITÉS GOOGLE CALENDAR
- Pour créer un événement : [CALENDAR_CREATE: titre | 2026-05-13T18:00:00 | 2026-05-13T19:00:00]
- Pour créer un événement avec description : [CALENDAR_CREATE: titre | 2026-05-13T18:00:00 | 2026-05-13T19:00:00 | description]
- Les dates DOIVENT être au format ISO 8601 complet : YYYY-MM-DDTHH:MM:SS
- La timezone est automatiquement Europe/Brussels
- Tu peux créer plusieurs événements en une seule réponse en répétant le tag
- Quand Gabriel donne une liste d'événements, crée-les TOUS directement sans demander confirmation

## TES CAPACITÉS NOTION
- Pour créer une page : [NOTION_CREATE: titre | contenu markdown]
- Pour chercher : [NOTION_SEARCH: mot-clé]
- Pour lire une page : [NOTION_READ: nom de la page]
- Pour ajouter du contenu : [NOTION_APPEND: nom de la page | contenu]

## TES CAPACITÉS OBSIDIAN
- Pour lire une note : [OBSIDIAN_READ: nom de la note]
- Pour lister un dossier : [OBSIDIAN_LIST: nom/dossier]
- Pour créer ou modifier une note : [OBSIDIAN_WRITE: chemin/note.md | contenu]
- Pour chercher dans le vault : [OBSIDIAN_SEARCH: mot-clé]

## MÉMOIRE
- Pour retenir un fait : [REMEMBER: fait important]

## RÈGLES ABSOLUES
- Réponds TOUJOURS en français sauf si Gabriel écrit en anglais
- JAMAIS de markdown : pas de **, pas de __, pas de ##, pas de tirets en liste
- Réponses courtes par défaut — style SMS ou message vocal
- Jamais de intro générique comme "Bien sûr !" ou "Absolument !"
- Si tu listes des choses, écris-les en prose ou avec des numéros simples
- Si tu ne sais pas, dis-le directement
- Quand tu peux agir, agis — ne demande pas de confirmation pour des actions simples et claires`
}

async function chat(message, calendarEvents = null, gmailUnread = null, tasks = null, projects = null, obsidianNote = null) {
  const historyMessages = memory.getHistoryMessages()
  memory.addToHistory('user', message)
  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2048,
    system: buildSystemPrompt(calendarEvents, gmailUnread, tasks, projects, obsidianNote),
    messages: [...historyMessages, { role: 'user', content: message }],
  })
  return response.content[0].text
}

async function chatWithImage(message, imageBase64, imageMimeType, calendarEvents = null, gmailUnread = null) {
  const historyMessages = memory.getHistoryMessages()

  const userContent = [
    {
      type: 'image',
      source: {
        type: 'base64',
        media_type: imageMimeType,
        data: imageBase64,
      },
    },
    {
      type: 'text',
      text: message,
    },
  ]

  // On stocke le texte dans l'historique (pas le base64 — trop lourd)
  memory.addToHistory('user', `[IMAGE] ${message}`)

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2048,
    system: buildSystemPrompt(calendarEvents, gmailUnread, null, null, null),
    messages: [...historyMessages, { role: 'user', content: userContent }],
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

module.exports = { chat, chatWithImage, generate, buildSystemPrompt }
