const fetch = require('node-fetch')

async function searchWeb(query) {
  if (!process.env.TAVILY_API_KEY) {
    console.log('⚠️  TAVILY_API_KEY absent — fallback Claude knowledge')
    return null
  }
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query,
        search_depth: 'advanced',
        max_results: 5,
        include_answer: true,
        include_raw_content: false,
      }),
    })
    if (!res.ok) { console.error('Tavily HTTP error:', res.status); return null }
    const data = await res.json()
    const answer = data.answer ? `Synthèse : ${data.answer}\n\n---\n\n` : ''
    const results = (data.results || []).map(r => `[${r.title}]\n${r.content}`).join('\n\n---\n\n')
    const combined = (answer + results).slice(0, 4000)
    console.log(`🔍 Tavily OK — ${combined.length} chars pour "${query}"`)
    return combined
  } catch (e) {
    console.error('Tavily error:', e.message)
    return null
  }
}

module.exports = { searchWeb }
