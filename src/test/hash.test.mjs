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

// Regression tests for the multihash codec encoding in the piece-CID.
//
// Bug history: prior to 2026-04-26, encodeFilCommP() in src/util/hash.mjs
// emitted bytes (0x91 0x20) for the multihash function field. The comment
// claimed this was 0x1012 (sha2-256-trunc254-padded, the canonical
// CommP / piece-CID hash). The actual varint decoding was 0x1011, which
// is sha2-256-trunc254-padded-binary-tree-multilayer (a deprecated CommD
// aggregation hash, NOT a piece-CID hash).
//
// Effect: the Node CLI emitted CIDs starting with `baga6ea4r…` while the
// canonical FilOzone Go implementation emits `baga6ea4s…`. The 32-byte
// commitment digest payload was correct in both, so the bug was hard to
// catch — it looked like a piece-CID, parsed as a piece-CID, and would
// have round-tripped through any code that didn't strictly validate the
// multihash function code. But the on-chain ProofVerifier and any
// canonical Filecoin tooling would have rejected it.
//
// Fixed by changing the byte sequence to (0x92 0x20) which is the correct
// varint encoding of 0x1012. These tests pin the new behavior.

test('computeCid emits the canonical piece-CID prefix `baga6ea4s…`, not the buggy `baga6ea4r…`', async () => {
  const cid = await computeCid(Buffer.from('regression test for the codec bug'));
  assert.match(cid, /^baga6ea4s/, `expected 'baga6ea4s' prefix, got: ${cid}`);
  assert.doesNotMatch(cid, /^baga6ea4r/, `legacy buggy prefix detected: ${cid}`);
});

test('computeCid uses the correct multihash function code (0x1012, sha2-256-trunc254-padded)', async () => {
  // Decode the CID base32 and pull out the multihash function varint to
  // verify it's 0x1012, not 0x1011.
  const cid = await computeCid(Buffer.from('multihash codec verify'));
  assert.match(cid, /^b/, 'CID should have the base32 multibase prefix');

  // tiny base32-lower-no-pad decoder, mirrored from src/util/hash.mjs
  const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
  let val = 0, bits = 0;
  const bytes = [];
  for (const c of cid.slice(1).toLowerCase()) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) continue;
    val = (val << 5) | v;
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((val >> bits) & 0xff); }
  }

  // CIDv1 layout for fil-commitment-unsealed:
  //   bytes[0]   = 0x01  (CIDv1 marker)
  //   bytes[1..3] = 0x81 0xe2 0x03  (varint 0xf101, fil-commitment-unsealed codec)
  //   bytes[4..5] = 0x92 0x20       (varint 0x1012, sha2-256-trunc254-padded)
  //   bytes[6]   = 0x20  (32-byte digest length)
  //   bytes[7..38] = digest
  assert.equal(bytes[0], 0x01, 'CIDv1 marker');
  assert.equal(bytes[1], 0x81, 'codec varint byte 1');
  assert.equal(bytes[2], 0xe2, 'codec varint byte 2');
  assert.equal(bytes[3], 0x03, 'codec varint byte 3');
  assert.equal(bytes[4], 0x92, 'multihash fn varint byte 1 (BUG: was 0x91)');
  assert.equal(bytes[5], 0x20, 'multihash fn varint byte 2');
  assert.equal(bytes[6], 0x20, 'digest length prefix (32 bytes)');

  // Decode the multihash varint to confirm the SEMANTIC value is 0x1012.
  const fnVarint = (bytes[5] & 0x7f) << 7 | (bytes[4] & 0x7f);
  // Wait — varint decoding is little-endian: low byte first. byte4 is the
  // first byte (continuation bit set), byte5 is the second.
  // value = (byte4 & 0x7f) | ((byte5 & 0x7f) << 7)
  const decoded = (bytes[4] & 0x7f) | ((bytes[5] & 0x7f) << 7);
  assert.equal(decoded, 0x1012, `multihash fn must be 0x1012, got 0x${decoded.toString(16)}`);
});

test('computeCid output matches the canonical FilOzone go-fil-commp-hashhash implementation', async () => {
  // These piece-CIDs were produced by the canonical Go implementation
  // (github.com/filecoin-project/go-fil-commp-hashhash + go-fil-commcid)
  // running on Linux x86_64 / Go 1.25 in the Prova prover repo. The Node
  // CLI MUST produce byte-identical output for the same inputs.
  //
  // To regenerate: in prover/ on Linux, write the input to a file and
  // run `go run ./cmd/cidtest <file>`.
  const fixtures = [
    {
      input: 'Cross-implementation determinism test for Prova: Go pdptree must match the CLI Node implementation, both ports of the canonical Filecoin CommP algorithm.',
      expected: 'baga6ea4seaqhlhtpch3xor2hf6px6db5b4cfmnyfdhto4ji5na3tphwmoysbkjq',
    },
  ];
  for (const { input, expected } of fixtures) {
    const got = await computeCid(Buffer.from(input));
    assert.equal(got, expected, `mismatch for input ${JSON.stringify(input.slice(0, 40))}…`);
  }
});
