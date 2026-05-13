const { google } = require('googleapis')
const config = require('./config')

const oauth2Client = new google.auth.OAuth2(
  config.google.clientId,
  config.google.clientSecret,
  config.google.redirectUri
)

if (config.google.refreshToken) {
  oauth2Client.setCredentials({ refresh_token: config.google.refreshToken })
}

function getAuthUrl() {
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
    ],
    prompt: 'consent',
  })
}

async function handleCallback(code) {
  const { tokens } = await oauth2Client.getToken(code)
  oauth2Client.setCredentials(tokens)
  return tokens
}

async function getCalendarEvents() {
  if (!config.google.refreshToken) return 'Google Calendar non configuré — visite /auth/google'
  try {
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client })
    const now = new Date()
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0)
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59)
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    })
    const events = response.data.items || []
    if (events.length === 0) return "Aucun événement aujourd'hui."
    return events.map(e => {
      const start = e.start.dateTime
        ? new Date(e.start.dateTime).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
        : 'Toute la journée'
      return `- ${start} : ${e.summary}`
    }).join('\n')
  } catch (e) {
    return 'Erreur Calendar : ' + e.message
  }
}

async function createCalendarEvent(summary, startDateTime, endDateTime, description = '') {
  if (!config.google.refreshToken) return 'Google Calendar non configuré.'
  try {
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client })

    const startDate = new Date(startDateTime)
    const dayStart = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate(), 0, 0, 0)
    const dayEnd = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate(), 23, 59, 59)

    const existing = await calendar.events.list({
      calendarId: 'primary',
      timeMin: dayStart.toISOString(),
      timeMax: dayEnd.toISOString(),
      singleEvents: true,
    })

    const duplicate = (existing.data.items || []).find(e =>
      e.summary && e.summary.toLowerCase().trim() === summary.toLowerCase().trim()
    )

    if (duplicate) {
      return `Événement déjà existant (ignoré) : ${summary}`
    }

    const event = {
      summary,
      description,
      start: {
        dateTime: startDateTime,
        timeZone: 'Europe/Brussels',
      },
      end: {
        dateTime: endDateTime,
        timeZone: 'Europe/Brussels',
      },
    }

    const response = await calendar.events.insert({
      calendarId: 'primary',
      resource: event,
    })
    return `Événement créé : ${summary} — ${response.data.htmlLink}`
  } catch (e) {
    return 'Erreur création événement : ' + e.message
  }
}

async function getGmailUnread() {
  if (!config.google.refreshToken) return 'Gmail non configuré.'
  try {
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client })
    const response = await gmail.users.messages.list({ userId: 'me', q: 'is:unread is:inbox', maxResults: 5 })
    const messages = response.data.messages || []
    if (messages.length === 0) return 'Aucun mail non lu.'
    const details = await Promise.all(messages.map(async (msg) => {
      const full = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject'],
      })
      const headers = full.data.payload.headers
      const from = headers.find(h => h.name === 'From')?.value || 'Inconnu'
      const subject = headers.find(h => h.name === 'Subject')?.value || 'Sans objet'
      return `- [id:${msg.id}] ${from} : ${subject}`
    }))
    return details.join('\n')
  } catch (e) {
    return 'Erreur Gmail : ' + e.message
  }
}

function buildRawEmail(to, subject, body, inReplyTo = null, references = null) {
  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
  ]
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`)
  if (references) lines.push(`References: ${references}`)
  lines.push('', body)
  const raw = lines.join('\r\n')
  return Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function sendEmail(to, subject, body) {
  if (!config.google.refreshToken) return 'Gmail non configuré.'
  try {
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client })
    const raw = buildRawEmail(to, subject, body)
    await gmail.users.messages.send({ userId: 'me', resource: { raw } })
    return `Mail envoyé à ${to} — "${subject}"`
  } catch (e) {
    return 'Erreur envoi mail : ' + e.message
  }
}

async function replyEmail(messageId, body) {
  if (!config.google.refreshToken) return 'Gmail non configuré.'
  try {
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client })

    // Récupère le message original pour extraire les headers nécessaires
    const original = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Message-ID', 'References'],
    })

    const headers = original.data.payload.headers
    const from = headers.find(h => h.name === 'From')?.value || ''
    const subject = headers.find(h => h.name === 'Subject')?.value || ''
    const msgId = headers.find(h => h.name === 'Message-ID')?.value || ''
    const refs = headers.find(h => h.name === 'References')?.value || ''
    const threadId = original.data.threadId

    const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`
    const references = refs ? `${refs} ${msgId}` : msgId

    const raw = buildRawEmail(from, replySubject, body, msgId, references)

    await gmail.users.messages.send({
      userId: 'me',
      resource: { raw, threadId },
    })
    return `Réponse envoyée à ${from} — "${replySubject}"`
  } catch (e) {
    return 'Erreur réponse mail : ' + e.message
  }
}

module.exports = {
  getAuthUrl,
  handleCallback,
  getCalendarEvents,
  createCalendarEvent,
  getGmailUnread,
  sendEmail,
  replyEmail,
}
