import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { configuration, encrypt, decrypt, snapshot, restore, upload, restoreRemote } from './storage.mjs';

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '9router-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
function database(dir) {
  fs.mkdirSync(path.join(dir, 'db'), { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'db/data.sqlite'));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE settings (key TEXT, value TEXT); CREATE TABLE providerConnections (id TEXT); CREATE TABLE apiKeys (id TEXT); INSERT INTO settings VALUES ('theme', 'dark');");
  fs.writeFileSync(path.join(dir, 'machine-id'), 'stable-machine');
  return db;
}
function config(dataDir, extra = {}) {
  return configuration({ DATA_DIR: dataDir, NINEROUTER_BACKUP_URL: 'https://huggingface.co/datasets/test/state/resolve/main/9router.db.backup', NINEROUTER_BACKUP_KEY: 'ab'.repeat(32), NINEROUTER_BACKUP_TOKEN: 'test-only', ...extra });
}

test('requires a separate 9Router destination and proper credentials', t => {
  const dir = temp(t);
  assert.throws(() => config(dir, { NINEROUTER_BACKUP_URL: 'https://huggingface.co/datasets/test/state/resolve/main/freellmapi.db.backup' }));
  assert.throws(() => config(dir, { NINEROUTER_BACKUP_KEY: 'bad' }));
  assert.throws(() => config(dir, { NINEROUTER_BACKUP_URL: 'https://evil.test/datasets/test/state/resolve/main/9router.db.backup' }));
  assert.throws(() => config(dir, { NINEROUTER_BACKUP_TOKEN: '' }));
});
test('encrypted online snapshot restores WAL writes and identity to a fresh directory', async t => {
  const source = temp(t), dest = temp(t); const db = database(source); t.after(() => db.close());
  const value = await snapshot(source);
  const key = crypto.randomBytes(32), payload = encrypt(value, key);
  assert.ok(!payload.includes(Buffer.from('stable-machine')));
  assert.throws(() => decrypt(payload, crypto.randomBytes(32)));
  const broken = Buffer.from(payload); broken[broken.length - 1] ^= 1;
  assert.throws(() => decrypt(broken, key));
  restore(decrypt(payload, key), dest);
  const restored = new DatabaseSync(path.join(dest, 'db/data.sqlite'));
  assert.equal(restored.prepare('SELECT value FROM settings').get().value, 'dark'); restored.close();
  assert.equal(fs.readFileSync(path.join(dest, 'machine-id'), 'utf8'), 'stable-machine');
  assert.throws(() => restore(value, dest), /overwrite/);
});
test('upload/download integration restores from a simulated Hugging Face API', async t => {
  const source = temp(t), dest = temp(t); const db = database(source); t.after(() => db.close());
  let uploaded;
  const request = async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer test-only');
    if (options.method === 'POST') {
      assert.ok(url.endsWith('/commit/main'));
      const file = JSON.parse(options.body.split('\n')[1]).value;
      assert.equal(file.path, '9router.db.backup');
      uploaded = file.content; return Response.json({ ok: true });
    }
    if (url === config(dest).repoUrl) return Response.json({ private: true });
    return new Response(uploaded);
  };
  assert.equal(await upload(config(source), request), true);
  assert.match(await restoreRemote(config(dest), request), /restored/);
  assert.ok(fs.existsSync(path.join(dest, 'db/data.sqlite')));
});
test('a missing backup needs explicit first-boot permission, auth errors always fail closed', async t => {
  const dir = temp(t); const missing = async url => url === config(dir).repoUrl ? Response.json({ private: true }) : new Response('', { status: 404 });
  await assert.rejects(restoreRemote(config(dir), missing), /404/);
  assert.match(await restoreRemote(config(dir, { NINEROUTER_BACKUP_ALLOW_EMPTY: '1' }), missing), /first boot/);
  await assert.rejects(restoreRemote(config(dir, { NINEROUTER_BACKUP_ALLOW_EMPTY: '1' }), async () => new Response('', { status: 401 })), /401/);
  assert.ok(!fs.existsSync(path.join(dir, 'db/data.sqlite')));
});
test('corrupt SQLite and path traversal do not restore a database', t => {
  const dir = temp(t);
  assert.throws(() => restore({ app: '9router', version: 1, database: Buffer.from('bad').toString('base64'), files: {} }, dir));
  assert.ok(!fs.existsSync(path.join(dir, 'db/data.sqlite')));
  assert.throws(() => restore({ app: '9router', version: 1, database: '', files: { '../evil': 'eA==' } }, dir), /manifest/);
});
test('upload failures are surfaced and absent databases are not uploaded', async t => {
  const dir = temp(t);
  assert.equal(await upload(config(dir), () => { throw new Error('must not call'); }), false);
  const db = database(dir); t.after(() => db.close());
  await assert.rejects(upload(config(dir), async () => new Response('', { status: 403 })), /403/);
});
test('a corrupt or wrong-key remote backup prevents restoration', async t => {
  const dir = temp(t);
  await assert.rejects(restoreRemote(config(dir), async () => new Response('not-a-valid-snapshot')));
  assert.ok(!fs.existsSync(path.join(dir, 'db/data.sqlite')));
});

test('refuses public or inaccessible backup repositories before writing data', async t => {
  const dir = temp(t);
  await assert.rejects(restoreRemote(config(dir), async () => Response.json({ private: false })), /private/);
  await assert.rejects(restoreRemote(config(dir, { NINEROUTER_BACKUP_ALLOW_EMPTY: '1' }), async () => new Response('', { status: 404 })), /dataset access/);
  assert.ok(!fs.existsSync(path.join(dir, 'db/data.sqlite')));
});
