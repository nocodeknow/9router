import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { DatabaseSync, backup } from 'node:sqlite';

const MAGIC = Buffer.from('9RBK1\0');
const MAX = 64 * 1024 * 1024;
const FILES = ['machine-id', 'auth/cli-secret', 'jwt-secret'];

export function configuration(env = process.env) {
  const url = new URL(env.NINEROUTER_BACKUP_URL);
  const match = url.pathname.match(/^\/datasets\/([\w.-]+)\/([\w.-]+)\/resolve\/main\/(9router\.db\.backup)$/);
  if (url.origin !== 'https://huggingface.co' || url.username || url.password || url.search || url.hash || !match) {
    throw new Error('Use a private Hugging Face dataset URL ending /resolve/main/9router.db.backup');
  }
  if (!/^[a-fA-F0-9]{64}$/.test(env.NINEROUTER_BACKUP_KEY || '')) throw new Error('NINEROUTER_BACKUP_KEY must be 64 hex characters');
  if (!env.NINEROUTER_BACKUP_TOKEN?.trim()) throw new Error('NINEROUTER_BACKUP_TOKEN is required');
  const interval = Number(env.NINEROUTER_BACKUP_INTERVAL_MS || 300000);
  if (!Number.isInteger(interval) || interval < 60000) throw new Error('Backup interval must be at least 60000 ms');
  return {
    url: url.href,
    repoUrl: `https://huggingface.co/api/datasets/${match[1]}/${match[2]}`,
    commitUrl: `https://huggingface.co/api/datasets/${match[1]}/${match[2]}/commit/main`,
    key: Buffer.from(env.NINEROUTER_BACKUP_KEY, 'hex'), token: env.NINEROUTER_BACKUP_TOKEN.trim(),
    dataDir: path.resolve(env.DATA_DIR || '/app/data'), interval,
    allowEmpty: env.NINEROUTER_BACKUP_ALLOW_EMPTY === '1',
  };
}

export function encrypt(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(value)))), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}
export function decrypt(payload, key) {
  if (payload.length < 34 || !payload.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not a 9Router encrypted snapshot');
  const start = MAGIC.length;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, payload.subarray(start, start + 12));
  decipher.setAuthTag(payload.subarray(start + 12, start + 28));
  const body = Buffer.concat([decipher.update(payload.subarray(start + 28)), decipher.final()]);
  return JSON.parse(gunzipSync(body, { maxOutputLength: MAX }).toString());
}
function verifyDatabase(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const check = db.prepare('PRAGMA integrity_check').get();
    if (Object.values(check)[0] !== 'ok') throw new Error('SQLite integrity check failed');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    for (const name of ['settings', 'providerConnections', 'apiKeys']) {
      if (!tables.includes(name)) throw new Error('Snapshot does not contain the expected 9Router tables');
    }
  } finally { db.close(); }
}

export async function snapshot(dataDir) {
  const file = path.join(dataDir, 'db/data.sqlite');
  if (!fs.existsSync(file)) return null;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), '9router-snapshot-'));
  try {
    const copy = path.join(temp, 'snapshot.sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    try { await backup(db, copy); } finally { db.close(); }
    if (fs.statSync(copy).size > MAX / 2) throw new Error('Database exceeds the free-deployment snapshot size limit (32 MiB)');
    verifyDatabase(copy);
    const files = {};
    for (const name of FILES) {
      const p = path.join(dataDir, name);
      if (fs.existsSync(p)) {
        if (fs.lstatSync(p).isSymbolicLink() || fs.statSync(p).size > 65536) throw new Error('Invalid identity file');
        files[name] = fs.readFileSync(p).toString('base64');
      }
    }
    return { app: '9router', version: 1, createdAt: new Date().toISOString(), database: fs.readFileSync(copy).toString('base64'), files };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

export function restore(value, dataDir) {
  if (value.app !== '9router' || value.version !== 1 || typeof value.database !== 'string' ||
      !value.files || typeof value.files !== 'object' || Array.isArray(value.files) ||
      Object.keys(value.files).some(name => !FILES.includes(name)) ||
      Object.values(value.files).some(v => typeof v !== 'string' || v.length > 90000)) {
    throw new Error('Invalid snapshot manifest');
  }
  const file = path.join(dataDir, 'db/data.sqlite');
  if (fs.existsSync(file)) throw new Error('Refusing to overwrite an existing database');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.restore-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temp, Buffer.from(value.database, 'base64'), { mode: 0o600, flag: 'wx' });
    verifyDatabase(temp);
    for (const [name, encoded] of Object.entries(value.files)) {
      const p = path.join(dataDir, name);
      if (fs.existsSync(p)) throw new Error('Refusing to overwrite an existing identity file');
      fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    }
    // All contents and destinations are validated before making the database visible.
    for (const [name, encoded] of Object.entries(value.files)) fs.writeFileSync(path.join(dataDir, name), Buffer.from(encoded, 'base64'), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}
async function limitedBody(response) {
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX) throw new Error('Remote snapshot exceeds size limit');
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); }
}
export async function restoreRemote(config, request = fetch) {
  const file = path.join(config.dataDir, 'db/data.sqlite');
  if (fs.existsSync(file)) return 'existing database';
  const metadata = await request(config.repoUrl, {
    headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(20000),
  });
  if (!metadata.ok) throw new Error(`Backup dataset access HTTP ${metadata.status}`);
  if ((await metadata.json()).private !== true) throw new Error('Backup dataset must be private');
  const response = await request(config.url, {
    headers: { Authorization: `Bearer ${config.token}` },
    signal: AbortSignal.timeout(20000),
  });
  if (response.status === 404 && config.allowEmpty) return 'first boot: no snapshot yet';
  if (!response.ok) throw new Error(`Backup restore HTTP ${response.status}; refusing to start with an empty database`);
  const text = await limitedBody(response);
  const payload = Buffer.from(text.toString(), 'base64');
  restore(decrypt(payload, config.key), config.dataDir);
  return 'restored encrypted database and identity';
}
export async function upload(config, request = fetch) {
  const value = await snapshot(config.dataDir);
  if (!value) return false;
  const content = encrypt(value, config.key).toString('base64');
  const response = await request(config.commitUrl, {
    method: 'POST', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/x-ndjson' },
    body: [
      { key: 'header', value: { summary: 'Encrypted 9Router database snapshot' } },
      { key: 'file', value: { path: '9router.db.backup', content, encoding: 'utf-8' } },
    ].map(item => JSON.stringify(item)).join('\n'),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Backup upload HTTP ${response.status}`);
  await response.body?.cancel();
  return true;
}
