// RAMen in the browser: the page. The engine runs in worker.js; this file shows the screens and talks to it.
'use strict';

const $ = (id) => document.getElementById(id);
const screens = ['welcome', 'chats', 'chat', 'loading'];
function show(name) { for (const s of screens) $(s).hidden = s !== name; }

// ------------------------------------------------------------------ the worker

const worker = new Worker('worker.js');
let rid = 0;
const waiting = new Map();
const listeners = new Set();
worker.onmessage = (e) => {
  const m = e.data;
  if (m.rid && waiting.has(m.rid)) {
    const w = waiting.get(m.rid);
    waiting.delete(m.rid);
    if (m.t === 'error') w.reject(new Error(m.message)); else w.resolve(m);
    return;
  }
  for (const f of listeners) f(m);
};
function call(t, extra = {}) {
  return new Promise((resolve, reject) => {
    const id = ++rid;
    waiting.set(id, { resolve, reject });
    worker.postMessage(Object.assign({ t, rid: id }, extra));
  });
}

// ------------------------------------------------------------------ helpers

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const f1 = (s) => (s < 10 ? s.toFixed(2) : s.toFixed(1));
const n = (v) => v.toLocaleString('en-US');
const mb = (b) => Math.round(b / 1e6) + ' MB';

// A little Markdown for answers (bold, italics, code, lists, paragraphs). The text is escaped first.
function md(text) {
  const blocks = [];
  const parts = text.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) { blocks.push('<pre><code>' + esc(part.replace(/^[a-zA-Z0-9_+-]*\n/, '')) + '</code></pre>'); return; }
    let list = null;
    const flush = () => { if (list) { blocks.push('<' + list.tag + '>' + list.items.map((x) => '<li>' + x + '</li>').join('') + '</' + list.tag + '>'); list = null; } };
    let para = [];
    const flushPara = () => { if (para.length) { blocks.push('<p>' + para.join('<br>') + '</p>'); para = []; } };
    for (const raw of part.split('\n')) {
      const line = raw.trimEnd();
      const ul = line.match(/^\s*[-*•]\s+(.*)$/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        flushPara();
        const tag = ul ? 'ul' : 'ol';
        if (!list || list.tag !== tag) { flush(); list = { tag, items: [] }; }
        list.items.push(inline((ul || ol)[1]));
      } else if (!line.trim()) { flush(); flushPara(); }
      else { flush(); para.push(inline(line.replace(/^#{1,6}\s+/, ''))); }
    }
    flush(); flushPara();
  });
  return blocks.join('');
}
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');
}

function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ------------------------------------------------------------------ install (Add to Home Screen)

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; renderInstall(); });
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const ios = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const android = () => /Android/.test(navigator.userAgent);
const SHARE_ICON = '<svg class="share" viewBox="0 0 24 24"><path d="M12 15V4M8 8l4-4 4 4M6 11v8h12v-8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const APK = 'https://github.com/MatthewLeibel/ramen-releases/releases/latest/download/ramen-android-preview.apk';

function renderInstall() {
  for (const box of [$('install'), $('install2')]) {
    if (standalone()) { box.hidden = true; continue; }
    let html = '';
    if (ios()) html = '<p>Keep RAMen on your Home Screen: tap ' + SHARE_ICON + ' Share, then <b>Add to Home Screen</b>.</p>';
    else if (installPrompt) html = '<p><button class="btn line sm" data-install>Install RAMen</button></p>';
    if (android()) html += '<p>Or get the <a href="' + APK + '">Android app</a>.</p>';
    box.innerHTML = html;
    box.hidden = !html;
  }
  for (const b of document.querySelectorAll('[data-install]')) {
    b.onclick = async () => { if (!installPrompt) return; installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; renderInstall(); };
  }
}

// ------------------------------------------------------------------ start

let current = null;     // the open chat's id
let busy = false;

async function start() {
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  renderInstall();
  if (!(navigator.storage && navigator.storage.getDirectory) || typeof WebAssembly !== 'object') {
    show('welcome');
    $('get').disabled = true;
    showError('welcome-error', 'This browser cannot keep a model on the device. Open RAMen in Safari on iPhone, or Chrome on Android.');
    return;
  }
  const info = await call('init', testModel ? { model: testModel } : {});
  if (!info.model.have) {
    show('welcome');
    if (info.model.partial > 0) $('get').firstChild.textContent = 'Continue the download ';
    return;
  }
  await ready();
}

async function ready() {
  show('loading');
  $('loading-text').textContent = 'Getting the model ready…';
  try {
    await call('load');
  } catch (e) {
    showError('loading-error', e.message);
    $('loading-text').textContent = '';
    return;
  }
  await showChats();
}

function showError(id, msg) { const el = $(id); el.textContent = msg; el.hidden = false; }

$('get').onclick = async () => {
  $('get').disabled = true;
  $('welcome-error').hidden = true;
  $('progress').hidden = false;
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* optional */ }
  try {
    await call('download');
    await ready();
  } catch (e) {
    showError('welcome-error', e.message);
    $('get').disabled = false;
    $('get').firstChild.textContent = 'Continue the download ';
  }
};

listeners.add((m) => {
  if (m.t === 'progress') {
    const p = m.total ? m.done / m.total : 0;
    $('progress').querySelector('i').style.width = (p * 100).toFixed(1) + '%';
    $('progress-text').textContent = m.checking ? 'Checking the download…' : mb(m.done) + ' of ' + mb(m.total);
  }
});

// ------------------------------------------------------------------ the chats

async function showChats() {
  current = null;
  const r = await call('list');
  const ul = $('list');
  ul.innerHTML = '';
  for (const c of r.chats) {
    const li = document.createElement('li');
    li.innerHTML = '<button><span class="t">' + esc(c.title || 'Chat') + '</span><span class="s">' + ago(c.updated) + '</span></button>';
    li.firstChild.onclick = () => openChat(c.id);
    ul.appendChild(li);
  }
  $('empty').hidden = r.chats.length > 0;
  show('chats');
}

$('new').onclick = () => openChat(null);
$('back').onclick = () => { if (!busy) showChats(); };
$('del').onclick = async () => {
  if (busy || !current) return;
  if (!confirm('Delete this chat and its memory?')) return;
  await call('delete', { id: current });
  showChats();
};

// ------------------------------------------------------------------ one chat

function addMsg(role, text) {
  const d = document.createElement('div');
  d.className = 'msg ' + role;
  if (role === 'user') d.textContent = text; else d.innerHTML = md(text);
  $('thread').appendChild(d);
  return d;
}
function addNote(html) {
  const d = document.createElement('div');
  d.className = 'note';
  d.innerHTML = html;
  $('thread').appendChild(d);
  return d;
}
const scrollDown = () => { const t = $('thread'); t.scrollTop = t.scrollHeight; };

async function openChat(id) {
  show('chat');
  $('thread').innerHTML = '';
  $('title').textContent = 'New chat';
  const opening = id ? addNote('Opening…') : null;
  let r;
  try {
    r = await call('open', { id });
  } catch (e) {
    if (opening) opening.remove();
    addNote(esc(e.message));
    return;
  }
  if (opening) opening.remove();
  current = r.id;
  $('title').textContent = r.title || 'New chat';
  for (const m of r.messages) addMsg(m.role, m.text);
  if (r.kind === 'restored') {
    let s = 'Came back from memory in <b>' + f1(r.seconds) + ' s</b>';
    if (r.rereadSeconds > 1) s += ' (reading it again: about ' + Math.round(r.rereadSeconds) + ' s)';
    addNote(s);
  } else if (r.kind === 'reread') {
    addNote('Read this chat again in ' + f1(r.seconds) + ' s, and saved its memory for next time.');
  }
  scrollDown();
  if (!r.messages.length) $('input').focus();
}

const input = $('input');
input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + 'px'; });
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !/Android|iPhone|iPad/.test(navigator.userAgent)) { e.preventDefault(); $('composer').requestSubmit(); }
});

$('composer').onsubmit = async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || busy || !current) return;
  input.value = '';
  input.style.height = 'auto';
  await sendText(text);
};

$('stop').onclick = () => worker.postMessage({ t: 'stop' });

async function sendText(text) {
  busy = true;
  $('send').hidden = true;
  $('stop').hidden = false;
  addMsg('user', text);
  const out = addMsg('assistant', '');
  out.classList.add('writing');
  scrollDown();
  let answer = '';
  const onText = (m) => {
    if (m.t === 'text' && m.id === current) {
      answer += m.delta;
      out.innerHTML = md(answer);
      const t = $('thread');
      if (t.scrollHeight - t.scrollTop - t.clientHeight < 160) scrollDown();
    }
  };
  listeners.add(onText);
  try {
    const r = await call('send', { id: current, text });
    out.innerHTML = md(r.text);
    if ($('title').textContent === 'New chat') $('title').textContent = text.length <= 40 ? text : text.slice(0, 39) + '…';
    addNote('Read ' + n(r.newTokens) + ' new tokens in ' + f1(r.readSeconds) + ' s, wrote ' + n(r.genTokens) + ' in ' + f1(r.genSeconds) + ' s' +
      (r.saveBytes ? '. Memory saved.' : '.'));
    lastReply = r;
  } catch (e) {
    addNote(esc(e.message));
  } finally {
    listeners.delete(onText);
    out.classList.remove('writing');
    busy = false;
    $('send').hidden = false;
    $('stop').hidden = true;
    scrollDown();
  }
}

// Save the open chat's memory when the app goes to the background (it is also saved after every answer).
document.addEventListener('visibilitychange', () => { if (document.hidden && current && !busy) call('save').catch(() => {}); });

// ------------------------------------------------------------------ tests (on this computer only)

let lastReply = null;
const params = new URLSearchParams(location.search);
const testModel = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && params.get('model')
  ? { url: params.get('model'), bytes: Number(params.get('bytes')), sha256: params.get('sha256') || '' } : null;
if (testModel) {
  window.RAMEN_TEST = {
    call,
    lastReply: () => lastReply,
    send: async (id, text) => call('send', { id, text }),
  };
}

start().catch((e) => { show('welcome'); showError('welcome-error', e.message); });
