import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { BackgroundMemoryRepository } from '../src/memory-repository-service.js';
import { readMemorySnapshot } from '../src/memory-repository.js';

const childMode = process.argv.includes('--suspend-child');
const suspendMs = Number(process.argv[process.argv.indexOf('--suspend-child') + 1]) || 2200;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-memory-watchdog-'));
let repository;
try {
  if (childMode) {
    const filePath = path.join(home, 'memory.json');
    repository = new BackgroundMemoryRepository({ filePath, timeoutMs: 1000 });
    const opened = await repository.open();
    opened.value.groups.fixture = { text: 'synthetic '.repeat(110000) };
    const resumer = spawn(process.execPath, ['-e',
      'setTimeout(()=>{try{process.kill(Number(process.argv[1]),"SIGCONT")}catch{}},Number(process.argv[2]))', String(process.pid), String(suspendMs)], { stdio: 'ignore' });
    resumer.unref();
    const pending = repository.commit(opened.value, { expectedRevision: opened.revision });
    process.kill(process.pid, 'SIGSTOP');
    const result = await pending;
    assert.equal(result.value.groups.fixture.text.length, opened.value.groups.fixture.text.length);
    assert.deepEqual(readMemorySnapshot(filePath), result.value);
    assert.equal(repository.status().writable, true);
    assert.equal(repository.status().recoveryRequired, false);
    assert.equal(repository.status().lastFailure, null);
    console.log('suspend-commit-confirmed');
  } else {
    // A genuinely unresponsive operation remains bounded and fail-closed.
    repository = new BackgroundMemoryRepository({ filePath: path.join(home, 'memory.json'), timeoutMs: 1 });
    await assert.rejects(repository.open(), { code: 'MEMORY_OPERATION_UNCERTAIN' });
    const status = repository.status();
    assert.equal(status.recoveryRequired, true);
    assert.equal(status.writable, false);
    assert.equal(status.lastFailure.cause, 'deadline');
    assert.equal(status.lastFailure.operation, 'open');
    assert(status.lastFailure.elapsedMs >= 1);
    assert(!JSON.stringify(status.lastFailure).includes(home));
    await assert.rejects(repository.read(), { code: 'MEMORY_LOAD_REQUIRED' });
    if (process.platform !== 'win32') {
      for (const delay of [950, 1000, 1050, 1250, 2200]) {
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--suspend-child', String(delay)], { stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '', errors = '';
        const timer = setTimeout(() => { child.kill('SIGCONT'); child.kill('SIGKILL'); reject(new Error('suspend fixture timed out')); }, 15000);
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { errors += chunk; });
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('exit', code => {
          clearTimeout(timer);
          try { assert.equal(code, 0, errors); assert.match(output, /suspend-commit-confirmed/); resolve(); }
          catch (error) { reject(error); }
        });
      });
      }
    }
    console.log(JSON.stringify({ ok: true, syntheticOnly: true, boundedDeadline: true,
      suspendedProcess: process.platform === 'win32' ? 'not_supported' : 'PASS', noWriteReplay: true }));
  }
} finally {
  await repository?.close().catch(() => {});
  fs.rmSync(home, { recursive: true, force: true });
}
