const db     = require('./db')
const search = require('./search')
const claude = require('./claude')

function subjectToPath(subject) {
  const clean = subject
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 60)
  return `Jarvis-Drafts/${clean}.md`
}

async function generateDraft(subject) {
  console.log(`📝 Génération draft : "${subject}"`)
  const searchResults = await search.searchWeb(subject)
  if (!searchResults) console.log('🔍 Fallback Claude knowledge')
  const content      = await claude.generateDraftContent(subject, searchResults)
  const obsidianPath = subjectToPath(subject)
  const id           = await db.saveDraft(subject, content, obsidianPath)
  console.log(`✅ Draft ${id} sauvegardé — ${obsidianPath}`)
  return { id, subject, content, obsidianPath, revision_count: 0 }
}

async function reviseDraft(draftId, feedback) {
  console.log(`✏️  Révision draft ${draftId}`)
  const draft = await db.getDraft(draftId)
  if (!draft) throw new Error(`Draft ${draftId} introuvable`)
  const revised = await claude.generateDraftContent(draft.subject, null, draft.content, feedback)
  await db.updateDraft(draftId, {
    content:          revised,
    status:           'awaiting_validation',
    revisionFeedback: feedback,
    revisionCount:    draft.revision_count + 1,
  })
  return { ...draft, content: revised, revision_count: draft.revision_count + 1 }
}

module.exports = { generateDraft, reviseDraft }
