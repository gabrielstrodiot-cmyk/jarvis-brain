#!/bin/bash
set -e

# src/routes/voice.js — endpoint vocal complet
cat > src/routes/voice.js << 'EOF'
const express = require('express')
const router = express.Router()
const multer = require('multer')
const FormData = require('form-data')
const fetch = require('node-fetch')
const fs = require('fs')
const path = require('path')
const os = require('os')
const config = require('../config')
const claudeClient = require('../claude')
const memory = require('../memory')
const actions = require('../actions')
const { getCalendarEvents, getGmailUnread } = require('../google')

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB max
})

// ── WHISPER — audio → texte ───────────────────────────────────
async function transcribe(filePath, mimeType) {
  const form = new FormData()
  form.append('file', fs.createReadStream(filePath), {
    filename: 'audio.m4a',
    contentType: mimeType || 'audio/m4a',
  })
  form.append('model', 'whisper-1')
  form.append('language', 'fr')

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openai.apiKey}`,
      ...form.getHeaders(),
    },
    body: form,
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`Whisper error ${response.status}: ${err}`)
  }

  const data = await response.json()
  return data.text
}

// ── ELEVENLABS — texte → audio ────────────────────────────────
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
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.3,
          use_speaker_boost: true,
        },
      }),
    }
  )

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`ElevenLabs error ${response.status}: ${err}`)
  }

  return response.buffer()
}

// ── ENDPOINT PRINCIPAL ────────────────────────────────────────
router.post('/', upload.single('audio'), async (req, res) => {
  const audioFile = req.file

  if (!audioFile) {
    return res.status(400).json({ error: 'Fichier audio requis (champ: audio)' })
  }

  try {
    console.log(`🎙️  Audio reçu : ${audioFile.originalname} (${audioFile.size} bytes)`)

    // 1. Transcription Whisper
    const transcript = await transcribe(audioFile.path, audioFile.mimetype)
    console.log(`📝 Transcription : "${transcript}"`)

    if (!transcript || transcript.trim().length === 0) {
      fs.unlinkSync(audioFile.path)
      return res.status(400).json({ error: 'Audio vide ou inaudible' })
    }

    // 2. Charge mémoire + contexte
    await memory.load()
    const [calendarEvents, gmailUnread] = await Promise.all([
      getCalendarEvents(),
      getGmailUnread(),
    ])

    // 3. Claude — même cerveau que /chat
    const rawReply = await claudeClient.chat(transcript, calendarEvents, gmailUnread)
    const { text: reply, sideEffects } = await actions.processReply(rawReply)

    memory.addToHistory('assistant', reply)
    await memory.persist()

    console.log(`🤖 Réponse : "${reply.slice(0, 100)}..."`)

    // 4. ElevenLabs — texte → voix
    // Nettoie le texte pour la synthèse (supprime les emojis et markdown)
    const cleanText = reply
      .replace(/[📄🔗✅❌📝🤖]/g, '')
      .replace(/\*\*/g, '')
      .replace(/\n\n/g, '. ')
      .replace(/\n/g, ', ')
      .trim()

    const audioBuffer = await synthesize(cleanText)

    // 5. Nettoie le fichier temporaire
    fs.unlinkSync(audioFile.path)

    // 6. Retourne l'audio + métadonnées dans les headers
    res.set({
      'Content-Type': 'audio/mpeg',
      'X-Transcript': encodeURIComponent(transcript),
      'X-Reply': encodeURIComponent(reply.slice(0, 500)),
    })

    res.send(audioBuffer)

  } catch (error) {
    console.error('Voice error:', error)
    if (audioFile && fs.existsSync(audioFile.path)) {
      fs.unlinkSync(audioFile.path)
    }
    res.status(500).json({ error: error.message })
  }
})

// ── ENDPOINT TEST (texte → audio seulement) ───────────────────
router.post('/test', async (req, res) => {
  const { text } = req.body
  if (!text) return res.status(400).json({ error: 'Champ text requis' })

  try {
    const audioBuffer = await synthesize(text)
    res.set('Content-Type', 'audio/mpeg')
    res.send(audioBuffer)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

module.exports = router
EOF

echo "✅ voice.js mis à jour"
