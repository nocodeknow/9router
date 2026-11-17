import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));
test('supervisor saves on shutdown and restores before launching the child', { timeout: 20000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '9router-supervisor-'));
  const data = path.join(root, 'data');
  const remote = path.join(root, 'remote-backup');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'transport.mjs'), `
    import fs from 'node:fs';
    globalThis.fetch = async (url, options) => {
      if (options.method === 'POST') {
        fs.writeFileSync(process.env.TEST_REMOTE, JSON.parse(options.body.split('\\n')[1]).value.content);
        return Response.json({ ok: true });
      }
      if (url.endsWith('/test/state')) return Response.json({ private: true });
      return fs.existsSync(process.env.TEST_REMOTE) ? new Response(fs.readFileSync(process.env.TEST_REMOTE)) : new Response('', { status: 404 });
    };
  `);
  fs.writeFileSync(path.join(root, 'custom-server.js'), `
    const { DatabaseSync } = require('node:sqlite');
    const fs = require('node:fs'); const path = require('node:path');
    fs.mkdirSync(path.join(process.env.DATA_DIR, 'db'), { recursive: true });
    const db = new DatabaseSync(path.join(process.env.DATA_DIR, 'db/data.sqlite'));
    db.exec("CREATE TABLE IF NOT EXISTS settings (value TEXT); CREATE TABLE IF NOT EXISTS providerConnections (id TEXT); CREATE TABLE IF NOT EXISTS apiKeys (id TEXT);");
    const rows = db.prepare('SELECT value FROM settings').all();
    if (!rows.length) db.exec("INSERT INTO settings VALUES ('saved-preference')");
    console.log(rows.length ? 'CHILD_RESTORED' : 'CHILD_NEW');
    const timer = setInterval(() => {}, 1000);
    process.on('SIGTERM', () => { clearInterval(timer); db.close(); process.exit(0); });
  `);
  async function run(first) {
    const child = spawn(process.execPath, ['--import', path.join(root, 'transport.mjs'), runner], {
      cwd: root, env: { ...process.env, DATA_DIR: data, TEST_REMOTE: remote,
        NINEROUTER_BACKUP_URL: 'https://huggingface.co/datasets/test/state/resolve/main/9router.db.backup',
        NINEROUTER_BACKUP_TOKEN: 'fixture-only', NINEROUTER_BACKUP_KEY: 'ab'.repeat(32),
        NINEROUTER_BACKUP_ALLOW_EMPTY: first ? '1' : '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes(first ? 'CHILD_NEW' : 'CHILD_RESTORED')) child.kill('SIGTERM');
    });
    child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    assert.equal(code, 0, output);
    assert.match(output, /encrypted snapshot uploaded/);
    if (!first) assert.match(output, /restored encrypted database and identity/);
  }
  await run(true);
  assert.ok(fs.existsSync(remote));
  fs.rmSync(data, { recursive: true });
  await run(false);
});
