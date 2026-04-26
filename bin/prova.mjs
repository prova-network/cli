#!/usr/bin/env node
// Prova CLI entry point.
// Pure ESM, zero deps — uses only Node built-ins.

import { run } from '../src/index.mjs';
import { ApiError } from '../src/util/api.mjs';

run(process.argv.slice(2)).catch(err => {
  // Structured ApiError → show the friendly message + machine-readable
  // breadcrumbs (status, code) so users get one actionable line and
  // can grep their own logs by error code if they hit the same problem
  // again. Generic Error → fall back to message.
  if (err && err instanceof ApiError) {
    const codePart = err.code ? ` [${err.code}]` : '';
    const statusPart = err.status ? ` (HTTP ${err.status})` : '';
    console.error('\x1b[31merror:\x1b[0m ' + (err.friendlyMessage || err.detail || err.message) + codePart + statusPart);
    if (process.env.PROVA_DEBUG) {
      console.error(err.stack);
      if (err.body) console.error('\x1b[2mresponse body: ' + JSON.stringify(err.body) + '\x1b[0m');
    }
  } else {
    console.error('\x1b[31merror:\x1b[0m', (err && err.message) || err);
    if (process.env.PROVA_DEBUG && err && err.stack) console.error(err.stack);
  }
  process.exit(1);
});
