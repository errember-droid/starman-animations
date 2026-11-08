const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const discord = require('./discord');

const APP_NAME = 'Starman Does Animations';
// Discord Application ID. Can also be put into discord.txt next to the exe (first line).
const DISCORD_CLIENT_ID = '';
app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId(APP_NAME);

let win = null;
let lastDir = null;

/* files opened from Explorer ("Open with Starman Does Animations" / double click) */
const OPEN_EXTS = new Set(['sdt', 'sdv', 'sdp', 'sdz', 'aseprite', 'ase', 'sda', 'lbx']);
let pendingOpen = [];
function collectArgs(argv) {
  for (const a of (argv || []).slice(1)) {
    if (!a || a.startsWith('-')) continue;
    try { const p = path.resolve(a); if (OPEN_EXTS.has(path.extname(p).slice(1).toLowerCase()) && fs.statSync(p).isFile()) pendingOpen.push(p); } catch (e) {}
  }
}
collectArgs(process.argv);
if (typeof app.requestSingleInstanceLock === 'function') {
  if (!app.requestSingleInstanceLock()) app.exit(0);
  else app.on('second-instance', (e, argv) => {
    collectArgs(argv);
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); if (pendingOpen.length) win.webContents.send('open-files'); }
  });
}

function discordConfig() {
  let id = DISCORD_CLIENT_ID, image = 'logo';
  try {
    const lines = fs.readFileSync(path.join(path.dirname(process.execPath), 'discord.txt'), 'utf8').split(/\r?\n/).map(l => l.trim());
    if (/^\d{15,25}$/.test(lines[0])) id = lines[0];
    if (lines[1] !== undefined && lines[1] !== '') image = lines[1] === '-' ? '' : lines[1];
  } catch (e) {}
  return id ? { clientId: id, largeImage: image } : null;
}
let rpc = null;
const IPC_OK = e => !!win && e.sender === win.webContents;

const FILTERS = {
  png: [{ name: 'PNG image', extensions: ['png'] }],
  xml: [{ name: 'Sparrow XML', extensions: ['xml'] }],
  gif: [{ name: 'GIF animation', extensions: ['gif'] }],
  webm: [{ name: 'WebM video', extensions: ['webm'] }],
  zip: [{ name: 'ZIP archive', extensions: ['zip'] }],
  mp4: [{ name: 'MP4 video', extensions: ['mp4'] }],
  json: [{ name: 'JSON data', extensions: ['json'] }],
  jpg: [{ name: 'JPEG image', extensions: ['jpg', 'jpeg'] }],
  webp: [{ name: 'WebP image', extensions: ['webp'] }],
  aseprite: [{ name: 'Aseprite file', extensions: ['aseprite', 'ase'] }],
  sdz: [{ name: 'Starman package', extensions: ['sdz'] }],
  gpl: [{ name: 'Palette', extensions: ['gpl'] }], hex: [{ name: 'Palette', extensions: ['hex'] }], pal: [{ name: 'Palette', extensions: ['pal'] }], txt: [{ name: 'Text', extensions: ['txt'] }],
  open: [{ name: 'Animations', extensions: ['sdt', 'sdv', 'sdp', 'sda', 'lbx', 'sdz', 'aseprite', 'ase'] }]
};

/* ---- animation files live in Documents\Starman Does Animations ---- */
const EXT = { trad: 'sdt', vector: 'sdv', pixel: 'sdp' };
const EXTS = new Set(Object.values(EXT));
const ROOT = () => path.join(app.getPath('documents'), APP_NAME);
const TRASH = () => path.join(ROOT(), '.trash');
const TRASH_INDEX = () => path.join(TRASH(), 'index.json');
const cleanName = n => String(n || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/[. ]+$/, '').slice(0, 60);
const extOf = f => path.extname(f).slice(1).toLowerCase();
const isAnim = f => EXTS.has(extOf(f));

function segOk(s) { return s && s === s.trim() && s.length <= 80 && !/[\\/:*?"<>|\u0000-\u001f]/.test(s) && !s.startsWith('.') && !/[. ]$/.test(s); }
// rel paths use "/" and must stay inside ROOT
function abs(rel, kind) {
  const parts = String(rel || '').split('/').filter(p => p !== '');
  if (!parts.every(segOk)) throw new Error('bad path');
  if (kind === 'file' && (!parts.length || !isAnim(parts[parts.length - 1]))) throw new Error('bad file');
  return path.join(ROOT(), ...parts);
}
const relOf = p => path.relative(ROOT(), p).split(path.sep).join('/');
function atomicWrite(p, text) { fs.writeFileSync(p + '.tmp', text, 'utf8'); fs.renameSync(p + '.tmp', p); }
function modeOf(text) { const m = /"mode":"(\w+)"/.exec(text.slice(0, 200)); return m && EXT[m[1]] ? m[1] : 'trad'; }
function freePath(dir, base, ext) {
  const mk = n => path.join(dir, ext ? n + '.' + ext : n);
  let n = base, i = 2;
  while (fs.existsSync(mk(n))) n = base + ' ' + i++;
  return mk(n);
}
function splitBase(f, isDir) { if (isDir) return [f, '']; const e = path.extname(f); return [path.basename(f, e), e.slice(1)]; }

// bring over work saved by earlier versions (one autosave per type, or Лайтбокс)
function migrate() {
  const marker = path.join(app.getPath('userData'), 'files-migrated');
  if (fs.existsSync(marker)) return;
  const ud = app.getPath('userData');
  const old = [path.join(ud, 'autosave-trad.sda'), path.join(ud, 'autosave-vector.sda'), path.join(ud, 'autosave-pixel.sda'), path.join(ud, 'autosave.sda'),
    path.join(app.getPath('appData'), 'Лайтбокс', 'autosave.lbx'), path.join(app.getPath('appData'), 'lightbox', 'autosave.lbx')];
  const seen = new Set();
  for (const p of old) {
    try {
      const text = fs.readFileSync(p, 'utf8'), key = text.length + ':' + text.slice(-200);
      if (seen.has(key)) continue; seen.add(key);
      JSON.parse(text);
      atomicWrite(freePath(ROOT(), 'Recovered', EXT[modeOf(text)]), text);
    } catch (e) {}
  }
  try { fs.writeFileSync(marker, '1'); } catch (e) {}
}
function ensureRoot() { fs.mkdirSync(ROOT(), { recursive: true }); migrate(); }
function readHead(p) {
  const fd = fs.openSync(p, 'r');
  try { const buf = Buffer.alloc(400000); const n = fs.readSync(fd, buf, 0, buf.length, 0); return buf.slice(0, n).toString('utf8'); }
  finally { fs.closeSync(fd); }
}
function thumbOf(p) { try { const t = /"thumb":"(data:image\/png;base64,[A-Za-z0-9+/=]+)"/.exec(readHead(p)); return t ? t[1] : null; } catch (e) { return null; } }

function readTrash() { try { return JSON.parse(fs.readFileSync(TRASH_INDEX(), 'utf8')); } catch (e) { return []; } }
function writeTrash(list) { fs.mkdirSync(TRASH(), { recursive: true }); atomicWrite(TRASH_INDEX(), JSON.stringify(list)); }

const H = (name, fn) => ipcMain.handle(name, (e, ...a) => fn(e, ...a));

H('take-open-files', () => {
  const list = pendingOpen; pendingOpen = [];
  return list.map(p => {
    let rel = null; try { const r = relOf(p); if (!r.startsWith('..') && !path.isAbsolute(r) && isAnim(p)) rel = r; } catch (e) {}
    let b64 = ''; if (!rel) { try { b64 = fs.readFileSync(p).toString('base64'); } catch (e) { return null; } }
    return { name: path.basename(p), rel, b64 };
  }).filter(Boolean);
});
H('open-external', (e, url) => { if (/^https:\/\/github\.com\//.test(String(url))) shell.openExternal(String(url)); return true; });
H('fs-list', (e, dir) => {
  ensureRoot();
  const d = abs(dir);
  return fs.readdirSync(d, { withFileTypes: true }).map(ent => {
    if (ent.name.startsWith('.')) return null;
    const p = path.join(d, ent.name), rel = relOf(p);
    if (ent.isDirectory()) return { path: rel, name: ent.name, kind: 'dir', ext: '', mtime: fs.statSync(p).mtimeMs };
    if (!ent.isFile() || !isAnim(ent.name)) return null;
    return { path: rel, name: path.basename(ent.name, path.extname(ent.name)), kind: 'file', ext: extOf(ent.name), mtime: fs.statSync(p).mtimeMs, thumb: thumbOf(p) };
  }).filter(Boolean);
});
H('fs-read', (e, f) => fs.readFileSync(abs(f, 'file'), 'utf8'));
H('fs-write', (e, f, text) => { ensureRoot(); const p = abs(f, 'file'); fs.mkdirSync(path.dirname(p), { recursive: true }); atomicWrite(p, text); return true; });
ipcMain.on('fs-write-sync', (e, f, text) => { try { const p = abs(f, 'file'); fs.mkdirSync(path.dirname(p), { recursive: true }); atomicWrite(p, text); e.returnValue = true; } catch (err) { e.returnValue = false; } });
H('fs-mkdir', (e, dir, name) => { ensureRoot(); const p = freePath(abs(dir), cleanName(name) || 'New folder', ''); fs.mkdirSync(p); return relOf(p); });
H('fs-rename', (e, rel, name) => {
  const from = abs(rel), isDir = fs.statSync(from).isDirectory(), n = cleanName(name);
  if (!n) throw new Error('bad name');
  const to = path.join(path.dirname(from), isDir ? n : n + '.' + extOf(rel));
  if (to === from) return rel;
  if (to.toLowerCase() !== from.toLowerCase() && fs.existsSync(to)) throw new Error('exists');
  fs.renameSync(from, to);
  return relOf(to);
});
H('fs-move', (e, rel, toDir) => {
  const from = abs(rel), dst = abs(toDir), isDir = fs.statSync(from).isDirectory();
  if (path.dirname(from) === dst) return rel;
  if (isDir && (dst === from || dst.startsWith(from + path.sep))) throw new Error('into itself');
  const [b, x] = splitBase(path.basename(from), isDir);
  const to = freePath(dst, b, x);
  fs.renameSync(from, to);
  return relOf(to);
});
H('fs-trash', (e, rel) => {
  const from = abs(rel); if (from === ROOT()) throw new Error('root');
  const isDir = fs.statSync(from).isDirectory();
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  fs.mkdirSync(path.join(TRASH(), id), { recursive: true });
  fs.renameSync(from, path.join(TRASH(), id, path.basename(from)));
  const list = readTrash();
  list.push({ id, name: path.basename(from), kind: isDir ? 'dir' : 'file', from: relOf(path.dirname(from)), deleted: Date.now() });
  writeTrash(list);
  return id;
});
H('fs-trash-list', () => readTrash().filter(t => fs.existsSync(path.join(TRASH(), t.id, t.name))));
H('fs-restore', (e, id) => {
  const list = readTrash(), t = list.find(x => x.id === id); if (!t) throw new Error('missing');
  let dir; try { dir = abs(t.from); } catch (err) { dir = ROOT(); }
  fs.mkdirSync(dir, { recursive: true });
  const [b, x] = splitBase(t.name, t.kind === 'dir');
  const to = freePath(dir, b, x);
  fs.renameSync(path.join(TRASH(), id, t.name), to);
  fs.rmSync(path.join(TRASH(), id), { recursive: true, force: true });
  writeTrash(list.filter(x => x.id !== id));
  return relOf(to);
});
// "delete forever" still goes to the Windows Recycle Bin, so nothing is lost by accident
async function purge(id) {
  const p = path.join(TRASH(), id);
  if (fs.existsSync(p)) { try { await shell.trashItem(p); } catch (err) { fs.rmSync(p, { recursive: true, force: true }); } }
}
H('fs-purge', async (e, id) => { await purge(id); writeTrash(readTrash().filter(x => x.id !== id)); return true; });
H('fs-empty', async () => { for (const t of readTrash()) await purge(t.id); writeTrash([]); return true; });
H('fs-folder', (e, dir) => { ensureRoot(); return shell.openPath(abs(dir)); });
H('fs-import', async (e, dir) => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
    defaultPath: lastDir || app.getPath('documents'), filters: FILTERS.open, properties: ['openFile']
  });
  if (r.canceled || !r.filePaths.length) return null;
  const src = r.filePaths[0]; lastDir = path.dirname(src);
  const text = fs.readFileSync(src, 'utf8');
  const d = JSON.parse(text);
  if (!d || !Array.isArray(d.frames)) throw new Error('not an animation');
  ensureRoot();
  const to = freePath(abs(dir), cleanName(path.basename(src, path.extname(src))) || 'Animation', EXT[modeOf(text)]);
  atomicWrite(to, text);
  return relOf(to);
});
/* autosave copies for crash recovery */
const SNAP = () => path.join(ROOT(), '.autosave');
const SNAP_INDEX = () => path.join(SNAP(), 'index.json');
const idOk = id => /^[a-z0-9]{4,24}$/.test(String(id));
function readSnaps() { try { return JSON.parse(fs.readFileSync(SNAP_INDEX(), 'utf8')); } catch (e) { return []; } }
function writeSnaps(l) { fs.mkdirSync(SNAP(), { recursive: true }); atomicWrite(SNAP_INDEX(), JSON.stringify(l)); }
H('snap-write', (e, rel, text, keep) => {
  abs(rel, 'file');
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  fs.mkdirSync(SNAP(), { recursive: true });
  atomicWrite(path.join(SNAP(), id + '.json'), text);
  let list = readSnaps(); list.push({ id, path: rel, at: Date.now() });
  const k = Math.max(1, Math.min(50, keep | 0 || 5)), drop = new Set();
  const mine = list.filter(x => x.path === rel).sort((a, b) => b.at - a.at);
  for (const x of mine.slice(k)) drop.add(x.id);
  const rest = list.filter(x => !drop.has(x.id)).sort((a, b) => b.at - a.at);
  for (const x of rest.slice(100)) drop.add(x.id);
  for (const id2 of drop) { try { fs.unlinkSync(path.join(SNAP(), id2 + '.json')); } catch (err) {} }
  writeSnaps(list.filter(x => !drop.has(x.id)));
  return id;
});
H('snap-list', () => readSnaps().filter(x => fs.existsSync(path.join(SNAP(), x.id + '.json'))));
H('snap-read', (e, id) => { if (!idOk(id)) throw new Error('bad id'); return fs.readFileSync(path.join(SNAP(), id + '.json'), 'utf8'); });
H('snap-delete', (e, id) => { if (!idOk(id)) throw new Error('bad id'); try { fs.unlinkSync(path.join(SNAP(), id + '.json')); } catch (err) {} writeSnaps(readSnaps().filter(x => x.id !== id)); return true; });
H('snap-clear', () => { for (const x of readSnaps()) { try { fs.unlinkSync(path.join(SNAP(), x.id + '.json')); } catch (err) {} } writeSnaps([]); return true; });
/* crash detection: a lock file exists while the program runs */
const LOCK = () => path.join(app.getPath('userData'), 'session.lock');
let crashed = false;
H('session-start', () => {
  const c = crashed; crashed = false;
  try { fs.mkdirSync(path.dirname(LOCK()), { recursive: true }); fs.writeFileSync(LOCK(), String(Date.now())); } catch (err) {}
  return c;
});

const LAYOUT = () => path.join(app.getPath('userData'), 'desktop.json');
H('layout-read', () => { try { return JSON.parse(fs.readFileSync(LAYOUT(), 'utf8')); } catch (e) { return null; } });
H('layout-write', (e, data) => { fs.mkdirSync(path.dirname(LAYOUT()), { recursive: true }); atomicWrite(LAYOUT(), JSON.stringify(data)); return true; });

H('save-file', async (e, { name, bytes }) => {
  const ext = path.extname(name).slice(1).toLowerCase();
  const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
    defaultPath: path.join(lastDir || app.getPath('documents'), name),
    filters: FILTERS[ext] || []
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, Buffer.from(bytes));
  lastDir = path.dirname(r.filePath);
  return r.filePath;
});

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600,
    backgroundColor: '#1c1c33',
    title: APP_NAME,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, spellcheck: false }
  });
  win.maximize();
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\/github\.com\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.on('render-process-gone', () => { crashed = true; setTimeout(() => { if (win && !win.isDestroyed()) win.reload(); }, 500); });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    if (input.key === 'F12') { win.webContents.toggleDevTools(); e.preventDefault(); }
  });
}

Menu.setApplicationMenu(null);

/* updates: read version.json from the update site; install = download the new index.html next to this file, then restart */
H('app-update-check', async (e, url) => {
  try { const r = await fetch(url + 'version.json?t=' + Date.now(), { cache: 'no-store' }); if (!r.ok) return null; return await r.json(); } catch (err) { return null; }
});
H('app-update-install', async (e, url) => {
  try {
    const r = await fetch(url + 'index.html?t=' + Date.now(), { cache: 'no-store' }); if (!r.ok) return { ok: false, error: 'download failed (' + r.status + ')' };
    const html = await r.text();
    if (!/Starman Does Animations/.test(html) || html.length < 100000) return { ok: false, error: 'the downloaded file does not look right' };
    const target = path.join(__dirname, 'index.html');
    try { fs.copyFileSync(target, path.join(__dirname, 'index.prev.html')); } catch (err) {}
    fs.writeFileSync(target, html, 'utf8');
    for (const f of ['main.js', 'preload.js', 'discord.js']) {   // the program part too, when the site has it
      try {
        const rr = await fetch(url + 'desktop/' + f + '?t=' + Date.now(), { cache: 'no-store' }); if (!rr.ok) continue;
        const code = await rr.text(); if (code.length < 500 || !/require\('electron'\)|module\.exports/.test(code)) continue;
        const t = path.join(__dirname, f); try { fs.copyFileSync(t, t + '.prev'); } catch (err) {}
        fs.writeFileSync(t, code, 'utf8');
      } catch (err) {}
    }
    setTimeout(() => { app.relaunch(); app.exit(0); }, 400);
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
});
/* Windows: our files open with this app, and it shows up in "Open with" for .aseprite (only for this user, no admin needed) */
function registerFileTypes() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  const exe = process.execPath, mark = path.join(app.getPath('userData'), 'filetypes.txt'), V = exe + '|3';
  try { if (fs.readFileSync(mark, 'utf8') === V) return; } catch (e) {}
  const K = 'HKCU\\Software\\Classes\\', PID = 'StarmanDoesAnimations.File', APPK = K + 'Applications\\' + path.basename(exe);
  const open = '"' + exe + '" "%1"';
  const rows = [
    [K + PID, '/ve', '/d', 'Starman animation'], [K + PID, '/v', 'FriendlyTypeName', '/d', 'Starman animation'],
    [K + PID + '\\DefaultIcon', '/ve', '/d', '"' + exe + '",0'],
    [K + PID + '\\shell\\open', '/v', 'FriendlyAppName', '/d', APP_NAME],
    [K + PID + '\\shell\\open\\command', '/ve', '/d', open],
    [APPK, '/v', 'FriendlyAppName', '/d', APP_NAME],
    [APPK + '\\shell\\open\\command', '/ve', '/d', open]
  ];
  for (const x of ['sdt', 'sdv', 'sdp', 'sdz']) rows.push([K + '.' + x, '/ve', '/d', PID]);
  for (const x of ['sdt', 'sdv', 'sdp', 'sdz', 'aseprite', 'ase']) { rows.push([K + '.' + x + '\\OpenWithProgids', '/v', PID, '/d', '']); rows.push([APPK + '\\SupportedTypes', '/v', '.' + x, '/d', '']); }
  const { execFile } = require('child_process');
  let left = rows.length, bad = 0;
  for (const r of rows) execFile('reg', ['add', r[0], ...r.slice(1), '/f'], { windowsHide: true }, err => { if (err) bad++; if (--left === 0 && !bad) { try { fs.writeFileSync(mark, V); } catch (e) {} } });
}
app.whenReady().then(() => {
  try { registerFileTypes(); } catch (e) {}
  crashed = fs.existsSync(LOCK());
  createWindow();
  rpc = discord.create();
});
H('discord-config', (e, c) => { const f = discordConfig(); c = Object.assign({}, c || {}); if (!c.clientId && f) { c.clientId = f.clientId; } if (f && c.image === undefined) c.image = f.largeImage; rpc.configure(c); return rpc.status(); });
H('discord-info', (e, i) => { rpc.setInfo(i || {}); return true; });
H('discord-status', () => rpc.status());
H('discord-send', async (e, o) => { await discord.sendWebhook(o || {}); return true; });
app.on('before-quit', () => { if (rpc) rpc.stop(); try { fs.unlinkSync(LOCK()); } catch (e) {} });
app.on('window-all-closed', () => app.quit());
