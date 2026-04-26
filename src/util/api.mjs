// Tiny fetch wrapper for the Prova API.
//
// On non-2xx responses we throw a structured `ApiError` carrying:
//   - status         HTTP status code (e.g. 401, 402, 429)
//   - code           machine-readable error from the response body's
//                    `error` field (e.g. 'auth_token_expired',
//                    'quota_exceeded', 'piece_too_large')
//   - detail         human-readable explanation from the response body
//   - body           the full parsed response body (object or string)
//   - friendlyMessage short, action-oriented one-line guidance the
//                    CLI's command layer can show directly to the user
//                    without further interpretation
//
// Command modules SHOULD prefer `err.friendlyMessage` over `err.message`
// when reporting to a TTY, and fall back to `err.detail` then
// `err.message` if friendlyMessage is missing for an unknown code.

import { DEFAULT_API } from './config.mjs';

export class ApiError extends Error {
  constructor(message, { status, code, detail, body, friendlyMessage } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.body = body;
    this.friendlyMessage = friendlyMessage;
  }
}

export async function api(path, opts = {}, baseUrl = DEFAULT_API) {
  const headers = new Headers(opts.headers || {});
  if (opts.token) headers.set('authorization', `Bearer ${opts.token}`);
  if (opts.json && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  let res;
  try {
    res = await fetch(baseUrl + path, {
      method: opts.method || 'GET',
      headers,
      body: opts.json ? JSON.stringify(opts.json) : opts.body,
    });
  } catch (cause) {
    // Network-level failure (DNS, connection refused, TLS error, etc.).
    // Surface as a structured error too so command layers can branch.
    throw new ApiError(`network error reaching ${baseUrl}: ${cause.message}`, {
      status: 0,
      code: 'network_error',
      detail: cause.message,
      friendlyMessage: friendlyForNetworkError(cause, baseUrl),
    });
  }

  if (opts.raw) return res;

  const contentType = res.headers.get('content-type') || '';
  let body;
  if (contentType.includes('application/json')) {
    try {
      body = await res.json();
    } catch {
      body = '<malformed JSON response>';
    }
  } else {
    body = await res.text();
  }

  if (!res.ok) {
    const code = (typeof body === 'object' && body && body.error) || '';
    const detail = (typeof body === 'object' && body && body.detail) || res.statusText;
    const friendlyMessage = friendlyForApiError(res.status, code, detail, path);
    throw new ApiError(`API ${path} -> ${res.status}: ${detail || code || res.statusText}`, {
      status: res.status,
      code,
      detail,
      body,
      friendlyMessage,
    });
  }
  return body;
}

// ─── Friendly-message tables ────────────────────────────────────────────────

const FRIENDLY_BY_CODE = {
  // Authentication
  no_token:                'Not signed in. Run "prova auth" to sign in.',
  auth_required:           'Not signed in. Run "prova auth" to sign in.',
  invalid_token:           'Your saved token is invalid or expired. Run "prova auth" to sign in again.',
  auth_invalid_token:      'Your saved token is invalid or expired. Run "prova auth" to sign in again.',
  auth_token_expired:      'Your saved token has expired. Run "prova auth" to sign in again.',
  auth_token_revoked:      'Your token has been revoked. Run "prova auth" to mint a new one.',
  revoked_token:           'Your token has been revoked. Run "prova auth" to mint a new one.',
  auth_email_not_verified: 'Sign-in email not verified yet. Check your inbox for the magic-link code and run "prova auth" again.',
  auth_quota_zero:         'This token has no quota assigned. Buy quota or use a different account.',
  auth_offline:            'The Prova API auth backend is not configured (server-side). Try again in a moment, or contact hello@prova.network if it persists.',
  forbidden_origin:        'Request rejected because of an unrecognized origin. This is usually a bug in the CLI; please file an issue.',

  // Quota / billing
  quota_exceeded:          'You have hit your daily quota. Wait until midnight UTC, top up, or use a different token.',
  payment_required:        'Insufficient on-chain USDC allowance for this deal. Approve more USDC and retry.',
  payment_signature_invalid: 'Payment signature did not match the marketplace order. Re-sign and retry.',

  // Upload
  piece_too_large:         'This file is larger than the per-account upload cap. Split it into pieces and upload separately.',
  piece_too_small:         'This file is below the minimum piece size. Use the unanchored upload endpoint or pad the piece.',
  piece_cid_mismatch:      'The bytes were modified in transit (CID mismatch). Retry the upload.',
  invalid_cid:             'The piece-CID format was rejected by the server. Make sure you are using a "baga…" CID, not a legacy bafy CID.',

  // Retrieval
  piece_not_found:         'No active deal matches this piece-CID. The piece was never stored, or its deal was already cancelled/slashed.',
  piece_unavailable:       'The piece exists but no prover is currently serving it. Try again in a few minutes.',
  piece_proof_pending:     'The piece was uploaded but its first proof has not landed yet. Try again in 30 seconds.',

  // Deals / provers
  deal_not_found:          'No deal with that id exists on the configured chain.',
  deal_already_active:     'A deal with this piece-CID and client is already live.',
  prover_not_registered:   'The target prover is not registered in the on-chain registry.',
  prover_paused:           'The target prover is temporarily not accepting deals. Pick another prover or retry later.',
  prover_insufficient_stake: 'The target prover has insufficient bonded stake. Pick another prover.',

  // On-chain
  chain_revert:            'The on-chain transaction reverted. See `details.reason` for why.',
  chain_unsupported:       'The configured chain is not supported by this Prova deployment. Currently only Base Mainnet and Base Sepolia are supported.',
  chain_outage:            'The chain RPC endpoint is unreachable. The proof submission was queued for retry; try again in a few minutes.',

  // Disputes
  dispute_window_closed:   'The dispute window for this deal has already closed. Disputes must be opened within 24 hours of the bad proof.',
  dispute_bond_insufficient: 'Insufficient bond for this dispute. Approve more PROVA and retry.',
  dispute_already_resolved: 'This dispute has already been adjudicated.',

  // Generic
  bad_request:             'The server rejected the request as malformed. This is usually a CLI bug; please file an issue.',
  not_found:               'Resource not found, or you are not entitled to see it.',
  rate_limited:            'You are being rate-limited. Wait the indicated number of seconds (or 60s if not given) and try again.',
  internal_error:          'The server hit an unexpected error. Save the request id from `details.requestId` and report at github.com/prova-network/prova/issues.',
  not_implemented:         'This endpoint exists but the underlying feature is not yet shipped. Check the changelog for status.',

  // Magic-link auth flow (more specific than generic auth_*)
  invalid_email:           'Email address looks malformed. Double-check the spelling.',
  invalid_code:            'The 6-digit code does not match. Make sure you are using the latest code from your inbox.',
  expired_or_unknown:      'Your sign-in session expired or was already used. Start over with "prova auth".',
  too_many_attempts:       'Too many wrong codes. Wait 15 minutes and start over with "prova auth".',
};

const FRIENDLY_BY_STATUS = {
  401: 'Not signed in or token rejected. Run "prova auth" to sign in.',
  402: 'Payment required for this action. Top up your account or buy quota.',
  403: 'Forbidden. The server refused the request because of permissions or origin.',
  404: 'Not found.',
  413: 'Payload too large for this endpoint.',
  429: 'Rate-limited by the server. Wait a moment and try again.',
  500: 'Server-side error. Try again in a moment; report it at github.com/prova-network/prova/issues if it persists.',
  502: 'Upstream gateway error. Try again in a moment.',
  503: 'Service unavailable. The Prova API may be in a maintenance window; try again in a few minutes.',
};

function friendlyForApiError(status, code, detail, path) {
  if (code && FRIENDLY_BY_CODE[code]) return FRIENDLY_BY_CODE[code];
  if (FRIENDLY_BY_STATUS[status]) return FRIENDLY_BY_STATUS[status];
  return `${status} ${detail || 'request failed'} (${path})`;
}

function friendlyForNetworkError(cause, baseUrl) {
  const msg = (cause && cause.message) || '';
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) {
    return `Could not resolve ${new URL(baseUrl).host}. Check your DNS / internet connection.`;
  }
  if (/ECONNREFUSED|connect ECONN/i.test(msg)) {
    return `Connection refused at ${baseUrl}. Is the API URL correct? (Set PROVA_API to override.)`;
  }
  if (/ETIMEDOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT/i.test(msg)) {
    return `Request to ${baseUrl} timed out. Try again, or check your connection.`;
  }
  if (/CERT|TLS|SSL/i.test(msg)) {
    return `TLS/SSL error reaching ${baseUrl}: ${msg}. If you are on a corporate proxy, configure NODE_EXTRA_CA_CERTS.`;
  }
  return `Network error reaching ${baseUrl}: ${msg}`;
}
