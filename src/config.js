require('dotenv').config()

const config = {
  port: process.env.PORT || 3000,
  anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
  openai: { apiKey: process.env.OPENAI_API_KEY },
  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY,
    voiceId: process.env.ELEVENLABS_VOICE_ID,
  },
  notion: {
    token: process.env.NOTION_TOKEN,
    memoryPageId: '346a16a5-dea2-811b-a3c2-e15932a2fb19',
    checkinPageId: '347a16a5-dea2-81a0-b479-cb00f2f6d772',
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/callback',
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
  },
  pushcut: {
    morningUrl: 'https://api.pushcut.io/SqkzZ_LTIkyZ00984Lh5F/notifications/Morning%20Briefing%20',
    checkinUrl: 'https://api.pushcut.io/SqkzZ_LTIkyZ00984Lh5F/notifications/%20Check%20up%20',
    recapUrl: 'https://api.pushcut.io/SqkzZ_LTIkyZ00984Lh5F/notifications/%20R%C3%A9cap%20t%C3%A2ches%20',
  },
}

module.exports = config
