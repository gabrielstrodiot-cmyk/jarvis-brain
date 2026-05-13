const Anthropic = require('@anthropic-ai/sdk')
const config = require('./config')
const memory = require('./memory')

const client = new Anthropic({ apiKey: config.anthropic.apiKey })

// Calcul date Brussels sans dépendance locale (compatible Railway Linux)
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

  // 14 prochains jours pour couvrir la semaine en cours + suivante
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

function buildSystemPrompt(calendarEvents, gmailUnread, tasks, projects, obsidianNote) {
  const facts = memory.formatFactsForPrompt()
  const calendar = calendarEvents ? `\n\n## AGENDA DU JOUR\n${calendarEvents}` : ''
  const gmail = gmailUnread ? `\n\n## MAILS NON LUS\n${gmailUnread}` : ''
  const tasksSection = tasks ? `\n\n## TÂCHES ACTIVES\n${tasks}` : ''
  const projectsSection = projects ? `\n\n## PROJETS EN COURS\n${projects}` : ''
  const obsidianSection = obsidianNote ? `\n\n## NOTE OBSIDIAN DU JOUR (${obsidianNote.name})\n${obsidianNote.preview}` : ''

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

2. Événements passés : si YYYY-MM-DDTHH:MM:SS < ${isoNow}, NE PAS créer l'événement. L'ignorer silencieusement. Ne pas le reporter au lendemain. Ne pas mentionner qu'il a été ignoré sauf si Gabriel le demande.

3. Images avec programme : lis les noms de jours et heures dans l'image, mappe sur la table, crée uniquement les événements futurs. Ignore toute date ISO visible dans l'image — seule la table compte.

4. Doublons : le serveur détecte automatiquement les doublons par titre+jour. Si un événement existe déjà, il sera ignoré côté serveur. Ne pas s'inquiéter des doublons.

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
- Pour créer un événement : [CALENDAR_CREATE: titre | YYYY-MM-DDTHH:MM:SS | YYYY-MM-DDTHH:MM:SS]
- Pour créer avec description : [CALENDAR_CREATE: titre | YYYY-MM-DDTHH:MM:SS | YYYY-MM-DDTHH:MM:SS | description]
- Format obligatoire : YYYY-MM-DDTHH:MM:SS SANS le Z final (ex: 2026-05-13T18:00:00)
- La timezone Europe/Brussels est appliquée automatiquement
- Plusieurs événements : répète le tag autant de fois que nécessaire
- Si l'heure de fin n'est pas précisée : ajoute 1h par défaut
- Agis directement sans demander confirmation

## TES CAPACITÉS GMAIL
- Pour envoyer un nouveau mail : [GMAIL_SEND: destinataire@email.com | Sujet | Corps du message]
- Pour répondre à un mail existant : [GMAIL_REPLY: messageId | Corps de la réponse]
- Le messageId est visible dans les mails non lus sous la forme [id:xxxxxxx]
- Corps sur plusieurs lignes : écris le texte normalement, les sauts de ligne sont préservés
- Agis directement sans demander confirmation sauf si le contenu du message est ambigu
- Exemple envoi : [GMAIL_SEND: jean@example.com | Confirmation RDV demain | Salut Jean, je confirme pour demain à 14h. À demain.]
- Exemple réponse : [GMAIL_REPLY: 18f3a2b1c4d5e6f7 | Parfait, je serai là à 18h.]

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

async function chatWithImage(message, imageBase64, imageMimeType, calendarEvents = null, gmailUnread = null, tasks = null, projects = null) {
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

  memory.addToHistory('user', `[IMAGE] ${message}`)

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2048,
    system: buildSystemPrompt(calendarEvents, gmailUnread, tasks, projects, null),
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
