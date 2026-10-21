/**
 * Safe handling of MongoDB driver errors.
 *
 * The Mongo driver puts a lot of detail in `error.message`, and sometimes that
 * detail includes the connection string — `MongoServerSelectionError` and
 * DNS/SRV failures carry the `cause` chain, which can hold
 * `mongodb+srv://user:password@cluster.mongodb.net/...`. Logging that raw
 * would put the database credentials into the function logs, so every error is
 * run through `redact()` before it is written anywhere.
 *
 * Two layers of protection:
 *   1. Structural redaction of connection strings and credential option dumps.
 *   2. Scrubbing of the actual username/password taken from MONGO_URI, because
 *      the driver occasionally quotes a fragment of them.
 *
 * The error *class* and *code* are always safe to keep — they are what actually
 * diagnose the failure.
 */

// `mongodb+srv://` / `mongodb://`, up to and including the `@` that ends the
// credentials. Greedy so a `@` inside the password does not defeat it.
// Keeping the host is deliberate: it is what tells you *which* cluster failed,
// and it is not a secret.
const CREDENTIALS = /(mongodb(?:\+srv)?:\/\/)([^/\s'")\]}]*)@([^/\s'")\]}]*)/gi;
// `//user:pass@host` — the credentials portion, for messages that quote the
// authority without the scheme.
const AUTHORITY = /(\/\/)([^/\s'")\]}]*)@([^/\s'")\]}]*)/g;
// Driver option dumps, e.g. `{ user: 'x', pass: 'y' }`.
const OPTION_KV = /((?:user|username|pass|password|pwd)\s*[:=]\s*)('[^']*'|"[^"]*"|\S+)/gi;

const MIN_FRAGMENT_LENGTH = 4; // below this, scrubbing would mangle real words

/**
 * Pull the username and password out of a connection string so they can be
 * scrubbed from driver messages.
 *
 * Only ever used to build a list of strings to remove — the values themselves
 * are never returned to a caller or written to a log.
 */
const credentialFragments = (uri) => {
  if (!uri || typeof uri !== 'string') return [];

  const authority = uri.replace(/^mongodb(?:\+srv)?:\/\//i, '').split('/')[0];
  const at = authority.lastIndexOf('@');
  if (at === -1) return [];

  const creds = authority.slice(0, at);
  const colon = creds.indexOf(':');
  if (colon === -1) return [creds];

  const fragments = [creds.slice(0, colon), creds.slice(colon + 1)];
  return fragments.filter((f) => f && f.length >= MIN_FRAGMENT_LENGTH);
};

const redact = (text, secrets = []) => {
  let out = String(text ?? '')
    .replace(CREDENTIALS, '$1<redacted>@$3')
    .replace(AUTHORITY, '$1<redacted>@$3')
    .replace(OPTION_KV, '$1<redacted>');

  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('<redacted>');
  }

  return out;
};

/**
 * Build a log-safe description of a thrown error.
 *
 * Pass `uri` (the connection string in use) so the credentials can be scrubbed
 * from any message that quotes them.
 *
 * @returns {{name: string, code: number|null, message: string, cause?: {name: string, message: string}}}
 */
const sanitizeError = (error, uri) => {
  const secrets = credentialFragments(uri);

  const safe = {
    name: error?.name || 'Error',
    // `code` is the driver code (e.g. 18 for auth failure, 133 for server
    // selection). `errno` covers the odd native case.
    code: error?.code ?? error?.errno ?? null,
    message: redact(error?.message ?? String(error ?? 'unknown error'), secrets),
  };

  // The cause chain is where connection strings usually end up.
  if (error?.cause) {
    safe.cause = {
      name: error.cause.name || 'Error',
      message: redact(error.cause.message ?? '', secrets),
    };
  }

  return safe;
};

module.exports = { redact, sanitizeError, credentialFragments };
