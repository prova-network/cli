// `prova hash <file>` — compute and print the piece-CID for a local file.
//
// No network calls, no auth. Useful for:
//   - Pre-computing the piece-CID before upload (lets the client verify
//     the server's response).
//   - Verifying a downloaded file matches the claimed piece-CID without
//     trusting the server (see also `prova verify`).
//   - Scripting / pre-flight in CI.

import { readFile, stat } from 'node:fs/promises';
import { computeCid } from '../util/hash.mjs';
import { c, formatSize } from '../util/format.mjs';

export async function hashCmd(args) {
  let file;
  let json = false;

  for (const a of args) {
    if (a === '--json' || a === '-j') json = true;
    else if (a.startsWith('-')) {
      console.error(c.red(`Unknown flag: ${a}`));
      process.exit(2);
    } else if (!file) {
      file = a;
    } else {
      console.error(c.red('Usage: prova hash <file> [--json]'));
      process.exit(2);
    }
  }

  if (!file) {
    console.error(c.red('Usage: prova hash <file> [--json]'));
    process.exit(2);
  }

  let info;
  try {
    info = await stat(file);
  } catch {
    console.error(c.red(`File not found: ${file}`));
    process.exit(1);
  }
  if (!info.isFile()) {
    console.error(c.red(`Not a file: ${file}`));
    process.exit(1);
  }

  const buf = await readFile(file);
  const cid = await computeCid(buf);

  if (json) {
    process.stdout.write(JSON.stringify({
      file,
      size: info.size,
      cid,
    }) + '\n');
    return;
  }

  process.stdout.write(`${cid}  ${file}\n`);
  if (process.stderr.isTTY) {
    process.stderr.write(c.dim(`(${formatSize(info.size)})\n`));
  }
}
