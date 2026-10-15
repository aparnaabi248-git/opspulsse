const dns = require('dns').promises;
const net = require('net');
const { URL } = require('url');
const config = require('../config');

/**
 * SSRF Guard
 * ==========
 * A monitor is a feature that lets a logged-in user make the SERVER send an
 * HTTP request to an address the user typed. Without protection that becomes
 * a Server-Side Request Forgery tool: the attacker could ask the OpsPulse
 * server to reach 127.0.0.1, 10.0.0.5, the AWS metadata service, Redis, or a
 * Kubernetes internal API, and read the response through the check result.
 *
 * Defence layers implemented here:
 *   1. Scheme allow-list            -> only http: and https:
 *   2. No credentials in the URL    -> blocks http://user:pass@host tricks
 *   3. Hostname block-list          -> localhost, *.internal, metadata hosts
 *   4. Sensitive port block-list    -> 22, 3306, 6379, 27017 ... (port scanning)
 *   5. DNS resolution + IP check    -> every resolved address must be PUBLIC
 *   6. DNS-rebinding pinning        -> the caller connects to the exact IP we
 *                                      validated, so the name cannot be
 *                                      re-resolved to an internal address
 *   7. Redirect re-validation       -> every hop is validated again (step 7)
 */

class SSRFBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SSRFBlockedError';
    this.code = 'SSRF_BLOCKED';
  }
}

// ── Blocked hostnames ────────────────────────────────────────────────
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
  'kubernetes.default',
]);

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain'];

// ── Blocked ports (internal services / DB ports) ─────────────────────
const BLOCKED_PORTS = new Set([
  22, 23, 25, 110, 143, 445, 587, 993, 995, // mail / ftp / smb
  1433, 1521, 3306, 5432, 5984, 6379, 9200, 11211, 27017, 27018, 2375, 2376, // databases / docker
  6443, 10250, 10255, // kubernetes
]);

// ── Blocked IPv4 ranges ──────────────────────────────────────────────
const BLOCKED_IPV4_RANGES = [
  ['0.0.0.0', '0.255.255.255'], // "this" network
  ['10.0.0.0', '10.255.255.255'], // private
  ['100.64.0.0', '100.127.255.255'], // carrier-grade NAT (incl. Alibaba metadata)
  ['127.0.0.0', '127.255.255.255'], // loopback
  ['169.254.0.0', '169.254.255.255'], // link-local + AWS/GCP/Azure metadata
  ['172.16.0.0', '172.31.255.255'], // private
  ['192.0.0.0', '192.0.0.255'], // IETF protocol assignments
  ['192.0.2.0', '192.0.2.255'], // TEST-NET-1
  ['192.88.99.0', '192.88.99.255'], // 6to4 relay anycast
  ['192.168.0.0', '192.168.255.255'], // private
  ['198.18.0.0', '198.19.255.255'], // benchmarking
  ['198.51.100.0', '198.51.100.255'], // TEST-NET-2
  ['203.0.113.0', '203.0.113.255'], // TEST-NET-3
  ['224.0.0.0', '239.255.255.255'], // multicast
  ['240.0.0.0', '255.255.255.255'], // reserved + broadcast
].map(([start, end]) => [ipv4ToNumber(start), ipv4ToNumber(end)]);

// ── Blocked IPv6 ranges (as 16-bit group arrays) ─────────────────────
const BLOCKED_IPV6_RANGES = [
  [['0000', '0000', '0000', '0000', '0000', '0000', '0000', '0000'], ['0000', '0000', '0000', '0000', '0000', '0000', '0000', '0001']], // :: and ::1
  [['0100', '0000', '0000', '0000', '0000', '0000', '0000', '0000'], ['0100', '0000', '0000', '0000', '0000', '0000', '0000', 'ffff']], // 100::/64 discard
  [['2001', '0db8', '0000', '0000', '0000', '0000', '0000', '0000'], ['2001', '0db8', 'ffff', 'ffff', 'ffff', 'ffff', 'ffff', 'ffff']], // documentation
  [['2002', '0000', '0000', '0000', '0000', '0000', '0000', '0000'], ['2002', 'ffff', 'ffff', 'ffff', 'ffff', 'ffff', 'ffff', 'ffff']], // 6to4
  [['fc00', '0000', '0000', '0000', '0000', '0000', '0000', '0000'], ['fdff', 'ffff', 'ffff', 'ffff', 'ffff', 'ffff', 'ffff', 'ffff']], // unique local fc00::/7
  [['fe80', '0000', '0000', '0000', '0000', '0000', '0000', '0000'], ['febf', 'ffff', 'ffff', 'ffff', 'ffff', 'ffff', 'ffff', 'ffff']], // link-local
  [['ff00', '0000', '0000', '0000', '0000', '0000', '0000', '0000'], ['ffff', 'ffff', 'ffff', 'ffff', 'ffff', 'ffff', 'ffff', 'ffff']], // multicast
];

// ── IP helpers ───────────────────────────────────────────────────────

function ipv4ToNumber(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return null;
  // use arithmetic (not <<) to stay safely inside Number.MAX_SAFE_INTEGER
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]);
}

/** Expand any IPv6 notation into 8 groups of 4 hex chars. */
function expandIPv6(input) {
  let addr = String(input).toLowerCase().split('%')[0];

  // ::ffff:192.168.0.1  ->  ::ffff:c0a8:0001
  const v4Match = addr.match(/(\d{1,3}\.){3}\d{1,3}$/);
  if (v4Match) {
    const o = v4Match[0].split('.').map(Number);
    const hi = ((o[0] * 256 + o[1]) >>> 0).toString(16).padStart(4, '0');
    const lo = ((o[2] * 256 + o[3]) >>> 0).toString(16).padStart(4, '0');
    addr = `${addr.slice(0, v4Match.index)}${hi}:${lo}`;
  }

  const hasCompression = addr.includes('::');
  const [headRaw, tailRaw] = addr.split('::');
  const head = headRaw ? headRaw.split(':').filter(Boolean) : [];
  const tail = tailRaw ? tailRaw.split(':').filter(Boolean) : [];

  let groups;
  if (hasCompression) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill('0000'), ...tail];
  } else {
    groups = addr.split(':');
  }

  if (groups.length !== 8) return null;
  return groups.map((g) => g.padStart(4, '0').slice(-4));
}

/** ::ffff:a.b.c.d -> a.b.c.d, otherwise null. */
function extractIPv4FromIPv6(groups) {
  const isMapped =
    groups.slice(0, 5).every((g) => g === '0000') && groups[5].toLowerCase() === 'ffff';
  if (!isMapped) return null;
  const hi = parseInt(groups[6], 16);
  const lo = parseInt(groups[7], 16);
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/**
 * Is this IP address something a public monitor must never reach?
 * @returns {string|null} a human readable reason, or null when the address is fine
 */
function getBlockedIpReason(address) {
  const version = net.isIP(address);

  if (version === 4) {
    const num = ipv4ToNumber(address);
    if (num === null) return 'Malformed IPv4 address';
    const hit = BLOCKED_IPV4_RANGES.find(([start, end]) => num >= start && num <= end);
    return hit ? `Address ${address} is in a reserved/private range` : null;
  }

  if (version === 6) {
    const groups = expandIPv6(address);
    if (!groups) return 'Malformed IPv6 address';

    const embeddedV4 = extractIPv4FromIPv6(groups);
    if (embeddedV4) {
      const reason = getBlockedIpReason(embeddedV4);
      if (reason) return `${reason} (IPv4-mapped IPv6)`;
    }

    // Every group must fall inside [start[i], end[i]].
    // When the group differs from the start it must be > start and <= end.
    const hit = BLOCKED_IPV6_RANGES.find(
      ([start, end]) =>
        groups.every((g, i) => {
          const gi = parseInt(g, 16);
          const si = parseInt(start[i], 16);
          const ei = parseInt(end[i], 16);
          if (gi !== si) return gi > si && gi <= ei;
          return true;
        })
    );
    if (hit) return `Address ${address} is in a reserved/private range`;
    return null;
  }

  return `Unrecognised IP address "${address}"`;
}

/** Convenience boolean wrapper (kept for tests and simple call sites). */
const isPrivateAddress = (address) => Boolean(getBlockedIpReason(address));

// ── URL parsing + validation ────────────────────────────────────────

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Normalise user input into a full absolute URL string.
 * "example.com/health" -> "http://example.com/health"
 */
const normalizeUrl = (raw) => {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new SSRFBlockedError('URL is required');
  }
  const trimmed = raw.trim();
  const withProtocol = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;

  let parsed;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new SSRFBlockedError(`"${raw}" is not a valid URL`);
  }
  return parsed;
};

const assertHostnameAllowed = (hostname) => {
  const bare = hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (BLOCKED_HOSTNAMES.has(bare)) {
    throw new SSRFBlockedError(`Hostname "${bare}" is not allowed`);
  }
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => bare.endsWith(suffix))) {
    throw new SSRFBlockedError(`Hostname "${bare}" points to an internal-only network`);
  }
};

const assertPortAllowed = (port) => {
  if (BLOCKED_PORTS.has(port)) {
    throw new SSRFBlockedError(`Port ${port} is blocked (internal services are not monitored)`);
  }
};

/**
 * Validate a URL and resolve it to concrete, public IP address(es).
 *
 * @param {string} rawUrl
 * @returns {Promise<{url:string, protocol:string, hostname:string, port:number,
 *                    path:string, address:string, family:number, allAddresses:string[]}>}
 * @throws {SSRFBlockedError}
 */
const resolveAndValidateTarget = async (rawUrl) => {
  const parsed = normalizeUrl(rawUrl);

  // Layer 1 — scheme
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new SSRFBlockedError(
      `Only http:// and https:// URLs can be monitored (received "${parsed.protocol}")`
    );
  }

  // Layer 2 — embedded credentials
  if (parsed.username || parsed.password) {
    throw new SSRFBlockedError('URLs must not contain credentials');
  }

  if (!parsed.hostname) {
    throw new SSRFBlockedError('URL is missing a hostname');
  }

  // Layer 3 — hostname block-list (also catches literal IPs written as names)
  assertHostnameAllowed(parsed.hostname);

  const isLiteralIp = net.isIP(parsed.hostname.replace(/^\[|\]$/g, '')) !== 0;

  if (!isLiteralIp) {
    // Layer 5 — resolve the name and validate EVERY answer.
    // If a DNS name returns one public and one private address we reject the
    // whole thing; otherwise an attacker could flip the record between our
    // check and our request (DNS rebinding).
    let answers;
    try {
      answers = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
    } catch (error) {
      throw new SSRFBlockedError(
        `DNS lookup for "${parsed.hostname}" failed (${error.code || error.message})`
      );
    }

    if (!answers || answers.length === 0) {
      throw new SSRFBlockedError(`DNS lookup for "${parsed.hostname}" returned no addresses`);
    }

    if (!config.security.allowPrivateTargets) {
      for (const answer of answers) {
        const reason = getBlockedIpReason(answer.address);
        if (reason) throw new SSRFBlockedError(reason);
      }
    }

    return buildTarget(parsed, answers[0].address, answers[0].family || 4, answers.map((a) => a.address));
  }

  // Literal IP address given directly
  const literal = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!config.security.allowPrivateTargets) {
    const reason = getBlockedIpReason(literal);
    if (reason) throw new SSRFBlockedError(reason);
  }

  return buildTarget(parsed, literal, net.isIP(literal), [literal]);
};

const DEFAULT_PORTS = { 'http:': 80, 'https:': 443 };

function buildTarget(parsed, address, family, allAddresses) {
  const port = parsed.port ? parseInt(parsed.port, 10) : DEFAULT_PORTS[parsed.protocol];

  // Layer 4 — sensitive port block-list
  if (!config.security.allowPrivateTargets) assertPortAllowed(port);

  return {
    url: parsed.toString(),
    protocol: parsed.protocol,
    hostname: parsed.hostname.replace(/^\[|\]$/g, ''),
    port,
    path: `${parsed.pathname}${parsed.search}`,
    address,
    family,
    allAddresses,
  };
}

/**
 * Validate a user-supplied monitor URL at create/update time.
 * Returns the normalised URL string that should be stored in MongoDB.
 *
 * @param {string} rawUrl
 * @returns {Promise<string>}
 */
const validateMonitorUrl = async (rawUrl) => {
  const target = await resolveAndValidateTarget(rawUrl);
  return target.url;
};

/**
 * Validate a redirect Location header value. Redirects are the classic way to
 * bypass an SSRF filter, so every hop goes through the exact same checks.
 */
const validateRedirect = async (location, baseUrl) => {
  let nextUrl;
  try {
    nextUrl = new URL(location, baseUrl);
  } catch {
    throw new SSRFBlockedError('Redirect target is not a valid URL');
  }
  return resolveAndValidateTarget(nextUrl.toString());
};

module.exports = {
  SSRFBlockedError,
  resolveAndValidateTarget,
  validateMonitorUrl,
  validateRedirect,
  normalizeUrl,
  isPrivateAddress,
  getBlockedIpReason,
  expandIPv6,
  extractIPv4FromIPv6,
  BLOCKED_PORTS,
  BLOCKED_HOSTNAMES,
};