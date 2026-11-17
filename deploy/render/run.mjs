import { spawn } from 'node:child_process';
import { configuration, restoreRemote, upload } from './storage.mjs';

async function main() {
  const config = configuration();
  console.log(`[9router-backup] ${await restoreRemote(config)}`);
  const child = spawn(process.execPath, ['custom-server.js'], { stdio: 'inherit' });
  let pending = Promise.resolve();
  let stopping = false;
  const save = () => {
    pending = pending.then(async () => {
      if (await upload(config)) console.log('[9router-backup] encrypted snapshot uploaded');
    }).catch(error => console.error(`[9router-backup] ${error.message}`));
    return pending;
  };
  // Do not overlap snapshots/uploads. Recursive scheduling prevents a retry queue.
  let timer;
  const tick = async () => {
    await save();
    if (!stopping) timer = setTimeout(tick, config.interval);
  };
  timer = setTimeout(tick, 10000);
  const shutdown = signal => {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    child.kill(signal);
    setTimeout(() => child.kill('SIGKILL'), 15000).unref();
    // Final upload is best-effort; periodic snapshots remain the recovery guarantee.
    setTimeout(() => process.exit(1), 25000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  child.on('error', error => {
    console.error(`[9router-backup] server launch failed: ${error.message}`);
    stopping = true; clearTimeout(timer); process.exitCode = 1;
  });
  child.on('exit', async (code, signal) => {
    stopping = true; clearTimeout(timer);
    const deadline = setTimeout(() => process.exit(1), 25000);
    await save();
    clearTimeout(deadline);
    process.exit(code ?? (signal ? 1 : 0));
  });
}
main().catch(error => {
  console.error(`[9router-backup] startup refused: ${error.message}`);
  process.exitCode = 1;
});
