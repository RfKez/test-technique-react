'use strict';

const crypto = require('node:crypto');

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

class CrmError extends Error {
  constructor(message, { status = null, retryable = false, attempts = 0, idempotencyKey = null, retryAfterMs = null, details = null } = {}) {
    super(message);
    this.name = 'CrmError';
    this.status = status;
    this.retryable = retryable;
    this.attempts = attempts;
    this.idempotencyKey = idempotencyKey;
    this.retryAfterMs = retryAfterMs;
    this.details = details;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseRetryAfter(headerValue, nowMs = Date.now()) {
  if (headerValue == null) return null;
  const value = String(headerValue).trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - nowMs);
  return null;
}


function buildIdempotencyKey(lead) {
  const canonical = JSON.stringify([
    String(lead.listingId),
    String(lead.name ?? '').trim(),
    String(lead.email ?? '').trim().toLowerCase(),
    String(lead.phone ?? '').replace(/\s+/g, ''),
    String(lead.message ?? '').trim(),
  ]);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function validateLead(lead) {
  if (!lead || typeof lead !== 'object') throw new CrmError('Lead invalide : objet attendu');
  if (lead.listingId == null || lead.listingId === '') throw new CrmError('Lead invalide : listingId manquant');
  if (!lead.name) throw new CrmError('Lead invalide : name manquant');
  if (!lead.email && !lead.phone) throw new CrmError('Lead invalide : email ou phone requis');
}

function createCrmClient(options = {}) {
  const {
    token = process.env.CRM_API_TOKEN,
    baseUrl = process.env.CRM_BASE_URL || 'https://crm.example.com',
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    random = Math.random,
    logger = console,
    timeoutMs = 5000,
    maxAttempts = 3,
    baseDelayMs = 500,
    maxDelayMs = 8000,
    maxRetryAfterMs = 30000,
  } = options;

  if (!token) throw new Error("CRM_API_TOKEN manquant : définissez la variable d'environnement");

  const endpoint = new URL('/v1/leads', baseUrl).toString();

  const redact = (text) => String(text).split(token).join('[REDACTED]');

  function backoffDelay(attempt) {
    const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
    return Math.round(exp / 2 + random() * (exp / 2));
  }

  async function attemptOnce(body, idempotencyKey) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': idempotencyKey,
        },
        body,
        signal: controller.signal,
      });
      const text = await response.text();
      return { status: response.status, headers: response.headers, text };
    } catch (err) {
      return {
        failure: controller.signal.aborted ? 'timeout' : 'network',
        detail: redact(err && err.message ? err.message : err),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function createLead(lead, { idempotencyKey } = {}) {
    validateLead(lead);
    const key = idempotencyKey || buildIdempotencyKey(lead);
    const { listingId, name, phone, email, message } = lead;
    const body = JSON.stringify({ listingId, name, phone, email, message });

    let last = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await attemptOnce(body, key);
      let delayMs = null;

      if (result.failure) {
        last = { status: null, reason: result.failure };
      } else if (result.status >= 200 && result.status < 300) {
        try {
          return JSON.parse(result.text);
        } catch {
          throw new CrmError(`Réponse ${result.status} du CRM illisible`, { status: result.status, attempts: attempt, idempotencyKey: key });
        }
      } else if (result.status === 429) {
        const retryAfterMs = parseRetryAfter(result.headers.get('retry-after'));
        if (retryAfterMs !== null && retryAfterMs > maxRetryAfterMs) {
          throw new CrmError('Quota CRM dépassé, Retry-After trop long pour attendre en ligne', {
            status: 429, retryable: true, attempts: attempt, idempotencyKey: key, retryAfterMs,
          });
        }
        delayMs = retryAfterMs;
        last = { status: 429, reason: 'quota dépassé' };
      } else if (RETRYABLE_STATUSES.has(result.status)) {
        last = { status: result.status, reason: 'erreur temporaire' };
      } else {
        const messages = {
          400: 'Données du lead refusées par le CRM (400)',
          401: 'Authentification CRM refusée (401) : token invalide ou expiré',
        };
        throw new CrmError(messages[result.status] || `Erreur CRM non récupérable (${result.status})`, {
          status: result.status, retryable: false, attempts: attempt, idempotencyKey: key,
          details: redact(result.text).slice(0, 300),
        });
      }

      if (attempt === maxAttempts) break;
      if (delayMs === null) delayMs = backoffDelay(attempt);
      logger.warn(
        `[crmClient] tentative ${attempt}/${maxAttempts} échouée (${last.reason}${last.status ? ` ${last.status}` : ''}), nouvel essai dans ${delayMs} ms`,
        { listingId, idempotencyKey: key },
      );
      await sleep(delayMs);
    }

    throw new CrmError(
      `Création du lead abandonnée après ${maxAttempts} tentatives (${last.reason}${last.status ? ` ${last.status}` : ''})`,
      { status: last.status, retryable: true, attempts: maxAttempts, idempotencyKey: key },
    );
  }

  return { createLead };
}

let defaultClient = null;
function createLead(lead, options) {
  if (!defaultClient) defaultClient = createCrmClient();
  return defaultClient.createLead(lead, options);
}

module.exports = { createLead, createCrmClient, CrmError, parseRetryAfter, buildIdempotencyKey };
