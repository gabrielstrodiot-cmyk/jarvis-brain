const TelegramBot = require('node-telegram-bot-api')
const fetch = require('node-fetch')
const fs = require('fs')
const path = require('path')
const os = require('os')
const FormData = require('form-data')
const config = require('../config')
const claudeClient = require('../claude')
const memory = require('../memory')
const actions = require('../actions')
const { getCalendarEvents, getGmailUnread } = require('../google')

const bot = new TelegramBot(config.telegram.botToken, { polling: true })

console.log('🤖 Telegram bot démarré — @jarvis_strodiot_bot')

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
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true },
      }),
    }
  )
  if (!response.ok) throw new Error(`ElevenLabs error: ${await response.text()}`)
  return response.buffer()
}

// ── TRAITEMENT MESSAGE ────────────────────────────────────────
async function handleMessage(chatId, text) {
  try {
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
  } catch (e) {
    console.error('handleMessage error:', e)
    throw e
  }
}

// ── MESSAGES TEXTE ────────────────────────────────────────────
bot.on('message', async (msg) => {
  const chatId = msg.chat.id
  if (msg.text && !msg.voice && !msg.audio) {
    try {
      await bot.sendChatAction(chatId, 'typing')
      const reply = await handleMessage(chatId, msg.text)

      // Réponse texte
      await bot.sendMessage(chatId, reply)

      // Réponse vocale
      try {
        const cleanText = reply.replace(/[📄🔗✅❌📝🤖🎙️]/g, '').replace(/\*\*/g, '').replace(/\n\n/g, '. ').replace(/\n/g, ', ').trim()
        const audioBuffer = await synthesize(cleanText)
        const tmpFile = path.join(os.tmpdir(), `jarvis_${Date.now()}.mp3`)
        fs.writeFileSync(tmpFile, audioBuffer)
        await bot.sendVoice(chatId, tmpFile)
        fs.unlinkSync(tmpFile)
      } catch (e) {
        console.error('ElevenLabs error:', e.message)
      }
    } catch (e) {
      await bot.sendMessage(chatId, `❌ Erreur : ${e.message}`)
    }
  }
})

// ── MESSAGES VOCAUX ───────────────────────────────────────────
bot.on('voice', async (msg) => {
  const chatId = msg.chat.id
  try {
    await bot.sendChatAction(chatId, 'typing')

    // Télécharge le fichier vocal
    const fileId = msg.voice.file_id
    const fileInfo = await bot.getFile(fileId)
    const fileUrl = `https://api.telegram.org/file/bot${config.telegram.botToken}/${fileInfo.file_path}`

    const tmpFile = path.join(os.tmpdir(), `tg_voice_${Date.now()}.ogg`)
    const audioRes = await fetch(fileUrl)
    const buffer = await audioRes.buffer()
    fs.writeFileSync(tmpFile, buffer)

    // Transcription
    const transcript = await transcribeAudio(tmpFile)
    fs.unlinkSync(tmpFile)

    if (!transcript || transcript.trim().length === 0) {
      return bot.sendMessage(chatId, '❌ Audio inaudible, réessaie.')
    }

    await bot.sendMessage(chatId, `🎙️ _"${transcript}"_`, { parse_mode: 'Markdown' })

    // Traitement + réponse
    const reply = await handleMessage(chatId, transcript)
    await bot.sendMessage(chatId, reply)

    // Réponse vocale
    try {
      const cleanText = reply.replace(/[📄🔗✅❌📝🤖🎙️]/g, '').replace(/\*\*/g, '').replace(/\n\n/g, '. ').replace(/\n/g, ', ').trim()
      const audioBuffer = await synthesize(cleanText)
      const tmpAudio = path.join(os.tmpdir(), `jarvis_${Date.now()}.mp3`)
      fs.writeFileSync(tmpAudio, audioBuffer)
      await bot.sendVoice(chatId, tmpAudio)
      fs.unlinkSync(tmpAudio)
    } catch (e) {
      console.error('ElevenLabs error:', e.message)
    }

  } catch (e) {
    await bot.sendMessage(chatId, `❌ Erreur : ${e.message}`)
  }
})

module.exports = bot
