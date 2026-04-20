const express = require('express')
const router = express.Router()
const { getAuthUrl, handleCallback } = require('../google')

router.get('/google', (req, res) => {
  res.redirect(getAuthUrl())
})

router.get('/callback', async (req, res) => {
  const { code } = req.query
  if (!code) return res.status(400).send('Code manquant')
  try {
    const tokens = await handleCallback(code)
    res.send(`<html><body style="font-family:monospace;padding:2rem;background:#0d1117;color:#e6edf3">
      <h2>✅ Google connecté !</h2>
      <p>Ajoute cette variable dans Railway :</p>
      <pre style="background:#161b22;padding:1rem;border-radius:8px;word-break:break-all">GOOGLE_REFRESH_TOKEN=${tokens.refresh_token || '(déjà existant)'}</pre>
      <p style="color:#8b949e">Une fois ajouté, redéploie. Tu n'auras plus jamais besoin de refaire ça.</p>
    </body></html>`)
  } catch (e) {
    res.status(500).send('Erreur auth : ' + e.message)
  }
})

module.exports = router
