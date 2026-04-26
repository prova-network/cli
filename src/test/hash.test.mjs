// Tests for `prova hash` and `prova verify`.
// Run with: node --test src/test/*.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { computeCid } from '../util/hash.mjs';

const CLI_BIN = fileURLToPath(new URL('../../bin/prova.mjs', import.meta.url));

function runCli(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [CLI_BIN, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => stdout += d.toString());
    proc.stderr.on('data', (d) => stderr += d.toString());
    if (opts.stdin) {
      proc.stdin.write(opts.stdin);
      proc.stdin.end();
    } else {
      proc.stdin.end();
    }
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function makeTempFile(contents) {
  const dir = await mkdtemp(join(tmpdir(), 'prova-cli-test-'));
  const path = join(dir, 'sample.bin');
  await writeFile(path, contents);
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('computeCid produces a stable baga prefix and 60+ char string', async () => {
  const cid = await computeCid(Buffer.from('hello world'));
  assert.match(cid, /^baga[a-z0-9]{50,}$/);
});

test('computeCid is deterministic across calls', async () => {
  const buf = Buffer.from('repeat me');
  const a = await computeCid(buf);
  const b = await computeCid(buf);
  assert.equal(a, b);
});

test('different inputs produce different CIDs', async () => {
  const a = await computeCid(Buffer.from('one'));
  const b = await computeCid(Buffer.from('two'));
  assert.notEqual(a, b);
});

test('computeCid rejects empty input', async () => {
  await assert.rejects(() => computeCid(Buffer.alloc(0)), /empty/);
});

test('prova hash <file> prints CID and matches computeCid', async () => {
  const { path, cleanup } = await makeTempFile('hash-cli-test\n');
  try {
    const expected = await computeCid(Buffer.from('hash-cli-test\n'));
    const { code, stdout } = await runCli(['hash', path]);
    assert.equal(code, 0);
    assert.ok(stdout.startsWith(expected), `expected stdout to start with ${expected}, got: ${stdout}`);
  } finally {
    await cleanup();
  }
});

test('prova hash --json emits valid JSON with file + size + cid', async () => {
  const { path, cleanup } = await makeTempFile('json-test-payload');
  try {
    const { code, stdout } = await runCli(['hash', path, '--json']);
    assert.equal(code, 0);
    const obj = JSON.parse(stdout.trim());
    assert.equal(obj.file, path);
    assert.equal(obj.size, 17);
    assert.match(obj.cid, /^baga/);
  } finally {
    await cleanup();
  }
});

test('prova hash exits 1 on missing file', async () => {
  const { code, stderr } = await runCli(['hash', '/no/such/file']);
  assert.equal(code, 1);
  assert.match(stderr, /File not found/);
});

test('prova hash exits 2 with no args', async () => {
  const { code, stderr } = await runCli(['hash']);
  assert.equal(code, 2);
  assert.match(stderr, /Usage/);
});

test('prova verify <cid> <file> exits 0 on match', async () => {
  const { path, cleanup } = await makeTempFile('verify-positive');
  try {
    const cid = await computeCid(Buffer.from('verify-positive'));
    const { code, stdout } = await runCli(['verify', cid, path]);
    assert.equal(code, 0);
    assert.match(stdout, /match/);
  } finally {
    await cleanup();
  }
});

test('prova verify exits 4 on mismatch', async () => {
  const { path, cleanup } = await makeTempFile('verify-negative');
  try {
    const wrongCid = 'baga6ea4reaqpit2txuhynqdtjys5jdjrn4uf532cuzij4wzrjkolrtom2yczkdi'; // valid format, wrong file
    const { code, stdout } = await runCli(['verify', wrongCid, path]);
    assert.equal(code, 4);
    assert.match(stdout, /mismatch/);
  } finally {
    await cleanup();
  }
});

test('prova verify --json emits machine-readable result', async () => {
  const { path, cleanup } = await makeTempFile('verify-json-test');
  try {
    const cid = await computeCid(Buffer.from('verify-json-test'));
    const { code, stdout } = await runCli(['verify', cid, path, '--json']);
    assert.equal(code, 0);
    const obj = JSON.parse(stdout.trim());
    assert.equal(obj.match, true);
    assert.equal(obj.claimed, cid);
    assert.equal(obj.computed, cid);
    assert.equal(obj.size, 16);
  } finally {
    await cleanup();
  }
});

test('prova verify --quiet hides successful output', async () => {
  const { path, cleanup } = await makeTempFile('verify-quiet');
  try {
    const cid = await computeCid(Buffer.from('verify-quiet'));
    const { code, stdout } = await runCli(['verify', cid, path, '--quiet']);
    assert.equal(code, 0);
    assert.equal(stdout, '');
  } finally {
    await cleanup();
  }
});

test('prova verify with stdin (-) hashes stdin contents', async () => {
  const cid = await computeCid(Buffer.from('stdin-payload'));
  const { code, stdout } = await runCli(['verify', cid, '-'], { stdin: 'stdin-payload' });
  assert.equal(code, 0);
  assert.match(stdout, /match/);
});

test('prova verify rejects non-baga prefixes', async () => {
  const { path, cleanup } = await makeTempFile('whatever');
  try {
    const { code, stderr } = await runCli(['verify', 'qmHashLooksLikeIPFSv0', path]);
    assert.equal(code, 2);
    assert.match(stderr, /Not a piece-CID/);
  } finally {
    await cleanup();
  }
});

test('prova verify exits 2 with too few args', async () => {
  const { code, stderr } = await runCli(['verify', 'baga6ea4onlyacid']);
  assert.equal(code, 2);
  assert.match(stderr, /Usage/);
});
