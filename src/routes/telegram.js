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

// Ton chat ID Telegram — sera détecté automatiquement au premier message
let GABRIEL_CHAT_ID = process.env.TELEGRAM_CHAT_ID || null

console.log('🤖 Telegram bot démarré — @jarvis_strodiot_bot')

// ── NETTOYAGE TEXTE POUR ELEVENLABS ──────────────────────────
function cleanForVoice(text) {
  return text
    .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')  // emojis
    .replace(/[\u{2600}-\u{26FF}]/gu, '')     // symboles divers
    .replace(/[\u{2700}-\u{27BF}]/gu, '')     // dingbats
    .replace(/[✅❌📄🔗📝🤖🎙️⚠️]/g, '')
    .replace(/\*\*/g, '')
    .replace(/#{1,3} /g, '')
    .replace(/\n\n/g, '. ')
    .replace(/\n/g, ', ')
    .replace(/[^\x00-\x7F\u00C0-\u024F\u1E00-\u1EFF]/g, '') // garde latin étendu
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

// ── TRAITEMENT MESSAGE ────────────────────────────────────────
async function handleMessage(chatId, text) {
  // Mémorise le chat ID de Gabriel
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
  const { text: reply } = await actions.processReply(rawReply)

  memory.addToHistory('assistant', reply)
  await memory.persist()

  return reply
}

// ── MORNING BRIEFING ──────────────────────────────────────────
async function sendMorningBriefing() {
  const chatId = GABRIEL_CHAT_ID || process.env.TELEGRAM_CHAT_ID
  if (!chatId) {
    console.log('⚠️  Morning briefing : chat ID Gabriel inconnu — envoie un message à Jarvis d\'abord')
    return
  }

  try {
    console.log('🌅 Envoi morning briefing...')
    await memory.load()
    const [calendarEvents, gmailUnread] = await Promise.all([
      getCalendarEvents(),
      getGmailUnread(),
    ])

    const prompt = `Génère mon morning briefing du jour. Sois concis et direct. Inclus :
1. Météo à Namur (si disponible)
2. Mon agenda aujourd'hui et demain
3. Mails importants non lus
4. Rappel morning routine
5. Une intention pour la journée

Format : texte court, pas de markdown excessif, max 200 mots.`

    const rawReply = await claudeClient.chat(prompt, calendarEvents, gmailUnread)
    const { text: reply } = await actions.processReply(rawReply)

    await bot.sendMessage(chatId, `🌅 *Morning Briefing*\n\n${reply}`, { parse_mode: 'Markdown' })
    await sendVoiceReply(chatId, reply)

    console.log('✅ Morning briefing envoyé')
  } catch (e) {
    console.error('Morning briefing error:', e.message)
  }
}

// ── CRON 06h30 ────────────────────────────────────────────────
// Timezone Europe/Brussels (UTC+2 en été)
cron.schedule('30 4 * * *', () => {
  sendMorningBriefing()
}, { timezone: 'Europe/Brussels' })

console.log('⏰ Morning briefing programmé à 06h30 (Europe/Brussels)')

// ── MESSAGES TEXTE ────────────────────────────────────────────
bot.on('message', async (msg) => {
  const chatId = msg.chat.id
  if (!msg.text && !msg.voice && !msg.audio) return
  if (msg.voice || msg.audio) return // géré par l'event voice

  if (msg.text) {
    try {
      await bot.sendChatAction(chatId, 'typing')
      const reply = await handleMessage(chatId, msg.text)
      await bot.sendMessage(chatId, reply)
      await sendVoiceReply(chatId, reply)
    } catch (e) {
      console.error('Message error:', e.message)
      await bot.sendMessage(chatId, `Erreur : ${e.message}`)
    }
  }
})

// ── MESSAGES VOCAUX ───────────────────────────────────────────
bot.on('voice', async (msg) => {
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

    await bot.sendMessage(chatId, `_"${transcript}"_`, { parse_mode: 'Markdown' })

    const reply = await handleMessage(chatId, transcript)
    await bot.sendMessage(chatId, reply)
    await sendVoiceReply(chatId, reply)

  } catch (e) {
    console.error('Voice error:', e.message)
    await bot.sendMessage(chatId, `Erreur : ${e.message}`)
  }
})

module.exports = bot
