const TelegramBot = require('node-telegram-bot-api')
const fetch = require('node-fetch')
const fs = require('fs')
const path = require('path')
const os = require('os')
const cron = require('node-cron')
const FormData = require('form-data')
const config = require('../config')
const claudeClient = require('../claude')
const memory = require('../memory')
const actions = require('../actions')
const db = require('../db')
const { getCalendarEvents, getGmailUnread } = require('../google')
const notion = require('../notion')
const obsidian = require('../obsidian')

const bot = new TelegramBot(config.telegram.botToken, { polling: true })
let GABRIEL_CHAT_ID = process.env.TELEGRAM_CHAT_ID || null

// ── WHITELIST ─────────────────────────────────────────────────
const ALLOWED_USER_ID = parseInt(process.env.TELEGRAM_ALLOWED_USER_ID)

function isAuthorized(msg) {
  const userId = msg?.from?.id
  if (userId !== ALLOWED_USER_ID) {
    console.log(`🚫 Accès non autorisé — user ID: ${userId}`)
    return false
  }
  return true
}

console.log('🤖 Telegram bot démarré — @jarvis_strodiot_bot')

// ── MÉTÉO OPEN-METEO (sans clé API) ──────────────────────────
function weatherCodeToText(code) {
  if (code === 0) return 'ciel dégagé'
  if (code <= 3) return 'partiellement nuageux'
  if (code <= 48) return 'brouillard'
  if (code <= 55) return 'bruine'
  if (code <= 65) return 'pluie'
  if (code <= 75) return 'neige'
  if (code <= 82) return 'averses'
  if (code <= 99) return 'orage'
  return 'conditions inconnues'
}

async function getWeather(lat, lon) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,precipitation,weathercode,windspeed_10m&timezone=Europe%2FBrussels`
    const res = await fetch(url)
    if (!res.ok) return null
    const data = await res.json()
    const c = data.current
    return `${Math.round(c.temperature_2m)}°C, ${weatherCodeToText(c.weathercode)}, vent ${Math.round(c.windspeed_10m)} km/h`
  } catch (e) {
    console.error('getWeather error:', e.message)
    return null
  }
}

function getPositionFromMemory() {
  const store = memory.get()
  const posFact = store.facts.find(f => f.startsWith('POSITION_GPS:'))
  if (!posFact) return null
  const parts = posFact.replace('POSITION_GPS:', '').split('|')
  if (parts.length < 2) return null
  return {
    lat: parseFloat(parts[0]),
    lon: parseFloat(parts[1]),
    city: parts[2] || 'ta position'
  }
}

// ── HTML SÉCURISÉ POUR LE BRIEFING ───────────────────────────
// Échappe tout, puis restaure uniquement <b> et </b>
function sanitizeBriefingHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/&lt;b&gt;/g, '<b>')
    .replace(/&lt;\/b&gt;/g, '</b>')
}

// ── NETTOYAGE TEXTE POUR ELEVENLABS ──────────────────────────
function cleanForVoice(text) {
  return text
    .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')
    .replace(/[\u{2600}-\u{26FF}]/gu, '')
    .replace(/[\u{2700}-\u{27BF}]/gu, '')
    .replace(/[✅❌📄🔗📝🤖🎙️⚠️🌅]/g, '')
    .replace(/\*\*/g, '')
    .replace(/#{1,3} /g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\n\n/g, '. ')
    .replace(/\n/g, ', ')
    .replace(/[^\x00-\x7F\u00C0-\u024F\u1E00-\u1EFF]/g, '')
    .trim()
}

// ── TRANSCRIPTION WHISPER ─────────────────────────────────────
async function transcribeAudio(filePath) {
  const form = new FormData()
  form.append('file', fs.createReadStream(filePath), {
    filename: 'audio.ogg',
    contentType: 'audio/ogg',
  })
  form.append('model', 'whisper-1')
  form.append('language', 'fr')

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.openai.apiKey}`, ...form.getHeaders() },
    body: form,
  })
  if (!response.ok) throw new Error(`Whisper error: ${await response.text()}`)
  const data = await response.json()
  return data.text
}

// ── SYNTHÈSE ELEVENLABS ───────────────────────────────────────
async function synthesize(text) {
  const cleanText = cleanForVoice(text)
  if (!cleanText || cleanText.length < 3) throw new Error('Texte vide après nettoyage')

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${config.elevenlabs.voiceId}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': config.elevenlabs.apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text: cleanText,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true },
      }),
    }
  )
  if (!response.ok) throw new Error(`ElevenLabs error: ${await response.text()}`)
  return response.buffer()
}

async function sendVoiceReply(chatId, text) {
  try {
    const audioBuffer = await synthesize(text)
    const tmpAudio = path.join(os.tmpdir(), `jarvis_${Date.now()}.mp3`)
    fs.writeFileSync(tmpAudio, audioBuffer)
    await bot.sendVoice(chatId, tmpAudio)
    fs.unlinkSync(tmpAudio)
  } catch (e) {
    console.error('ElevenLabs error:', e.message)
  }
}

// ── TRAITEMENT MESSAGE TEXTE ──────────────────────────────────
async function handleMessage(chatId, text) {
  if (!GABRIEL_CHAT_ID) {
    GABRIEL_CHAT_ID = chatId
    console.log(`📱 Chat ID Gabriel enregistré : ${chatId}`)
  }

  await memory.load()
  const [calendarEvents, gmailUnread] = await Promise.all([
    getCalendarEvents(),
    getGmailUnread(),
  ])

  const rawReply = await claudeClient.chat(text, calendarEvents, gmailUnread)
  const { text: processedReply, fetchedData } = await actions.processReply(rawReply)

  let finalReply = processedReply

  if (fetchedData && Object.keys(fetchedData).length > 0) {
    const dataContext = Object.values(fetchedData).join('\n\n')
    const synthesisPrompt = `Gabriel a demandé : "${text}"\n\nDonnées récupérées :\n\n${dataContext}\n\nRéponds à Gabriel de façon naturelle et concise.`
    finalReply = await claudeClient.generate(
      claudeClient.buildSystemPrompt(calendarEvents, gmailUnread),
      synthesisPrompt,
      1000
    )
  }

  memory.addToHistory('assistant', finalReply)
  await memory.persist()

  return finalReply
}

// ── TRAITEMENT IMAGE ──────────────────────────────────────────
async function handleImageMessage(chatId, caption, imageBase64, imageMimeType) {
  if (!GABRIEL_CHAT_ID) {
    GABRIEL_CHAT_ID = chatId
    console.log(`📱 Chat ID Gabriel enregistré : ${chatId}`)
  }

  await memory.load()
  const [calendarEvents, gmailUnread] = await Promise.all([
    getCalendarEvents(),
    getGmailUnread(),
  ])

  const rawReply = await claudeClient.chatWithImage(caption, imageBase64, imageMimeType, calendarEvents, gmailUnread)
  const { text: processedReply, fetchedData } = await actions.processReply(rawReply)

  let finalReply = processedReply

  if (fetchedData && Object.keys(fetchedData).length > 0) {
    const dataContext = Object.values(fetchedData).join('\n\n')
    const synthesisPrompt = `Gabriel a envoyé une image avec le message : "${caption}"\n\nDonnées récupérées :\n\n${dataContext}\n\nRéponds à Gabriel de façon naturelle et concise.`
    finalReply = await claudeClient.generate(
      claudeClient.buildSystemPrompt(calendarEvents, gmailUnread),
      synthesisPrompt,
      1000
    )
  }

  memory.addToHistory('assistant', finalReply)
  await memory.persist()

  return finalReply
}

// ── ENVOI QUIZ POLL ───────────────────────────────────────────
async function sendQuizPoll(chatId, note) {
  try {
    console.log(`📚 Génération quiz pour : ${note.name}`)
    const quiz = await claudeClient.generateQuizContent(note.content, note.name)

    const label = note.isNew ? '📚 Nouvelle note' : '📚 Révision du jour'
    await bot.sendMessage(chatId, `${label} — <b>${note.name}</b>`, { parse_mode: 'HTML' })

    await bot.sendPoll(
      chatId,
      quiz.question,
      quiz.options,
      {
        type: 'quiz',
        correct_option_id: quiz.correct_index,
        explanation: quiz.explanation,
        is_anonymous: false
      }
    )

    await db.logQuizNote(note.path)
    console.log(`✅ Quiz envoyé — ${note.name}`)
  } catch (e) {
    console.error('sendQuizPoll error:', e.message)
    // Fallback silencieux — le quiz ne bloque pas le briefing
  }
}

// ── MORNING BRIEFING ──────────────────────────────────────────
async function sendMorningBriefing() {
  const chatId = GABRIEL_CHAT_ID || process.env.TELEGRAM_CHAT_ID
  if (!chatId) {
    console.log('⚠️  Morning briefing : chat ID inconnu')
    return
  }

  try {
    console.log('🌅 Envoi morning briefing...')
    await memory.load()

    // Position et météo
    const position = getPositionFromMemory()
    let weatherLine = null
    if (position) {
      weatherLine = await getWeather(position.lat, position.lon)
    }

    const weatherSection = weatherLine
      ? `${weatherLine} à ${position.city}`
      : 'Position inconnue — envoie ta localisation Telegram pour activer la météo'

    // Fetch toutes les données en parallèle
    const [calendarEvents, gmailUnread, tasks, projects, recentlyTestedPaths] = await Promise.all([
      getCalendarEvents(),
      getGmailUnread(),
      notion.getActiveTasks(),
      notion.getActiveProjects(),
      db.getRecentlyTestedPaths(7),
    ])

    const prompt = `Génère mon morning briefing du jour.

FORMAT OBLIGATOIRE — HTML Telegram uniquement :
- Titres de section : <b>Nom</b>
- Listes : tirets (-)
- Aucune autre balise HTML
- Aucun markdown (**, ##, etc.)
- Max 300 mots

SECTIONS dans cet ordre :
<b>Météo</b> : ${weatherSection}
<b>Agenda aujourd'hui</b> : depuis les données calendar
<b>Agenda demain</b> : depuis les données calendar
<b>Mails</b> : seulement les importants, sinon omets cette section
<b>Tâches prioritaires</b> : top 3 max
<b>Projets actifs</b> : état en une ligne chacun
<b>Morning routine</b> : rappel bref et direct`

    const rawReply = await claudeClient.chat(prompt, calendarEvents, gmailUnread, tasks, projects, null)
    const { text: reply } = await actions.processReply(rawReply)
    const safeHtml = sanitizeBriefingHtml(reply)

    await bot.sendMessage(chatId, `🌅 <b>Morning Briefing</b>\n\n${safeHtml}`, { parse_mode: 'HTML' })
    console.log('✅ Morning briefing envoyé')

    // Quiz séparé (fire-and-forget sur le briefing)
    const note = await obsidian.getNoteForQuiz(recentlyTestedPaths)
    if (note) {
      await sendQuizPoll(chatId, note)
    } else {
      console.log('ℹ️  Pas de note disponible pour le quiz')
    }

  } catch (e) {
    console.error('Morning briefing error:', e.message)
    try {
      await bot.sendMessage(chatId, `Erreur briefing : ${e.message}`)
    } catch {}
  }
}

// ── CRON 06h30 Europe/Brussels ────────────────────────────────
cron.schedule('30 6 * * *', () => {
  sendMorningBriefing()
}, { timezone: 'Europe/Brussels' })

console.log('⏰ Morning briefing programmé à 06h30 (Europe/Brussels)')

// ── MESSAGES TEXTE ────────────────────────────────────────────
bot.on('message', async (msg) => {
  if (!isAuthorized(msg)) return
  const chatId = msg.chat.id
  if (!msg.text || msg.voice || msg.audio) return

  try {
    await bot.sendChatAction(chatId, 'typing')
    const reply = await handleMessage(chatId, msg.text)
    await bot.sendMessage(chatId, reply)
  } catch (e) {
    console.error('Message error:', e.message)
    await bot.sendMessage(chatId, `Erreur : ${e.message}`)
  }
})

// ── MESSAGES VOCAUX ───────────────────────────────────────────
bot.on('voice', async (msg) => {
  if (!isAuthorized(msg)) return
  const chatId = msg.chat.id
  try {
    await bot.sendChatAction(chatId, 'typing')

    const fileId = msg.voice.file_id
    const fileInfo = await bot.getFile(fileId)
    const fileUrl = `https://api.telegram.org/file/bot${config.telegram.botToken}/${fileInfo.file_path}`

    const tmpFile = path.join(os.tmpdir(), `tg_voice_${Date.now()}.ogg`)
    const audioRes = await fetch(fileUrl)
    const buffer = await audioRes.buffer()
    fs.writeFileSync(tmpFile, buffer)

    const transcript = await transcribeAudio(tmpFile)
    fs.unlinkSync(tmpFile)

    if (!transcript || transcript.trim().length === 0) {
      return bot.sendMessage(chatId, 'Audio inaudible, reessaie.')
    }

    const reply = await handleMessage(chatId, transcript)
    await bot.sendMessage(chatId, reply)
  } catch (e) {
    console.error('Voice error:', e.message)
    await bot.sendMessage(chatId, `Erreur : ${e.message}`)
  }
})

// ── PHOTOS ────────────────────────────────────────────────────
bot.on('photo', async (msg) => {
  if (!isAuthorized(msg)) return
  const chatId = msg.chat.id
  try {
    await bot.sendChatAction(chatId, 'typing')

    const photo = msg.photo[msg.photo.length - 1]
    const caption = msg.caption || 'Analyse cette image et dis-moi ce que tu vois.'

    const fileInfo = await bot.getFile(photo.file_id)
    const fileUrl = `https://api.telegram.org/file/bot${config.telegram.botToken}/${fileInfo.file_path}`

    const imgRes = await fetch(fileUrl)
    const buffer = await imgRes.buffer()
    const base64 = buffer.toString('base64')

    const ext = path.extname(fileInfo.file_path).toLowerCase()
    const mimeType = ext === '.png' ? 'image/png'
                   : ext === '.webp' ? 'image/webp'
                   : 'image/jpeg'

    console.log(`🖼️  Photo reçue — ${photo.width}x${photo.height} — caption: "${caption}"`)

    const reply = await handleImageMessage(chatId, caption, base64, mimeType)
    await bot.sendMessage(chatId, reply)
  } catch (e) {
    console.error('Photo error:', e.message)
    await bot.sendMessage(chatId, `Erreur : ${e.message}`)
  }
})

// ── LOCALISATION GPS ──────────────────────────────────────────
bot.on('location', async (msg) => {
  if (!isAuthorized(msg)) return
  const chatId = msg.chat.id

  if (!GABRIEL_CHAT_ID) GABRIEL_CHAT_ID = chatId

  try {
    const { latitude, longitude } = msg.location
    await memory.load()

    // Reverse geocode léger via open-meteo (pas de clé nécessaire)
    // On stocke juste les coordonnées — la ville sera "ta position"
    // Pour avoir le nom de ville, on utilise l'API nominatim (OpenStreetMap, gratuite)
    let cityName = 'ta position'
    try {
      const geo = await fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`,
        { headers: { 'User-Agent': 'Jarvis-Bot/1.0' } }
      )
      if (geo.ok) {
        const geoData = await geo.json()
        cityName = geoData.address?.city
          || geoData.address?.town
          || geoData.address?.village
          || geoData.address?.county
          || 'ta position'
      }
    } catch {}

    memory.updateFact('POSITION_GPS:', `POSITION_GPS:${latitude}|${longitude}|${cityName}`)
    await memory.persist()

    const weather = await getWeather(latitude, longitude)
    const weatherMsg = weather ? ` Météo : ${weather}.` : ''

    await bot.sendMessage(chatId, `Position enregistrée — ${cityName}.${weatherMsg}`)
    console.log(`📍 Position mise à jour : ${cityName} (${latitude}, ${longitude})`)
  } catch (e) {
    console.error('Location error:', e.message)
    await bot.sendMessage(chatId, `Erreur enregistrement position : ${e.message}`)
  }
})

bot.__triggerBriefing = sendMorningBriefing

bot.__triggerBriefing = sendMorningBriefing
module.exports = bot