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
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/gmail.readonly',
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

async function getGmailUnread() {
  if (!config.google.refreshToken) return 'Gmail non configuré.'
  try {
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client })
    const response = await gmail.users.messages.list({ userId: 'me', q: 'is:unread is:inbox', maxResults: 5 })
    const messages = response.data.messages || []
    if (messages.length === 0) return 'Aucun mail non lu.'
    const details = await Promise.all(messages.map(async (msg) => {
      const full = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'metadata', metadataHeaders: ['From', 'Subject'] })
      const headers = full.data.payload.headers
      const from = headers.find(h => h.name === 'From')?.value || 'Inconnu'
      const subject = headers.find(h => h.name === 'Subject')?.value || 'Sans objet'
      return `- ${from} : ${subject}`
    }))
    return details.join('\n')
  } catch (e) {
    return 'Erreur Gmail : ' + e.message
  }
}

module.exports = { getAuthUrl, handleCallback, getCalendarEvents, getGmailUnread }
