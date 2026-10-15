const http = require('http');
const https = require('https');
const { performance } = require('perf_hooks');
const config = require('../config');
const logger = require('../config/logger');
const { resolveAndValidateTarget, validateRedirect, SSRFBlockedError } = require('./ssrfGuard');

/**
 * Real HTTP health check
 * ======================
 * This module performs an actual network request. There is no simulated or
 * fake result path anywhere in this file — if the target is unreachable the
 * check fails, and that failure is what gets stored.
 *
 * SSRF safety:
 *  - the destination IP is resolved and validated by ssrfGuard
 *  - the socket connects to the *validated IP*, never to a re-resolved name
 *  - redirects are followed manually and re-validated on every hop
 */

const OUTCOMES = {
  OK: 'ok',
  FAILED: 'failed',
  TIMEOUT: 'timeout',
  BLOCKED: 'blocked',
};

/** Turn a low level socket/TLS error into something a human can act on. */
function describeNetworkError(error, timeoutMs) {
  if (error instanceof SSRFBlockedError) {
    return { outcome: OUTCOMES.BLOCKED, message: `Blocked by security policy: ${error.message}` };
  }

  switch (error.code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return { outcome: OUTCOMES.FAILED, message: 'DNS lookup failed — hostname could not be resolved' };
    case 'ECONNREFUSED':
      return { outcome: OUTCOMES.FAILED, message: 'Connection refused by the host' };
    case 'ECONNRESET':
      return { outcome: OUTCOMES.FAILED, message: 'Connection reset by the host' };
    case 'EHOSTUNREACH':
      return { outcome: OUTCOMES.FAILED, message: 'Host unreachable' };
    case 'ENETUNREACH':
      return { outcome: OUTCOMES.FAILED, message: 'Network unreachable' };
    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
    case 'TIMEOUT':
      return { outcome: OUTCOMES.TIMEOUT, message: `Request timed out after ${timeoutMs} ms` };
    case 'EPROTO':
    case 'ERR_SSL_WRONG_VERSION_NUMBER':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return { outcome: OUTCOMES.FAILED, message: `TLS error: ${error.message}` };
    case 'ERR_INVALID_URL':
      return { outcome: OUTCOMES.FAILED, message: `Invalid URL: ${error.message}` };
    default:
      return { outcome: OUTCOMES.FAILED, message: error.message || 'Unknown network error' };
  }
}

/**
 * Perform one HTTP request against an already-validated target.
 * Resolves with { statusCode, headers, body, truncated }.
 */
function requestOnce(target, { method, timeoutMs, maxBodyBytes, wantBody }) {
  return new Promise((resolve, reject) => {
    const transport = target.protocol === 'https:' ? https : http;

    const defaultPort =
      (target.protocol === 'https:' && target.port === 443) ||
      (target.protocol === 'http:' && target.port === 80);

    const options = {
      protocol: target.protocol,
      // Connect to the pinned, already-validated IP (blocks DNS rebinding)
      hostname: target.address,
      port: target.port,
      path: target.path || '/',
      method,
      headers: {
        host: defaultPort ? target.hostname : `${target.hostname}:${target.port}`,
        'user-agent': config.monitor.userAgent,
        accept: '*/*',
        'accept-encoding': 'identity',
        connection: 'close',
      },
      // SNI + certificate hostname validation for https
      servername: target.hostname,
      // Never reuse pooled sockets: a reused socket could carry a connection
      // to a different, unvalidated host.
      agent: false,
      timeout: timeoutMs,
    };

    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    const req = transport.request(options, (res) => {
      const chunks = [];
      let received = 0;
      let truncated = false;

      res.on('data', (chunk) => {
        received += chunk.length;
        if (received <= maxBodyBytes) {
          chunks.push(chunk);
        } else if (!truncated) {
          truncated = true;
          // Stop the transfer early; we already have enough to judge the check
          res.destroy();
        }
      });

      res.on('end', () =>
        finish(resolve, {
          statusCode: res.statusCode,
          headers: res.headers,
          body: wantBody ? Buffer.concat(chunks).toString('utf8') : '',
          truncated,
        })
      );

      res.on('error', (err) => finish(reject, err));
      res.on('aborted', () =>
        finish(reject, Object.assign(new Error('Connection aborted by host'), { code: 'ECONNRESET' }))
      );
    });

    req.on('timeout', () => {
      req.destroy(Object.assign(new Error('Socket timeout'), { code: 'ETIMEDOUT' }));
    });

    req.on('error', (err) => finish(reject, err));

    // Guard against servers that never send headers at all
    const hardTimer = setTimeout(() => {
      req.destroy(Object.assign(new Error('Hard timeout'), { code: 'ETIMEDOUT' }));
    }, timeoutMs + 250);
    hardTimer.unref();

    req.end(() => clearTimeout(hardTimer));
  });
}

/**
 * Run a complete health check with redirect following.
 *
 * @param {object} options
 * @param {string} options.url
 * @param {string} [options.method='GET']
 * @param {number} [options.timeoutMs]
 * @param {number[]} [options.expectedStatusCodes=[200]]
 * @param {string} [options.expectedBodyText]
 * @param {number} [options.degradedThresholdMs]  0 disables DEGRADED
 * @returns {Promise<object>} check outcome
 */
async function runHealthCheck({
  url,
  method = 'GET',
  timeoutMs = config.monitor.defaultTimeoutMs,
  expectedStatusCodes = [200],
  expectedBodyText = '',
  degradedThresholdMs = config.monitor.defaultDegradedThresholdMs,
}) {
  const startedAt = performance.now();
  const deadline = startedAt + timeoutMs;
  const maxRedirects = config.monitor.maxRedirects;
  const wantBody = Boolean(expectedBodyText);

  let currentUrl = url;
  let redirects = 0;
  let resolvedIp = null;
  let errorMessage = null;
  let outcome = OUTCOMES.OK;

  let response = null;

  // ── Redirect loop (each hop is fully re-validated) ─────────────────
   
  while (true) {
    const remaining = Math.max(deadline - performance.now(), 1);
    if (performance.now() > deadline) {
      outcome = OUTCOMES.TIMEOUT;
      errorMessage = `Request timed out after ${timeoutMs} ms`;
      break;
    }

    let target;
    try {
      target = await resolveAndValidateTarget(currentUrl);
    } catch (error) {
      const described = describeNetworkError(error, timeoutMs);
      outcome = described.outcome;
      errorMessage = described.message;
      break;
    }

    resolvedIp = target.address;

    try {
       
      response = await requestOnce(target, {
        method: redirects > 0 ? 'GET' : method, // 303 and friends turn into GET
        timeoutMs: Math.min(remaining, timeoutMs),
        maxBodyBytes: config.monitor.maxResponseBodyBytes,
        wantBody,
      });
    } catch (error) {
      const described = describeNetworkError(error, timeoutMs);
      outcome = described.outcome;
      errorMessage = described.message;
      response = null;
      break;
    }

    const status = response.statusCode;
    const isRedirect = status >= 300 && status < 400 && response.headers.location;

    if (!isRedirect) break;

    if (redirects >= maxRedirects) {
      outcome = OUTCOMES.FAILED;
      errorMessage = `Too many redirects (limit ${maxRedirects})`;
      break;
    }

    try {
       
      const nextTarget = await validateRedirect(response.headers.location, target.url);
      currentUrl = nextTarget.url;
      redirects += 1;
      response = null;
    } catch (error) {
      const described = describeNetworkError(error, timeoutMs);
      outcome = OUTCOMES.BLOCKED;
      errorMessage = described.message;
      break;
    }
  }

  const responseTimeMs = Math.round(performance.now() - startedAt);

  // ── Turn the raw result into a monitor status ──────────────────────
  const base = {
    responseTimeMs,
    errorMessage,
    finalUrl: response ? currentUrl : url,
    redirected: redirects > 0,
    resolvedIp,
    statusCode: response ? response.statusCode : null,
    redirects,
  };

  if (outcome !== OUTCOMES.OK) {
    return { ...base, status: 'down', outcome };
  }

  const { statusCode, body } = response;
  const allowed = Array.isArray(expectedStatusCodes) ? expectedStatusCodes : [200];

  if (!allowed.includes(statusCode)) {
    return {
      ...base,
      status: 'down',
      outcome: OUTCOMES.FAILED,
      errorMessage: `Unexpected status code ${statusCode} (expected ${allowed.join(', ')})`,
    };
  }

  if (expectedBodyText && !body.includes(expectedBodyText)) {
    return {
      ...base,
      status: 'down',
      outcome: OUTCOMES.FAILED,
      errorMessage: `Response body does not contain the expected text "${expectedBodyText.slice(0, 60)}"`,
    };
  }

  if (degradedThresholdMs > 0 && responseTimeMs > degradedThresholdMs) {
    return {
      ...base,
      status: 'degraded',
      outcome: OUTCOMES.OK,
      errorMessage: null,
      degradedReason: `Response time ${responseTimeMs} ms exceeded the ${degradedThresholdMs} ms threshold`,
    };
  }

  return { ...base, status: 'up', outcome: OUTCOMES.OK };
}

/**
 * Small helper used by tests and diagnostics.
 */
const checkAndLog = async (options) => {
  const result = await runHealthCheck(options);
  logger.debug('Manual health check executed', {
    url: options.url,
    status: result.status,
    responseTimeMs: result.responseTimeMs,
  });
  return result;
};

module.exports = { runHealthCheck, describeNetworkError, checkAndLog, OUTCOMES };