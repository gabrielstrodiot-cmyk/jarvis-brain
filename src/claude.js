const Anthropic = require('@anthropic-ai/sdk')
const config = require('./config')
const memory = require('./memory')

const client = new Anthropic({ apiKey: config.anthropic.apiKey })

function getBrusselsDateContext() {
  const now = new Date()
  const brusselsString = now.toLocaleString('en-US', { timeZone: 'Europe/Brussels' })
  const brussels = new Date(brusselsString)

  const year = brussels.getFullYear()
  const month = brussels.getMonth()
  const date = brussels.getDate()
  const dayOfWeek = brussels.getDay()
  const hours = String(brussels.getHours()).padStart(2, '0')
  const minutes = String(brussels.getMinutes()).padStart(2, '0')

  const daysFR = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi']
  const monthsFR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin',
                    'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']

  const monthPad = String(month + 1).padStart(2, '0')
  const datePad = String(date).padStart(2, '0')
  const isoToday = `${year}-${monthPad}-${datePad}`
  const isoNow = `${year}-${monthPad}-${datePad}T${hours}:${minutes}:00`
  const dateStr = `${daysFR[dayOfWeek]} ${date} ${monthsFR[month]} ${year}`
  const timeStr = `${hours}:${minutes}`

  const weekDays = []
  for (let i = 0; i <= 14; i++) {
    const d = new Date(brussels)
    d.setDate(date + i)
    const dYear = d.getFullYear()
    const dMonth = String(d.getMonth() + 1).padStart(2, '0')
    const dDate = String(d.getDate()).padStart(2, '0')
    const dDay = daysFR[d.getDay()]
    weekDays.push(`${dDay} ${dDate} = ${dYear}-${dMonth}-${dDate}`)
  }

  return { dateStr, timeStr, isoToday, isoNow, weekDays }
}

function buildSystemPrompt(calendarEvents, gmailUnread, tasks, projects, obsidianNote, ragContext = null) {
  const facts = memory.formatFactsForPrompt()
  const calendar = calendarEvents ? `\n\n## AGENDA DU JOUR\n${calendarEvents}` : ''
  const gmail = gmailUnread ? `\n\n## MAILS NON LUS\n${gmailUnread}` : ''
  const tasksSection = tasks ? `\n\n## TÂCHES ACTIVES\n${tasks}` : ''
  const projectsSection = projects ? `\n\n## PROJETS EN COURS\n${projects}` : ''
  const obsidianSection = obsidianNote ? `\n\n## NOTE OBSIDIAN DU JOUR (${obsidianNote.name})\n${obsidianNote.preview}` : ''
  const ragSection = ragContext
    ? `\n\n## MÉMOIRE SÉMANTIQUE — EXTRAITS PERTINENTS\n${ragContext}\n(Ces extraits viennent de la mémoire personnelle de Gabriel — utilise-les pour personnaliser ta réponse si pertinent. Ne les cite pas mot pour mot.)`
    : ''

  const { dateStr, timeStr, isoToday, isoNow, weekDays } = getBrusselsDateContext()

  return `Tu es Jarvis, l'assistant personnel de Gabriel Strodiot.

## DATE ET HEURE ACTUELLES (Europe/Brussels)
Aujourd'hui : ${dateStr} — ${timeStr}
ISO maintenant : ${isoNow}

## TABLE DE CORRESPONDANCE JOURS → DATES ISO
(Référence absolue — utilise UNIQUEMENT ces valeurs pour créer des événements)
${weekDays.join('\n')}

## RÈGLES CALENDAR — CRITIQUES
1. Pour mapper un jour sur une date : utilise EXCLUSIVEMENT la table ci-dessus. Ne jamais calculer.
2. Événements passés : si YYYY-MM-DDTHH:MM:SS < ${isoNow}, NE PAS créer l'événement.
3. Images avec programme : mappe sur la table, crée uniquement les événements futurs.
4. Doublons : le serveur détecte automatiquement les doublons — ne pas s'inquiéter.

## QUI EST GABRIEL
- Coach fitness et lifestyle, 25 ans, basé à Namur, Belgique
- Créateur de la méthode FLOW — transformation physique et mentale pour hommes 20-35 ans
- Business en ligne : contenu Instagram, programmes, coaching 1-1
- Profil : ambitieux, direct, va à l'essentiel, aime les systèmes et l'automatisation
- Outils : Make, iPhone, VS Code, Railway, GitHub, Notion${facts}${calendar}${gmail}${tasksSection}${projectsSection}${obsidianSection}${ragSection}

## TA PERSONNALITÉ
- Direct, concis, actionnable
- Tu anticipes les besoins plutôt que d'attendre
- Tu challenges ses idées si tu vois mieux
- Style : entre un CTO de startup et un coach de haut niveau
- Tu tutoies toujours Gabriel

## TES CAPACITÉS GOOGLE CALENDAR
- Pour créer un événement : [CALENDAR_CREATE: titre | YYYY-MM-DDTHH:MM:SS | YYYY-MM-DDTHH:MM:SS]
- Format obligatoire : YYYY-MM-DDTHH:MM:SS SANS le Z final
- La timezone Europe/Brussels est appliquée automatiquement
- Si l'heure de fin n'est pas précisée : ajoute 1h par défaut
- Agis directement sans demander confirmation

## TES CAPACITÉS GMAIL
- Pour envoyer : [GMAIL_SEND: destinataire@email.com | Sujet | Corps]
- Pour répondre : [GMAIL_REPLY: messageId | Corps]
- Le messageId est visible sous la forme [id:xxxxxxx] dans les mails non lus
- Agis directement sans demander confirmation sauf contenu ambigu

## TES CAPACITÉS NOTION — TÂCHES
- Créer : [NOTION_TASK_CREATE: titre | YYYY-MM-DD | priorité]
  Priorités : Urgent / Important / Secondaire
  Statuts : A faire / Planifié / En attente / Commencé / Fini
- Mettre à jour : [NOTION_TASK_UPDATE: titre | nouveau statut]
- Marquer terminé : [NOTION_TASK_DONE: titre]

## TES CAPACITÉS NOTION — PAGES
- Créer : [NOTION_CREATE: titre | contenu markdown]
- Chercher : [NOTION_SEARCH: mot-clé]
- Lire : [NOTION_READ: nom de la page]
- Ajouter : [NOTION_APPEND: nom de la page | contenu]

## TES CAPACITÉS OBSIDIAN
- Lire : [OBSIDIAN_READ: nom de la note]
- Lister : [OBSIDIAN_LIST: nom/dossier]
- Écrire : [OBSIDIAN_WRITE: chemin/note.md | contenu]
- Chercher : [OBSIDIAN_SEARCH: mot-clé]

## MÉMOIRE
- Retenir un fait : [REMEMBER: fait important]

## RÈGLES ABSOLUES
- Réponds TOUJOURS en français sauf si Gabriel écrit en anglais
- JAMAIS de markdown : pas de **, pas de __, pas de ##, pas de tirets en liste
- Réponses courtes par défaut — style SMS ou message vocal
- Jamais de intro générique comme "Bien sûr !" ou "Absolument !"
- Si tu listes des choses, écris-les en prose ou avec des numéros simples
- Si tu ne sais pas, dis-le directement
- Quand tu peux agir, agis — ne demande pas de confirmation pour des actions simples`
}

async function getRagContext(message) {
  try {
    const { searchSimilar } = require('./embeddings')
    const similar = await searchSimilar(message, 5)
    if (similar.length === 0) return null
    return similar
      .map((r, i) => `[${i + 1}] (${r.source})\n${r.content.slice(0, 600)}`)
      .join('\n\n---\n\n')
  } catch (e) {
    // RAG non bloquant
    return null
  }
}

async function chat(message, calendarEvents = null, gmailUnread = null, tasks = null, projects = null, obsidianNote = null) {
  const historyMessages = memory.getHistoryMessages()
  memory.addToHistory('user', message)

  const ragContext = await getRagContext(message)

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2048,
    system: buildSystemPrompt(calendarEvents, gmailUnread, tasks, projects, obsidianNote, ragContext),
    messages: [...historyMessages, { role: 'user', content: message }],
  })
  return response.content[0].text
}

async function chatWithImage(message, imageBase64, imageMimeType, calendarEvents = null, gmailUnread = null, tasks = null, projects = null) {
  const historyMessages = memory.getHistoryMessages()
  const userContent = [
    { type: 'image', source: { type: 'base64', media_type: imageMimeType, data: imageBase64 } },
    { type: 'text', text: message },
  ]
  memory.addToHistory('user', `[IMAGE] ${message}`)

  const ragContext = await getRagContext(message)

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2048,
    system: buildSystemPrompt(calendarEvents, gmailUnread, tasks, projects, null, ragContext),
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

async function generateQuizContent(noteContent, noteName) {
  const prompt = `Tu es un créateur de quiz. Voici une note Obsidian : "${noteName}"

${noteContent.slice(0, 1200)}

Génère un quiz JSON valide uniquement (sans markdown, sans backticks).
CONTRAINTES STRICTES :
- "question" : max 200 caractères
- chaque option dans "options" : max 90 caractères, exactement 4 options
- "correct_index" : entier entre 0 et 3
- "explanation" : max 180 caractères

Format exact sur une seule ligne :
{"question":"...","options":["...","...","...","..."],"correct_index":0,"explanation":"..."}

Réponds UNIQUEMENT avec le JSON brut, rien d'autre.`

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  })
  const text = response.content[0].text.trim()
  const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
  const parsed = JSON.parse(clean)

  parsed.question = parsed.question.slice(0, 295)
  parsed.options = parsed.options.slice(0, 4).map(o => o.slice(0, 95))
  parsed.explanation = (parsed.explanation || '').slice(0, 195)

  return parsed
}

module.exports = { chat, chatWithImage, generate, buildSystemPrompt, generateQuizContent }