cat > ~/jarvis-brain/src/obsidian.js << 'EOF'
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = 'gabrielstrodiot-cmyk/Obsidian-vlaut';
const BRANCH = 'main';
const BASE_URL = 'https://api.github.com';

const headers = {
  'Authorization': `token ${GITHUB_TOKEN}`,
  'Accept': 'application/vnd.github.v3+json',
  'Content-Type': 'application/json'
};

async function readNote(path) {
  const res = await fetch(`${BASE_URL}/repos/${REPO}/contents/${encodeURIComponent(path)}?ref=${BRANCH}`, { headers });
  if (!res.ok) throw new Error(`Note introuvable: ${path}`);
  const data = await res.json();
  return Buffer.from(data.content, 'base64').toString('utf-8');
}

async function listFolder(path = '') {
  const res = await fetch(`${BASE_URL}/repos/${REPO}/contents/${encodeURIComponent(path)}?ref=${BRANCH}`, { headers });
  if (!res.ok) throw new Error(`Dossier introuvable: ${path}`);
  const data = await res.json();
  return data.filter(f => f.type === 'file' && f.name.endsWith('.md')).map(f => f.path);
}

async function writeNote(path, content, commitMessage = 'Jarvis: mise à jour note') {
  let sha;
  try {
    const res = await fetch(`${BASE_URL}/repos/${REPO}/contents/${encodeURIComponent(path)}?ref=${BRANCH}`, { headers });
    if (res.ok) { const data = await res.json(); sha = data.sha; }
  } catch {}
  const body = { message: commitMessage, content: Buffer.from(content, 'utf-8').toString('base64'), branch: BRANCH, ...(sha && { sha }) };
  const res = await fetch(`${BASE_URL}/repos/${REPO}/contents/${encodeURIComponent(path)}`, { method: 'PUT', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Erreur écriture: ${await res.text()}`);
  return true;
}

async function searchNotes(query) {
  const res = await fetch(`${BASE_URL}/search/code?q=${encodeURIComponent(query)}+repo:${REPO}+extension:md`, { headers });
  if (!res.ok) return [];
  const data = await res.json();
  return data.items?.map(i => i.path) || [];
}

module.exports = { readNote, writeNote, listFolder, searchNotes };
EOF