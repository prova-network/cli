// `prova verify <cid> <file>` — locally verify that a file matches a claimed piece-CID.
//
// No network calls, no auth. Use this after `prova get` to confirm the bytes
// you received match the CID you asked for. Exits 0 on match, 4 on mismatch
// (consistent with the rest of the CLI's piece_cid_mismatch convention).
//
// Modes:
//   prova verify <cid> <file>         — verify file on disk matches cid
//   prova verify <cid> -              — verify stdin matches cid
//   prova verify <cid> <file> --json  — machine-readable result

import { readFile, stat } from 'node:fs/promises';
import { computeCid } from '../util/hash.mjs';
import { c, formatSize } from '../util/format.mjs';

const CID_PREFIX = 'baga';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function verifyCmd(args) {
  let cid;
  let target;
  let json = false;
  let quiet = false;

  for (const a of args) {
    if (a === '--json' || a === '-j') json = true;
    else if (a === '--quiet' || a === '-q') quiet = true;
    else if (a.startsWith('-') && a !== '-') {
      console.error(c.red(`Unknown flag: ${a}`));
      process.exit(2);
    } else if (!cid) {
      cid = a;
    } else if (!target) {
      target = a;
    } else {
      console.error(c.red('Usage: prova verify <cid> <file|-> [--json] [--quiet]'));
      process.exit(2);
    }
  }

  if (!cid || !target) {
    console.error(c.red('Usage: prova verify <cid> <file|-> [--json] [--quiet]'));
    console.error(c.dim('  Verify that <file> (or stdin if -) hashes to <cid>.'));
    process.exit(2);
  }

  if (!cid.startsWith(CID_PREFIX)) {
    console.error(c.red(`Not a piece-CID: ${cid}`));
    console.error(c.dim(`Expected to start with "${CID_PREFIX}…"`));
    process.exit(2);
  }

  let buf;
  let sourceLabel;
  let sizeBytes;

  if (target === '-') {
    if (process.stdin.isTTY) {
      console.error(c.red('No input on stdin.'));
      process.exit(1);
    }
    buf = await readStdin();
    sourceLabel = 'stdin';
    sizeBytes = buf.byteLength;
  } else {
    let info;
    try {
      info = await stat(target);
    } catch {
      console.error(c.red(`File not found: ${target}`));
      process.exit(1);
    }
    if (!info.isFile()) {
      console.error(c.red(`Not a file: ${target}`));
      process.exit(1);
    }
    buf = await readFile(target);
    sourceLabel = target;
    sizeBytes = info.size;
  }

  if (buf.byteLength === 0) {
    console.error(c.red('Cannot verify an empty input.'));
    process.exit(1);
  }

  const computed = await computeCid(buf);
  const match = computed === cid;

  if (json) {
    process.stdout.write(JSON.stringify({
      file: sourceLabel,
      size: sizeBytes,
      claimed: cid,
      computed,
      match,
    }) + '\n');
    process.exit(match ? 0 : 4);
  }

  if (match) {
    if (!quiet) {
      process.stdout.write(`${c.green('✓ match')}  ${cid}  ${sourceLabel}\n`);
      if (process.stderr.isTTY) {
        process.stderr.write(c.dim(`(${formatSize(sizeBytes)})\n`));
      }
    }
    process.exit(0);
  } else {
    if (!quiet) {
      process.stdout.write(`${c.red('✗ mismatch')}\n`);
      process.stdout.write(`  claimed:  ${cid}\n`);
      process.stdout.write(`  computed: ${computed}\n`);
      process.stdout.write(`  file:     ${sourceLabel}  (${formatSize(sizeBytes)})\n`);
    }
    process.exit(4);
  }
}
