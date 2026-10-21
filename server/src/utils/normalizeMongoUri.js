/**
 * Normalise a MongoDB connection string before it reaches the driver.
 *
 * Pasting a URI into a dashboard environment variable goes wrong in three
 * ways, and all three surface as the same Atlas error — `MongoServerError`
 * code 8000, "bad auth: Authentication failed" — even though the value looks
 * correct:
 *
 *   1. Whitespace picked up around the value (editor, copy/paste).
 *   2. The value pasted with the quotes still around it.
 *   3. A password containing characters a URI must percent-encode (`@ : / ? #`)
 *      but which was pasted raw. The driver then reads the wrong password —
 *      or the wrong host — and authentication fails.
 *
 * All three are handled here, and all three are idempotent: a URI that is
 * already correct comes back byte-for-byte unchanged, so this is safe to
 * apply unconditionally.
 */

const URI_SCHEME = /^mongodb(?:\+srv)?:\/\//i;

const safeDecode = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    // A stray '%' that is not a valid escape. Leave it alone rather than
    // throwing — the driver reports the real problem.
    return value;
  }
};

const encode = (value) => encodeURIComponent(value);

/**
 * Percent-encode the userinfo portion of a connection string.
 *
 * Decoding first is what makes this idempotent: an already-encoded password
 * such as `P%40ss` becomes `P@ss` and is then encoded straight back to
 * `P%40ss`.
 *
 * The split is taken at the *last* `@`, so a raw `@` inside the password is
 * treated as part of the credentials rather than as the host separator.
 */
const encodeCredentials = (uri) => {
  const scheme = URI_SCHEME.exec(uri)?.[0];
  if (!scheme) return uri;

  const rest = uri.slice(scheme.length);
  const at = rest.lastIndexOf('@');
  if (at === -1) return uri; // no credentials in the string

  const userinfo = rest.slice(0, at);
  const remainder = rest.slice(at); // includes the '@'

  const colon = userinfo.indexOf(':');
  if (colon === -1) return uri; // username only — nothing to encode

  const username = encode(safeDecode(userinfo.slice(0, colon)));
  const password = encode(safeDecode(userinfo.slice(colon + 1)));

  return `${scheme}${username}:${password}${remainder}`;
};

/**
 * @param {string} raw the value of MONGO_URI, untrusted
 * @returns {string} a connection string that is safe to hand to the driver
 */
const normalizeMongoUri = (raw) => {
  if (!raw || typeof raw !== 'string') return raw;

  let uri = raw.trim();

  // Strip one pair of matching surrounding quotes — the usual result of
  // pasting a quoted value out of a dashboard or a `.env` file.
  if (uri.length >= 2) {
    const first = uri[0];
    const last = uri[uri.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      uri = uri.slice(1, -1);
    }
  }

  if (!URI_SCHEME.test(uri)) return uri;

  return encodeCredentials(uri);
};

module.exports = { normalizeMongoUri, encodeCredentials };
