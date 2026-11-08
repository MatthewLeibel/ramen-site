// RAMen in the browser: the engine's worker. One model, one chat in memory, one thing at a time.
//
// Session memory, as in the phone apps: the open chat's exact token history lives in the model's KV cache. After
// every answer it is copied to the browser's private storage (the origin private file system), one folder per chat:
//   chats/<id>/meta.json   title, messages (text), token count, the model and engine the memory was made with
//   chats/<id>/tokens.bin  the exact token history (int32, little endian)
//   chats/<id>/state.bin   the KV cache (ramen_state_get)
// Opening a chat copies state.bin back in, so the model reads only the new message, not the whole chat again.
// state.bin files beyond the budget are dropped, the least recently used first; such a chat is read again from
// tokens.bin the next time (and saved again).
'use strict';

const MODEL = {
  id: 'qwen3-0.6b',
  label: 'Qwen3 0.6B',
  file: 'Qwen3-0.6B-Q4_K_M.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_K_M.gguf',
  bytes: 396705472,
  sha256: 'ac2d97712095a558e31573f62f466a3f9d93990898b0ec79d7c974c1780d524a',
};
const N_CTX = 4096;
const N_BATCH = 256;
const MAX_REPLY = 1024;
const ENGINE = 'llama.cpp v0.9.0; ramen-web 1; q8_0; ctx ' + N_CTX;
const STATE_BUDGET = 1 << 30;   // about 1 GB of saved memory files
const MAX_STATES = 6;
// Qwen3's chat layout without thinking, the same as the phone apps (ChatFormat) and `ramen handoff`
const FIRST = '<|im_start|>user\n';
const USER_END = '<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n';
const NEXT = '<|im_end|>\n<|im_start|>user\n';

let M = null;            // the WebAssembly engine
let F = null;            // its functions
let loaded = false;
let active = null;       // { meta } of the chat the model holds
let dirty = false;
let stopFlag = false;
let modelOverride = null;   // tests on this computer only (see 'init')

const post = (m) => self.postMessage(m);
const now = () => performance.now();
const secs = (t0) => (performance.now() - t0) / 1000;

// ------------------------------------------------------------------ storage

let rootDir = null;
async function root() {
  if (!rootDir) rootDir = await navigator.storage.getDirectory();
  return rootDir;
}
async function dir(path, create = true) {
  let d = await root();
  for (const p of path.split('/').filter(Boolean)) d = await d.getDirectoryHandle(p, { create });
  return d;
}
async function fileHandle(d, name, create) {
  try { return await d.getFileHandle(name, { create }); } catch (e) { return null; }
}
async function writeBytes(d, name, bytes) {
  const fh = await d.getFileHandle(name, { create: true });
  const h = await fh.createSyncAccessHandle();
  try {
    h.truncate(0);
    let at = 0;
    while (at < bytes.length) at += h.write(bytes.subarray(at), { at });
    h.flush();
  } finally { h.close(); }
}
async function readBytes(d, name) {
  const fh = await fileHandle(d, name, false);
  if (!fh) return null;
  const h = await fh.createSyncAccessHandle();
  try {
    const out = new Uint8Array(h.getSize());
    h.read(out, { at: 0 });
    return out;
  } finally { h.close(); }
}
async function writeJson(d, name, v) { await writeBytes(d, name, new TextEncoder().encode(JSON.stringify(v))); }
async function readJson(d, name) {
  const b = await readBytes(d, name);
  if (!b) return null;
  try { return JSON.parse(new TextDecoder().decode(b)); } catch (e) { return null; }
}
async function removeEntry(d, name, recursive = false) { try { await d.removeEntry(name, { recursive }); } catch (e) { /* gone */ } }

// ------------------------------------------------------------------ the model file

async function modelState() {
  const d = await dir('models');
  const fh = await fileHandle(d, MODEL.file, false);
  const size = fh ? (await fh.getFile()).size : 0;
  const ok = await readJson(d, MODEL.file + '.ok');
  const want = modelOverride ? modelOverride.sha256 : MODEL.sha256;
  const have = size === expectedBytes() && !!ok && ok.sha256 === want;
  return { have, partial: have ? 0 : size, bytes: expectedBytes(), label: MODEL.label };
}
const expectedBytes = () => modelOverride ? modelOverride.bytes : MODEL.bytes;

// Download into models/<file>, continuing a stopped download, then check its size and SHA-256. The file counts as
// downloaded only once <file>.ok says so (written after the check).
async function download() {
  const d = await dir('models');
  const total = expectedBytes();
  const want = modelOverride ? modelOverride.sha256 : MODEL.sha256;
  await removeEntry(d, MODEL.file + '.ok');
  const fh = await d.getFileHandle(MODEL.file, { create: true });
  const h = await fh.createSyncAccessHandle();
  try {
    let have = h.getSize();
    if (have > total) { h.truncate(0); have = 0; }
    if (have < total) {
      let res;
      try {
        res = await fetch(modelOverride ? modelOverride.url : MODEL.url, { headers: have > 0 ? { Range: 'bytes=' + have + '-' } : {} });
      } catch (e) {
        throw new Error('The download could not start (' + (e && e.message) + '). Check the connection and try again.');
      }
      if (!res.ok) throw new Error('The download did not start (HTTP ' + res.status + ').');
      if (have > 0 && res.status !== 206) { h.truncate(0); have = 0; }
      const reader = res.body.getReader();
      let last = 0;
      for (;;) {
        let chunk;
        try { chunk = await reader.read(); } catch (e) { throw new Error('The download stopped (' + (e && e.message) + '). Try again: it continues from there.'); }
        const { done, value } = chunk;
        if (done) break;
        let off = 0;
        while (off < value.length) off += h.write(value.subarray(off), { at: have + off });
        have += value.length;
        if (now() - last > 250) { post({ t: 'progress', done: have, total }); last = now(); }
      }
      h.flush();
    }
    post({ t: 'progress', done: have, total, checking: true });
    if (have !== total) throw new Error('The download stopped early. Try again: it continues from there.');
    const sum = await sha256OfHandle(h, total);
    if (want && sum !== want) { h.truncate(0); throw new Error('The downloaded model did not match its checksum. Try again.'); }
  } finally { h.close(); }
  await writeJson(d, MODEL.file + '.ok', { sha256: want, at: Date.now() });
  post({ t: 'downloaded' });
}

// ------------------------------------------------------------------ SHA-256 (the model file, read in 8 MB pieces)

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);

function sha256Blocks(H, w, bytes, end) {
  for (let p = 0; p < end; p += 64) {
    for (let i = 0; i < 16; i++) {
      const j = p + i * 4;
      w[i] = (bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
}

async function sha256OfHandle(h, n) {
  const H = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Int32Array(64);
  const buf = new Uint8Array(8 << 20);   // a multiple of 64
  let at = 0, last = 0;
  while (at + buf.length <= n) {
    h.read(buf, { at });
    sha256Blocks(H, w, buf, buf.length);
    at += buf.length;
    if (now() - last > 250) { post({ t: 'progress', done: at, total: n, checking: true }); last = now(); await new Promise((r) => setTimeout(r, 0)); }
  }
  const rest = n - at;
  const tail = new Uint8Array(((rest + 9 + 63) >> 6) << 6);
  h.read(tail.subarray(0, rest), { at });
  tail[rest] = 0x80;
  const bits = n * 8;
  const dv = new DataView(tail.buffer);
  dv.setUint32(tail.length - 8, Math.floor(bits / 0x100000000));
  dv.setUint32(tail.length - 4, bits >>> 0);
  sha256Blocks(H, w, tail, tail.length);
  return Array.from(H, (x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

// ------------------------------------------------------------------ the engine

async function boot() {
  if (M) return;
  importScripts('ramen.js');
  M = await self.RamenEngine({ locateFile: (f) => f, print: () => {}, printErr: (s) => console.warn('[engine]', s) });
  const c = (n, r, a) => M.cwrap('ramen_' + n, r, a);
  F = {
    load: c('load', 'number', ['string', 'number', 'number', 'number']),
    free: c('free', null, []),
    nCtx: c('n_ctx', 'number', []),
    desc: c('desc', 'string', []),
    tokenize: c('tokenize', 'number', ['number', 'number', 'number', 'number', 'number', 'number']),
    piece: c('piece', 'number', ['number', 'number', 'number']),
    isEog: c('is_eog', 'number', ['number']),
    sampling: c('sampling', null, ['number', 'number', 'number', 'number', 'number']),
    eval: c('eval', 'number', ['number', 'number']),
    sample: c('sample', 'number', []),
    nHistory: c('n_history', 'number', []),
    history: c('history', 'number', ['number', 'number']),
    clear: c('clear', null, []),
    stateSize: c('state_size', 'number', []),
    stateGet: c('state_get', 'number', ['number', 'number']),
    stateSet: c('state_set', 'number', ['number', 'number', 'number', 'number']),
  };
}

const modelId = () => (modelOverride ? 'test:' : '') + MODEL.file + ':' + expectedBytes();

async function load() {
  await boot();
  if (loaded) return { seconds: 0 };
  const d = await dir('models');
  const fh = await fileHandle(d, MODEL.file, false);
  if (!fh) throw new Error('The model is not on this device yet.');
  const file = await fh.getFile();
  try { M.FS.mkdir('/m'); } catch (e) { /* there */ }
  try { M.FS.unmount('/m'); } catch (e) { /* not mounted */ }
  const workerfs = M.WORKERFS || (M.FS.filesystems && M.FS.filesystems.WORKERFS);
  if (!workerfs) throw new Error('This browser build cannot read the model file.');
  M.FS.mount(workerfs, { blobs: [{ name: 'model.gguf', data: file }] }, '/m');
  const t0 = now();
  const rc = F.load('/m/model.gguf', N_CTX, N_BATCH, 1);
  if (rc !== 0) throw new Error(rc === -2 ? 'This device does not have enough free memory for the model right now. Close other tabs and apps, then try again.' : 'The model could not be loaded.');
  loaded = true;
  return { seconds: secs(t0), desc: F.desc(), nCtx: F.nCtx() };
}

function tokens(text, addSpecial, special) {
  if (!text && !addSpecial) return new Int32Array(0);
  const len = M.lengthBytesUTF8(text);
  const sp = M._malloc(len + 1);
  M.stringToUTF8(text, sp, len + 1);
  let max = len + 16;
  let op = M._malloc(max * 4);
  let n = F.tokenize(sp, len, addSpecial ? 1 : 0, special ? 1 : 0, op, max);
  if (n < 0) {
    M._free(op);
    max = -n;
    op = M._malloc(max * 4);
    n = F.tokenize(sp, len, addSpecial ? 1 : 0, special ? 1 : 0, op, max);
  }
  const out = n > 0 ? M.HEAP32.slice(op >>> 2, (op >>> 2) + n) : new Int32Array(0);
  M._free(sp);
  M._free(op);
  return out;
}

const cat = (...parts) => {
  const out = new Int32Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const firstTurn = (text) => cat(tokens(FIRST, true, true), tokens(text, false, false), tokens(USER_END, false, true));
const nextTurn = (text) => cat(tokens(NEXT, false, true), tokens(text, false, false), tokens(USER_END, false, true));

function evalTokens(toks) {
  if (!toks.length) return 0;
  const p = M._malloc(toks.length * 4);
  M.HEAP32.set(toks, p >>> 2);
  const rc = F.eval(p, toks.length);
  M._free(p);
  return rc;
}

function historyTokens() {
  const n = F.nHistory();
  if (!n) return new Int32Array(0);
  const p = M._malloc(n * 4);
  F.history(p, n);
  const out = M.HEAP32.slice(p >>> 2, (p >>> 2) + n);
  M._free(p);
  return out;
}

const pieceBuf = { p: 0, n: 0 };
function piece(tok) {
  if (!pieceBuf.p) { pieceBuf.n = 256; pieceBuf.p = M._malloc(pieceBuf.n); }
  let n = F.piece(tok, pieceBuf.p, pieceBuf.n);
  if (n < 0) {
    M._free(pieceBuf.p);
    pieceBuf.n = -n;
    pieceBuf.p = M._malloc(pieceBuf.n);
    n = F.piece(tok, pieceBuf.p, pieceBuf.n);
  }
  return n > 0 ? M.HEAPU8.slice(pieceBuf.p, pieceBuf.p + n) : new Uint8Array(0);
}

// ------------------------------------------------------------------ reading speed (for "reading it again would take")

let speed = null;
async function readSpeed() {
  if (speed === null) speed = (await readJson(await root(), 'speed.json')) || {};
  return speed[modelId()] || 0;
}
async function recordSpeed(n, s) {
  if (n < 64 || s <= 0) return;
  const old = await readSpeed();
  speed[modelId()] = old > 0 ? 0.6 * old + 0.4 * (n / s) : n / s;
  await writeJson(await root(), 'speed.json', speed);
}

// ------------------------------------------------------------------ chats

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const titleFrom = (text) => {
  const line = (text.trim().split('\n').find((l) => l.trim()) || 'Chat').trim();
  return line.length <= 48 ? line : line.slice(0, 47).trimEnd() + '…';
};

async function listChats() {
  const d = await dir('chats');
  const out = [];
  for await (const [name, h] of d.entries()) {
    if (h.kind !== 'directory') continue;
    const m = await readJson(h, 'meta.json');
    if (m && m.messages && m.messages.length) out.push({ id: m.id, title: m.title, updated: m.updated, tokens: m.nTokens, memory: !!m.stateBytes });
  }
  out.sort((a, b) => b.updated - a.updated);
  return out;
}

// Write the open chat's memory, tokens and text (only when something changed).
async function saveActive() {
  if (!active || !dirty) return null;
  const meta = active.meta;
  const d = await dir('chats/' + meta.id);
  const t0 = now();
  const size = F.stateSize();
  let bytes = 0;
  if (size > 0) {
    const p = M._malloc(size);
    const got = F.stateGet(p, size);
    if (got > 0) {
      meta.stateBytes = 0;   // the memory file is valid only once meta.json says so again (written last)
      await writeJson(d, 'meta.json', meta);
      await writeBytes(d, 'state.bin', M.HEAPU8.subarray(p, p + got));
      bytes = got;
    }
    M._free(p);
  }
  const toks = historyTokens();
  await writeBytes(d, 'tokens.bin', new Uint8Array(toks.buffer, toks.byteOffset, toks.byteLength));
  meta.nTokens = toks.length;
  meta.modelId = modelId();
  meta.engine = ENGINE;
  meta.stateBytes = bytes;
  meta.updated = meta.used = Date.now();
  await writeJson(d, 'meta.json', meta);
  dirty = false;
  await evict(meta.id);
  return { bytes, seconds: secs(t0) };
}

// Drop the least recently used memory files beyond the budget (the chats themselves stay).
async function evict(keepId) {
  const d = await dir('chats');
  const states = [];
  for await (const [name, h] of d.entries()) {
    if (h.kind !== 'directory') continue;
    const m = await readJson(h, 'meta.json');
    if (m && m.stateBytes > 0) states.push({ h, m });
  }
  states.sort((a, b) => (b.m.used || 0) - (a.m.used || 0));
  let total = 0;
  for (let i = 0; i < states.length; i++) {
    const { h, m } = states[i];
    total += m.stateBytes;
    if (m.id !== keepId && (total > STATE_BUDGET || i >= MAX_STATES)) {
      total -= m.stateBytes;
      m.stateBytes = 0;
      await writeJson(h, 'meta.json', m);
      await removeEntry(h, 'state.bin');
    }
  }
}

// Put chat [id] into the model (or start one). How: 'new', 'memory' (it was there), 'restored' (from its memory
// file) or 'reread' (from its tokens or text, slower; its memory is saved again for next time).
async function openChat(id) {
  await load();
  if (id && active && active.meta.id === id) return { kind: 'memory', id, meta: active.meta, seconds: 0, tokens: F.nHistory() };
  await saveActive();
  const d = id ? await dir('chats/' + id) : null;
  const meta = (d && await readJson(d, 'meta.json')) ||
    { id: id || newId(), title: '', created: Date.now(), updated: Date.now(), messages: [], nTokens: 0, modelId: '', engine: '', stateBytes: 0 };
  active = { meta };
  dirty = false;
  if (!meta.messages.length) {
    F.clear();
    return { kind: 'new', id: meta.id, meta, seconds: 0, tokens: 0 };
  }
  const same = meta.modelId === modelId() && meta.engine === ENGINE;
  if (same && meta.stateBytes > 0) {
    const t0 = now();
    const fh = await fileHandle(d, 'state.bin', false);
    const tb = await readBytes(d, 'tokens.bin');
    if (fh && tb && tb.length === meta.nTokens * 4) {
      const h = await fh.createSyncAccessHandle();
      let rc = -1;
      try {
        const size = h.getSize();
        if (size === meta.stateBytes) {
          const p = M._malloc(size);
          h.read(M.HEAPU8.subarray(p, p + size), { at: 0 });
          const tp = M._malloc(tb.length);
          M.HEAPU8.set(tb, tp);
          rc = F.stateSet(p, size, tp, meta.nTokens);
          M._free(tp);
          M._free(p);
        }
      } finally { h.close(); }
      if (rc > 0) {
        meta.used = Date.now();
        await writeJson(d, 'meta.json', meta);
        const s = secs(t0);
        const tps = await readSpeed();
        return { kind: 'restored', id: meta.id, meta, seconds: s, tokens: rc, rereadSeconds: tps > 0 ? rc / tps : 0 };
      }
    }
  }
  // Slow path: the memory file was dropped, or it was made with another model or engine: read the chat again.
  let toks = null;
  if (meta.modelId === modelId()) {
    const tb = await readBytes(d, 'tokens.bin');
    if (tb && tb.length === meta.nTokens * 4) toks = new Int32Array(tb.buffer, tb.byteOffset, meta.nTokens).slice();
  }
  if (!toks) {
    const parts = [];
    let first = true;
    for (const m of meta.messages) {
      if (m.role === 'user') { parts.push(first ? firstTurn(m.text) : nextTurn(m.text)); first = false; }
      else parts.push(tokens(m.text, false, false));
    }
    toks = cat(...parts);
  }
  if (toks.length + 16 > N_CTX) throw new Error('This chat is longer than the model holds here. Start a new chat.');
  F.clear();
  const t0 = now();
  const rc = evalTokens(toks);
  const s = secs(t0);
  if (rc !== 0) { F.clear(); throw new Error('This chat could not be read (error ' + rc + ').'); }
  await recordSpeed(toks.length, s);
  dirty = true;
  await saveActive();
  return { kind: 'reread', id: meta.id, meta, seconds: s, tokens: toks.length };
}

async function send(id, text) {
  if (!active || active.meta.id !== id) await openChat(id);
  const meta = active.meta;
  const turn = F.nHistory() === 0 ? firstTurn(text) : nextTurn(text);
  if (F.nHistory() + turn.length + 16 > N_CTX) throw new Error('This chat is full (' + N_CTX.toLocaleString('en-US') + ' tokens). Start a new chat.');
  stopFlag = false;
  const t0 = now();
  const rc = evalTokens(turn);
  const readS = secs(t0);
  if (rc !== 0) throw new Error('The model could not read the message (error ' + rc + ').');
  await recordSpeed(turn.length, readS);
  dirty = true;
  meta.messages.push({ role: 'user', text });
  if (!meta.title) meta.title = titleFrom(text);
  post({ t: 'read', id, newTokens: turn.length, seconds: readS });

  F.sampling(0.7, 20, 0.8, 0, (Math.random() * 0x7fffffff) | 0);
  const dec = new TextDecoder();
  let answer = '';
  let n = 0;
  const g0 = now();
  let lastPost = 0;
  let pending = '';
  while (n < MAX_REPLY && !stopFlag) {
    if (F.nHistory() >= N_CTX - 1) break;
    const tok = F.sample();
    if (tok < 0 || F.isEog(tok)) break;
    const one = new Int32Array([tok]);
    if (evalTokens(one) !== 0) break;
    n++;
    const s = dec.decode(piece(tok), { stream: true });
    answer += s;
    pending += s;
    if (now() - lastPost > 60) {
      post({ t: 'text', id, delta: pending });
      pending = '';
      lastPost = now();
      await new Promise((r) => setTimeout(r, 0));   // lets a Stop message in
    }
  }
  const tail = dec.decode();
  answer += tail;
  pending += tail;
  if (pending) post({ t: 'text', id, delta: pending });
  const genS = secs(g0);
  meta.messages.push({ role: 'assistant', text: answer.trim() });
  const save = await saveActive();
  return { id, text: answer.trim(), newTokens: turn.length, readSeconds: readS, genTokens: n, genSeconds: genS, totalTokens: F.nHistory(), saveBytes: save ? save.bytes : 0, saveSeconds: save ? save.seconds : 0, stopped: stopFlag };
}

async function deleteChat(id) {
  if (active && active.meta.id === id) { F.clear(); active = null; dirty = false; }
  await removeEntry(await dir('chats'), id, true);
}

// ------------------------------------------------------------------ messages from the page (one at a time)

let queue = Promise.resolve();
self.onmessage = (e) => {
  const m = e.data || {};
  if (m.t === 'stop') { stopFlag = true; return; }
  queue = queue.then(() => handle(m)).catch((err) => post({ t: 'error', rid: m.rid, message: (err && err.message) || String(err) }));
};

async function handle(m) {
  const reply = (v) => post(Object.assign({ t: 'ok', rid: m.rid }, v));
  switch (m.t) {
    case 'init': {
      // Tests on this computer may use a model served next to the page (never on the website itself).
      if (m.model && /^(localhost|127\.0\.0\.1)$/.test(self.location.hostname)) modelOverride = m.model;
      const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      const est = navigator.storage.estimate ? await navigator.storage.estimate() : {};
      return reply({ model: await modelState(), persisted, quota: est.quota || 0, usage: est.usage || 0 });
    }
    case 'download': await download(); return reply({});
    case 'load': return reply(await load());
    case 'list': return reply({ chats: await listChats() });
    case 'open': {
      const r = await openChat(m.id || null);
      return reply({ kind: r.kind, id: r.id, seconds: r.seconds, tokens: r.tokens, rereadSeconds: r.rereadSeconds || 0, messages: r.meta.messages, title: r.meta.title });
    }
    case 'send': return reply(await send(m.id, m.text));
    case 'save': return reply({ save: await saveActive() });
    case 'delete': await deleteChat(m.id); return reply({});
    default: throw new Error('unknown request ' + m.t);
  }
}
