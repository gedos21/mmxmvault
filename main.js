const { Plugin, PluginSettingTab, Setting, Notice } = require('obsidian');
const http = require('http');
const nodeCrypto = require('crypto');

const DEFAULT_SETTINGS = { port: 27125, token: '' };

function safePart(value, fallback) {
  return String(value || fallback).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || fallback;
}

function safeNoteName(value, fallback) {
  return String(value || fallback).replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 100) || fallback;
}

/* ---------------------------------------------------------------------------
   Managed region.
   Everything MMXMatrix writes into a trade note lives between these markers,
   plus the frontmatter keys the payload declares as its own. Anything else in
   the file — prose the user added, their own frontmatter keys, links, embeds —
   is copied through untouched. mmx_hash is the hash of the managed region
   exactly as written to disk, so a later read can tell whether the user edited
   inside it.
--------------------------------------------------------------------------- */
const MMX_START = '<!-- mmx:start -->';
const MMX_END = '<!-- mmx:end -->';
const MMX_FOOTER = '<!-- Bu satırın altı sana ait. MMXMatrix yalnızca yukarıdaki bloğu günceller. -->';

function mmxHash(text) {
  return nodeCrypto.createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 16);
}

function splitNote(content) {
  const raw = String(content || '');
  const lines = raw.split('\n');
  if (lines[0]?.trim() !== '---') return { frontmatter: [], body: raw };
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (close < 0) return { frontmatter: [], body: raw };
  return { frontmatter: lines.slice(1, close), body: lines.slice(close + 1).join('\n').replace(/^\n/, '') };
}

function splitManaged(body) {
  const text = String(body || '');
  const start = text.indexOf(MMX_START);
  const end = text.indexOf(MMX_END);
  if (start < 0 || end < 0 || end < start) return { hadMarkers: false, before: '', managed: '', after: '' };
  return {
    hadMarkers: true,
    before: text.slice(0, start),
    managed: text.slice(start + MMX_START.length, end).replace(/^\n/, '').replace(/\n+$/, ''),
    after: text.slice(end + MMX_END.length),
  };
}

/* A note written by the previous format has no markers. Only when its body is
   exactly the shape MMXMatrix used to generate — nothing added after the last
   section — is it safe to replace outright; otherwise the old body is kept
   below the new block so nothing the user wrote can be lost. */
const LEGACY_SECTIONS = ['## İşlem', '## Journal', '## Hatalar', '## Ekran görüntüleri', '## Bağlantılar'];
function isPureLegacyBody(body) {
  const text = String(body || '').trim();
  if (!text.startsWith('# ')) return false;
  let cursor = 0;
  for (const heading of LEGACY_SECTIONS) {
    const at = text.indexOf(`\n${heading}`, cursor);
    if (at < 0) return false;
    cursor = at + heading.length + 1;
  }
  return text.slice(cursor).split('\n').slice(1).every((line) => !line.trim() || /^-\s/.test(line.trim()));
}

function yamlValue(value) {
  if (Array.isArray(value)) return `[${value.map((item) => JSON.stringify(String(item))).join(', ')}]`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = String(value ?? '');
  if (!text) return '';
  return /^[\s"'#\-[{&*!|>%@`]|[:#]\s|\s$/.test(text) ? JSON.stringify(text) : text;
}

/* replace only the keys the payload owns; every other line, including the
   continuation lines of block values, is carried over verbatim */
function mergeFrontmatter(existing, owned, ownedKeys) {
  const ownedSet = new Set(ownedKeys.map(String));
  const kept = [];
  let dropping = false;
  for (const line of existing) {
    const match = /^([^\s:#][^:]*):/.exec(line);
    if (match) { dropping = ownedSet.has(match[1].trim()); if (!dropping) kept.push(line); continue; }
    if (!dropping) kept.push(line);
  }
  const ownedLines = ownedKeys.map((key) => `${key}: ${yamlValue(owned[key])}`.trimEnd());
  return [...ownedLines, ...kept];
}

/* ---------------------------------------------------------------------------
   Note classification — one taxonomy for the whole bridge.
   /graph and /notes must never disagree about what a note is, so both go
   through classifyNote(). Signals are read from the vault as it actually is
   (frontmatter, folder layout, tags); nothing is invented. Adding a new type
   later (error, playbook, …) means one entry in FOLDER_TYPES / TAG_TYPES.
--------------------------------------------------------------------------- */
const NOTE_TYPES = ['trade', 'model', 'concept', 'journal'];

const FOLDER_TYPES = [
  [/^models?$/i, 'model'],
  [/^setups?$/i, 'model'],
  [/^concepts?$/i, 'concept'],
  [/^trades?$/i, 'trade'],
];

const TAG_TYPES = [
  [/^(model|setup)s?$/i, 'model'],
  [/^concepts?$/i, 'concept'],
];

function noteTags(cache) {
  const inline = (cache?.tags || []).map((tag) => tag.tag);
  const front = cache?.frontmatter?.tags;
  const fromFront = Array.isArray(front) ? front : (typeof front === 'string' ? front.split(/[,\s]+/) : []);
  const all = [...inline, ...fromFront].map((tag) => String(tag).replace(/^#/, '').trim()).filter(Boolean);
  return [...new Set(all)];
}

function noteAliases(cache) {
  const raw = cache?.frontmatter?.aliases ?? cache?.frontmatter?.alias;
  const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? [raw] : []);
  return list.map((alias) => String(alias).trim()).filter(Boolean).slice(0, 8);
}

/* the deepest matching folder wins: GedOS/Models/Break and Retest.md -> model */
function folderType(path) {
  const parts = String(path).split('/').slice(0, -1);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const hit = FOLDER_TYPES.find(([pattern]) => pattern.test(parts[i]));
    if (hit) return hit[1];
  }
  return '';
}

function tagType(tags) {
  for (const tag of tags) {
    const leaf = tag.split('/').pop();
    const hit = TAG_TYPES.find(([pattern]) => pattern.test(leaf));
    if (hit) return hit[1];
  }
  return '';
}

function classifyNote(file, cache, tags) {
  /* an explicit `type:` in frontmatter is the author's own answer — trust it
     first. `type: hub` is deliberately not listed: hub notes say what they are
     through the folder they live in. */
  const declared = String(cache?.frontmatter?.type || '').toLowerCase().trim();
  if (NOTE_TYPES.includes(declared)) return declared;
  const byFolder = folderType(file.path);
  if (byFolder) return byFolder;
  const byTag = tagType(tags);
  if (byTag) return byTag;
  /* legacy trade notes written before frontmatter carried a type */
  if (file.path.startsWith('GedOS/Trading Journal/')) return 'trade';
  return 'journal';
}

class GedOSVaultBridge extends Plugin {
  async onload() {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
    if (!this.settings.token) { this.settings.token = nodeCrypto.randomBytes(32).toString('hex'); await this.saveData(this.settings); }
    this.addSettingTab(new GedOSSettingTab(this.app, this));
    this.startServer();
    this.addCommand({ id: 'show-connection-details', name: 'Show mmxMatrix connection details', callback: () => new Notice(`GedOS bridge: http://127.0.0.1:${this.settings.port} · token: ${this.settings.token}`) });
  }

  onunload() { if (this.server) this.server.close(); }

  startServer() {
    this.server = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-GedOS-Token'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      if (req.headers['x-gedos-token'] !== this.settings.token) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Invalid token' })); }
      const requestUrl = new URL(req.url, 'http://127.0.0.1');
      const route = requestUrl.pathname.replace(/\/+$/, '') || '/';
      /* features lets mmxMatrix refuse to push a payload this bridge would
         misread — an older build would treat a managed-block payload as an
         empty note and wipe the file */
      if (req.method === 'GET' && route === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, vault: this.app.vault.getName(), features: ['notes', 'managedBlock'] })); }
      if (req.method === 'GET' && route === '/graph') return this.getGraph(res);
      if (req.method === 'GET' && route === '/notes') return this.getNotes(res, requestUrl.searchParams);
      if (req.method === 'POST' && route === '/trades') return this.receiveTrade(req, res);
      res.writeHead(404); res.end();
    });
    this.server.on('error', (error) => new Notice(`GedOS bridge başlatılamadı: ${error.message}`));
    this.server.listen(Number(this.settings.port), '127.0.0.1');
  }

  async getGraph(res) {
    try {
      const files = this.app.vault.getMarkdownFiles().slice(0, 300);
      const nodes = files.map((file) => {
        const cache = this.app.metadataCache.getFileCache(file) || {};
        const tags = noteTags(cache);
        /* the graph legend only draws trade / model / journal today, so concept
           notes ride along as journal until the Concept layer lands. Drop this
           line to give them their own node type. */
        const classified = classifyNote(file, cache, tags);
        const type = classified === 'concept' ? 'journal' : classified;
        /* mmxMatrix writes trade_id into every trade note's frontmatter; passing
           it through lets the site open the right row without guessing from
           the label. Absent on hand-written notes — then there is nothing to
           open, and the node stays inert. */
        const tradeId = classified === 'trade' ? String(cache?.frontmatter?.trade_id || '').trim() : '';
        return { id: file.path, label: file.basename, type, tags: tags.slice(0, 12), ...(tradeId ? { tradeId } : {}) };
      });
      const known = new Set(nodes.map((node) => node.id)); const links = [];
      files.forEach((file) => { const cache = this.app.metadataCache.getFileCache(file) || {}; (cache.links || []).forEach((link) => { const target = this.app.metadataCache.getFirstLinkpathDest(link.link, file.path); if (target && known.has(target.path)) links.push({ source: file.path, target: target.path }); }); });
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ vault: this.app.vault.getName(), nodes, links }));
    } catch (error) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
  }

  /* GET /notes?type=model,concept — the vault's own notes of a given type.
     mmxMatrix uses this to fill its Model/Concept pickers from real notes
     instead of a hardcoded list. `type=all` returns every classified note. */
  async getNotes(res, params) {
    try {
      const requested = String(params.get('type') || 'model').toLowerCase();
      const wanted = requested === 'all' ? null : new Set(requested.split(',').map((part) => part.trim()).filter((part) => NOTE_TYPES.includes(part)));
      if (wanted && !wanted.size) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: `Unknown type. Use one of: ${NOTE_TYPES.join(', ')} or all.` })); }
      const notes = [];
      for (const file of this.app.vault.getMarkdownFiles()) {
        const cache = this.app.metadataCache.getFileCache(file) || {};
        const tags = noteTags(cache);
        const type = classifyNote(file, cache, tags);
        if (wanted && !wanted.has(type)) continue;
        notes.push({ id: file.path, name: file.basename, path: file.path, folder: file.parent?.path || '', type, tags: tags.slice(0, 12), aliases: noteAliases(cache) });
        if (notes.length >= 1000) break;
      }
      notes.sort((a, b) => a.name.localeCompare(b.name, 'tr'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ vault: this.app.vault.getName(), types: wanted ? [...wanted] : NOTE_TYPES, count: notes.length, notes }));
    } catch (error) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
  }

  async receiveTrade(req, res) {
    let raw = ''; req.on('data', (chunk) => { raw += chunk; if (raw.length > 12_000_000) req.destroy(); });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(raw); const trade = payload.trade || {}; const date = new Date(trade.tradeDate || Date.now()); const year = String(date.getFullYear()); const month = String(date.getMonth() + 1).padStart(2, '0'); const symbol = safePart(trade.symbol, 'TRADE'); const id = safePart(trade.id, Date.now()); const folder = `GedOS/Trading Journal/${year}/${month}`; const attachmentFolder = `${folder}/attachments`;
        for (const path of ['GedOS', 'GedOS/Trading Journal', `GedOS/Trading Journal/${year}`, folder, attachmentFolder]) await this.app.vault.createFolder(path).catch(() => {});
        const attachments = payload.attachments || {}; const links = {};
        for (const [key, item] of Object.entries(attachments)) { if (!item?.dataUrl) continue; const comma = item.dataUrl.indexOf(','); const bytes = Buffer.from(comma >= 0 ? item.dataUrl.slice(comma + 1) : item.dataUrl, 'base64'); const fileName = safePart(item.fileName, `${key}.png`); const path = `${attachmentFolder}/${id}-${fileName}`; await this.app.vault.adapter.writeBinary(path, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)); links[key] = `${id}-${fileName}`; }
        if (typeof payload.body !== 'string') { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Payload has no managed body. Update mmxMatrix — writing the whole note would overwrite your own content.' })); }

        /* the managed region as it will land on disk: attachment links are
           rewritten first so the hash describes the real file, not the draft */
        let managed = payload.body;
        Object.entries(links).forEach(([key, fileName]) => { managed = managed.replace(`![[${attachments[key].fileName}]]`, `![[attachments/${fileName}]]`); });
        const hash = mmxHash(managed);

        const path = `${folder}/${year}-${month}-${String(date.getDate()).padStart(2, '0')}-${symbol}-${id}.md`;
        const exists = await this.app.vault.adapter.exists(path);
        const previous = exists ? await this.app.vault.adapter.read(path) : '';
        const { frontmatter: oldFrontmatter, body: oldBody } = splitNote(previous);
        const region = splitManaged(oldBody);

        let before = region.before;
        let after = region.after;
        let upgraded = false;
        if (!region.hadMarkers) {
          if (!exists) {
            after = `\n\n${MMX_FOOTER}\n`;
          } else if (isPureLegacyBody(oldBody)) {
            after = `\n\n${MMX_FOOTER}\n`; /* nothing but generated text was there */
            upgraded = true;
          } else {
            /* something else is in this file — keep every byte of it */
            after = `\n\n${MMX_FOOTER}\n\n## Önceki içerik (MMXMatrix v1 · istersen silebilirsin)\n\n${oldBody.trim()}\n`;
            upgraded = true;
          }
        }

        const owned = { ...(payload.frontmatter || {}), mmx_hash: hash };
        const ownedKeys = [...(payload.ownedKeys || Object.keys(payload.frontmatter || {}))];
        if (!ownedKeys.includes('mmx_hash')) ownedKeys.splice(Math.max(ownedKeys.indexOf('mmx_rev') + 1, 1), 0, 'mmx_hash');
        const frontmatter = mergeFrontmatter(oldFrontmatter, owned, ownedKeys);

        const content = `---\n${frontmatter.join('\n')}\n---\n\n${before}${MMX_START}\n${managed}\n${MMX_END}${after}`;
        if (exists) await this.app.vault.adapter.write(path, content); else await this.app.vault.create(path, content);
        await this.ensureHubNotes(payload.hubs);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path, attachments: Object.keys(links).length, rev: owned.mmx_rev ?? null, hash, upgraded, preservedOutside: Boolean(before.trim() || after.replace(MMX_FOOTER, '').trim()) }));
      } catch (error) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
    });
  }

  async ensureHubNotes(hubs) {
    const existingBasenames = new Set(this.app.vault.getMarkdownFiles().map((file) => file.basename.toLowerCase()));
    for (const hub of Array.isArray(hubs) ? hubs : []) {
      const folder = safePart(hub?.folder, 'Concepts');
      const name = safeNoteName(hub?.name, '');
      if (!name) continue;
      if (existingBasenames.has(name.toLowerCase())) continue;
      const dir = `GedOS/Trading Journal/${folder}`;
      await this.app.vault.createFolder(dir).catch(() => {});
      const path = `${dir}/${name}.md`;
      if (await this.app.vault.adapter.exists(path)) continue;
      await this.app.vault.create(path, `---\ntype: hub\n---\n\n# ${name}\n`).catch(() => {});
    }
  }
}

class GedOSSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'GedOS Vault Bridge' });
    containerEl.createEl('p', { text: 'mmxMatrix bağlantı bilgilerini siteye girerek bu vault’a trade gönderebilirsin.' });
    new Setting(containerEl).setName('Port').setDesc('Varsayılan: 27125').addText((text) => {
      text.setValue(String(this.plugin.settings.port)).onChange(async (value) => {
        this.plugin.settings.port = Number(value) || 27125;
        await this.plugin.saveData(this.plugin.settings);
      });
    });
    new Setting(containerEl).setName('Erişim anahtarı').setDesc('Bu anahtarı mmxMatrix bağlantı penceresine gir.').addText((text) => {
      text.setValue(this.plugin.settings.token).onChange(async (value) => {
        this.plugin.settings.token = value.trim();
        await this.plugin.saveData(this.plugin.settings);
      });
    });
    new Setting(containerEl).setName('Bağlantı adresi').addText((text) => text.setValue(`http://127.0.0.1:${this.plugin.settings.port}`).setDisabled(true));
  }
}

module.exports = GedOSVaultBridge;
