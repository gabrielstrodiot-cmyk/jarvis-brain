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
const { getCalendarEvents, getGmailUnread } = require('../google')
const bot = new TelegramBot(config.telegram.botToken, { polling: true })
const notion = require('../notion')
const obsidian = require('../obsidian')

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

// ── NETTOYAGE TEXTE POUR ELEVENLABS ──────────────────────────
function cleanForVoice(text) {
  return text
    .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')
    .replace(/[\u{2600}-\u{26FF}]/gu, '')
    .replace(/[\u{2700}-\u{27BF}]/gu, '')
    .replace(/[✅❌📄🔗📝🤖🎙️⚠️🌅]/g, '')
    .replace(/\*\*/g, '')
    .replace(/#{1,3} /g, '')
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

// ── ENVOIE RÉPONSE VOCALE ─────────────────────────────────────
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
    const [calendarEvents, gmailUnread, tasks, projects, obsidianNote] = await Promise.all([
      getCalendarEvents(),
      getGmailUnread(),
      notion.getActiveTasks(),
      notion.getActiveProjects(),
      obsidian.getRandomNote(),
    ])

    const prompt = `Génère mon morning briefing du jour. Sois concis et direct. Inclus :
1. Mon agenda aujourd'hui et demain
2. Mails importants non lus
3. Tâches prioritaires du jour
4. État des projets actifs
5. Leçon du jour en 2 phrases (synthèse de la note Obsidian fournie)
6. Rappel morning routine

Format : texte fluide, pas de markdown, max 200 mots.`

    const rawReply = await claudeClient.chat(prompt, calendarEvents, gmailUnread, tasks, projects, obsidianNote)
    const { text: reply } = await actions.processReply(rawReply)

    await bot.sendMessage(chatId, `🌅 Morning Briefing\n\n${reply}`)

    console.log('✅ Morning briefing envoyé')
  } catch (e) {
    console.error('Morning briefing error:', e.message)
  }
}

// ── CRON 06h30 Europe/Brussels ────────────────────────────────
cron.schedule('30 4 * * *', () => {
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

    // Dernière entrée du tableau = meilleure résolution
    const photo = msg.photo[msg.photo.length - 1]
    const caption = msg.caption || 'Analyse cette image et dis-moi ce que tu vois.'

    // Télécharger depuis les serveurs Telegram
    const fileInfo = await bot.getFile(photo.file_id)
    const fileUrl = `https://api.telegram.org/file/bot${config.telegram.botToken}/${fileInfo.file_path}`

    const imgRes = await fetch(fileUrl)
    const buffer = await imgRes.buffer()
    const base64 = buffer.toString('base64')

    // Telegram compresse toujours les photos en JPEG
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

module.exports = bot
