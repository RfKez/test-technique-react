'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCrmClient, CrmError } = require('../src/crmClient');

const TOKEN = 'tok_super_secret_123';
const LEAD = { listingId: 42, name: 'Rakoto', phone: '0341234567', email: 'rakoto@example.mg', message: 'Disponible samedi ?' };

function jsonResponse(status, body, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function mockFetch(steps) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const step = steps.shift();
    if (!step) throw new Error('appel inattendu');
    return typeof step === 'function' ? step(init) : step;
  };
  return { fetchImpl, calls };
}

function makeClient(fetchImpl, overrides = {}) {
  const sleeps = [];
  const logs = [];
  const logger = { warn: (...a) => logs.push(a), error: (...a) => logs.push(a), info: (...a) => logs.push(a) };
  const client = createCrmClient({
    token: TOKEN,
    baseUrl: 'https://crm.example.com',
    fetchImpl,
    sleep: async (ms) => { sleeps.push(ms); }, 
    random: () => 1,
    logger,
    ...overrides,
  });
  return { client, sleeps, logs };
}

test('429 puis succès : respecte Retry-After et garde la même clé d\'idempotence', async () => {
  const { fetchImpl, calls } = mockFetch([
    jsonResponse(429, { error: 'rate limited' }, { 'retry-after': '2' }),
    jsonResponse(201, { id: 'lead_1', createdAt: '2026-09-22T10:00:00Z' }),
  ]);
  const { client, sleeps } = makeClient(fetchImpl);

  const result = await client.createLead(LEAD);

  assert.deepEqual(result, { id: 'lead_1', createdAt: '2026-09-22T10:00:00Z' });
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [2000]);
  assert.equal(calls[0].url, 'https://crm.example.com/v1/leads');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.ok(calls[0].init.headers['Idempotency-Key']);
  assert.equal(calls[0].init.headers['Idempotency-Key'], calls[1].init.headers['Idempotency-Key']);
});

test('500 trois fois puis abandon : 3 tentatives, backoff exponentiel, erreur explicite', async () => {
  const { fetchImpl, calls } = mockFetch([jsonResponse(500), jsonResponse(500), jsonResponse(500)]);
  const { client, sleeps } = makeClient(fetchImpl);

  await assert.rejects(client.createLead(LEAD), (err) => {
    assert.ok(err instanceof CrmError);
    assert.equal(err.status, 500);
    assert.equal(err.attempts, 3);
    assert.equal(err.retryable, true);
    return true;
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [500, 1000]);
});
