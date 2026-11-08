// Discord Rich Presence over the local IPC pipe, plus a webhook sender.
// The presence shows what you are making (file name, mode, frames, elapsed time) only if you allow it in Settings.
const net = require('net');

const OP_HANDSHAKE = 0, OP_FRAME = 1, OP_CLOSE = 2, OP_PING = 3, OP_PONG = 4;
const MODE_LABEL = { trad: 'Traditional animation', vector: 'Vector animation', pixel: 'Pixel art animation' };

function encode(op, data) {
  const json = Buffer.from(JSON.stringify(data), 'utf8');
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0); head.writeInt32LE(json.length, 4);
  return Buffer.concat([head, json]);
}

function pipePath(i) {
  if (process.platform === 'win32') return '\\\\?\\pipe\\discord-ipc-' + i;
  const dir = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || '/tmp';
  return dir.replace(/\/$/, '') + '/discord-ipc-' + i;
}
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

function create() {
  let cfg = { enabled: false, clientId: '', image: 'logo', showFile: true, showMode: true, showTimer: true };
  let info = { file: '', mode: '', frames: 0 };
  let sock = null, timer = null, sendT = null, lastSend = 0, ready = false, user = '', stopped = false, buf = Buffer.alloc(0), gen = 0;
  const startTs = Math.floor(Date.now() / 1000);

  const activity = () => {
    const a = { instance: false };
    if (cfg.image) a.assets = { large_image: cfg.image, large_text: 'Starman Does Animations' };
    const file = cfg.showFile ? clip(info.file, 100) : '';
    a.details = file.length >= 2 ? 'Editing ' + file : 'Making an animation';
    const bits = [];
    if (cfg.showMode && MODE_LABEL[info.mode]) bits.push(MODE_LABEL[info.mode]);
    if (cfg.showMode && info.frames > 0) bits.push(info.frames + (info.frames === 1 ? ' frame' : ' frames'));
    if (bits.length) a.state = clip(bits.join(' · '), 120);
    if (cfg.showTimer) a.timestamps = { start: startTs };
    return a;
  };
  const push = () => {
    clearTimeout(sendT);
    if (!sock || !ready) return;
    const wait = Math.max(0, 6000 - (Date.now() - lastSend));
    sendT = setTimeout(() => {
      if (!sock || !ready) return;
      lastSend = Date.now();
      try { sock.write(encode(OP_FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: activity() }, nonce: String(Date.now()) })); } catch (e) {}
    }, wait);
  };
  const disconnect = () => {
    gen++; clearTimeout(timer); clearTimeout(sendT);
    if (sock) { try { sock.write(encode(OP_FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid }, nonce: 'bye' })); } catch (e) {} try { sock.destroy(); } catch (e) {} }
    sock = null; ready = false; user = '';
  };
  const retry = () => { if (stopped || !cfg.enabled || !cfg.clientId) return; clearTimeout(timer); timer = setTimeout(connect, 15000); };
  const tryPipe = (i, g) => {
    if (g !== gen) return;
    if (i > 9) { retry(); return; }
    const s = net.createConnection(pipePath(i));
    let ok = false;
    s.once('connect', () => { if (g !== gen) { s.destroy(); return; } ok = true; sock = s; buf = Buffer.alloc(0); s.write(encode(OP_HANDSHAKE, { v: 1, client_id: cfg.clientId })); });
    s.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 8) {
        const op = buf.readInt32LE(0), len = buf.readInt32LE(4);
        if (buf.length < 8 + len) break;
        let msg = null;
        try { msg = JSON.parse(buf.slice(8, 8 + len).toString('utf8')); } catch (e) {}
        buf = buf.slice(8 + len);
        if (op === OP_PING) s.write(encode(OP_PONG, msg));
        else if (op === OP_CLOSE) s.destroy();
        else if (op === OP_FRAME && msg && msg.evt === 'READY') { ready = true; user = (msg.data && msg.data.user && (msg.data.user.global_name || msg.data.user.username)) || ''; lastSend = 0; push(); }
      }
    });
    s.on('error', () => { if (!ok) tryPipe(i + 1, g); });
    s.on('close', () => { if (ok && g === gen) { sock = null; ready = false; user = ''; retry(); } });
  };
  function connect() { if (!stopped && cfg.enabled && cfg.clientId && !sock) tryPipe(0, gen); }

  return {
    configure(c) {
      const prev = cfg;
      cfg = Object.assign({}, cfg, {
        enabled: !!c.enabled, clientId: /^\d{15,25}$/.test(String(c.clientId || '').trim()) ? String(c.clientId).trim() : '',
        image: c.image === undefined ? cfg.image : clip(c.image, 60), showFile: c.showFile !== false, showMode: c.showMode !== false, showTimer: c.showTimer !== false
      });
      if (!cfg.enabled || !cfg.clientId || cfg.clientId !== prev.clientId) disconnect();
      if (cfg.enabled && cfg.clientId) { if (!sock) connect(); else push(); }
    },
    setInfo(i) { info = { file: clip(i && i.file, 100), mode: clip(i && i.mode, 12), frames: Math.max(0, (i && i.frames) | 0) }; push(); },
    status() { return { enabled: cfg.enabled, hasId: !!cfg.clientId, connected: !!sock && ready, user }; },
    stop() { stopped = true; disconnect(); }
  };
}

// posts a file (or just a message) to a Discord webhook
async function sendWebhook({ url, name, bytes, text }) {
  if (!/^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(String(url || ''))) throw new Error('That is not a Discord webhook address');
  const form = new FormData();
  form.append('payload_json', JSON.stringify({ username: 'Starman Does Animations', content: clip(text, 1800) || undefined }));
  if (bytes && bytes.length) form.append('files[0]', new Blob([Buffer.from(bytes)]), String(name || 'animation').replace(/[^\w.\- ]+/g, '_'));
  const r = await fetch(url, { method: 'POST', body: form });
  if (!r.ok) { let m = ''; try { m = (await r.json()).message || ''; } catch (e) {} throw new Error('Discord answered ' + r.status + (m ? ': ' + m : '')); }
  return true;
}

module.exports = { create, sendWebhook };
