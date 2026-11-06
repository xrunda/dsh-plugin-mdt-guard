import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import {
  CLASSIFIER_ERROR_CODES,
  createClassifierClient,
} from '../classifier-client.js';
import { createConnectProxy, createMockGateway } from './model-gateway/mock-gateway.mjs';
import { createTestCertificates } from './model-gateway/test-certificates.mjs';

const MESSAGES = [
  { role: 'system', content: 'classify this request' },
  { role: 'user', content: '帮我把这个病例的诊疗方案整理一下' },
];

async function createGatewayForTest(t, options = {}) {
  const certificates = await createTestCertificates();
  t.after(certificates.cleanup);
  const gateway = await createMockGateway({ ...certificates, ...options });
  t.after(gateway.close);
  return { certificates, gateway };
}

function createClient(gateway, options = {}) {
  return createClassifierClient({
    baseUrl: gateway.httpUrl,
    model: 'mdt-classifier',
    timeoutMs: 1000,
    maxTokens: 200,
    ...options,
  });
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('sends one strict chat completion request and returns allow', async (t) => {
  const { gateway } = await createGatewayForTest(t);
  const client = createClient(gateway, { maxTokens: 123 });

  const result = await client.classify(MESSAGES);

  assert.deepEqual(result, {
    decision: 'allow',
    category: 'A',
    reason: 'In-scope test request.',
    confidence: 0.95,
    degraded: false,
  });
  assert.equal(gateway.requestCount, 1);
  assert.equal(gateway.requests[0].url, '/v1/chat/completions');
  assert.deepEqual(gateway.requests[0].body, {
    model: 'mdt-classifier',
    messages: MESSAGES,
    temperature: 0,
    max_tokens: 123,
  });
  assert.equal(gateway.requests[0].headers.authorization, undefined);
});

test('accepts deny and unknown results from the classifier', async (t) => {
  const denyGateway = await createGatewayForTest(t, {
    result: { decision: 'deny', category: 'F', reason: 'out of scope', confidence: 0.8 },
  });
  const denyResult = await createClient(denyGateway.gateway).classify(MESSAGES);
  assert.equal(denyResult.decision, 'deny');
  assert.equal(denyResult.category, 'F');
  assert.equal(denyResult.degraded, false);

  const unknownGateway = await createGatewayForTest(t, {
    result: { decision: 'unknown', category: 'I', reason: 'not sure', confidence: 0.2 },
  });
  const unknownResult = await createClient(unknownGateway.gateway).classify(MESSAGES);
  assert.equal(unknownResult.decision, 'unknown');
  assert.equal(unknownResult.category, 'I');
  assert.equal(unknownResult.degraded, false);
});

test('sends the configured API key only as a bearer header', async (t) => {
  const { gateway } = await createGatewayForTest(t);
  const apiKey = 'sentinel-api-key-value';

  const result = await createClient(gateway, { apiKey }).classify(MESSAGES);

  assert.equal(gateway.requests[0].headers.authorization, `Bearer ${apiKey}`);
  assert.equal(JSON.stringify(result).includes(apiKey), false);
});

test('malformed and missing classifier fields degrade to unknown', async (t) => {
  const malformed = await createGatewayForTest(t, { mode: 'malformed' });
  const malformedResult = await createClient(malformed.gateway).classify(MESSAGES);
  assert.equal(malformedResult.decision, 'unknown');
  assert.equal(malformedResult.category, 'I');
  assert.equal(malformedResult.degraded, true);
  assert.equal(malformedResult.errorCode, CLASSIFIER_ERROR_CODES.RESPONSE);

  const missing = await createGatewayForTest(t, { mode: 'missing-fields' });
  const missingResult = await createClient(missing.gateway).classify(MESSAGES);
  assert.equal(missingResult.decision, 'unknown');
  assert.equal(missingResult.degraded, true);
  assert.equal(missingResult.errorCode, CLASSIFIER_ERROR_CODES.RESPONSE);
  assert.equal(missing.gateway.requestCount, 1);
});

test('timeout degrades to unknown, makes one request, and does not retry', async (t) => {
  const { gateway } = await createGatewayForTest(t, { mode: 'delay', delayMs: 500 });
  const client = createClient(gateway, { timeoutMs: 100 });

  const result = await client.classify(MESSAGES);

  assert.equal(result.decision, 'unknown');
  assert.equal(result.degraded, true);
  assert.equal(result.errorCode, CLASSIFIER_ERROR_CODES.TIMEOUT);
  assert.equal(gateway.requestCount, 1);
});

test('network failure degrades to unknown', async (t) => {
  const port = await unusedPort();
  const client = createClassifierClient({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: 'mdt-classifier',
    timeoutMs: 500,
  });

  const result = await client.classify(MESSAGES);

  assert.equal(result.decision, 'unknown');
  assert.equal(result.degraded, true);
  assert.equal(result.errorCode, CLASSIFIER_ERROR_CODES.NETWORK);
});

test('custom CA validates a self-signed classifier; missing CA fails closed', async (t) => {
  const { certificates, gateway } = await createGatewayForTest(t);

  const trusted = await createClient(gateway, {
    baseUrl: gateway.httpsUrl,
    caCertFile: certificates.caCertPath,
  }).classify(MESSAGES);
  assert.equal(trusted.decision, 'allow');
  assert.equal(trusted.degraded, false);

  const untrusted = await createClient(gateway, {
    baseUrl: gateway.httpsUrl,
  }).classify(MESSAGES);
  assert.equal(untrusted.decision, 'unknown');
  assert.equal(untrusted.degraded, true);
  assert.equal(untrusted.errorCode, CLASSIFIER_ERROR_CODES.NETWORK);
});

test('supports an HTTP CONNECT proxy without disabling TLS verification', async (t) => {
  const { certificates, gateway } = await createGatewayForTest(t);
  const proxy = await createConnectProxy({ originPort: gateway.httpsPort });
  t.after(proxy.close);

  const result = await createClient(gateway, {
    baseUrl: gateway.httpsUrl,
    caCertFile: certificates.caCertPath,
    proxyUrl: proxy.url,
  }).classify(MESSAGES);

  assert.equal(result.decision, 'allow');
  assert.equal(gateway.requestCount, 1);
  assert.deepEqual(proxy.connectAuthorities, [`localhost:${gateway.httpsPort}`]);
});

test('builds /v1/chat/completions from a base URL and full endpoint', async (t) => {
  const { gateway } = await createGatewayForTest(t);

  for (const baseUrl of [
    `http://127.0.0.1:${gateway.httpPort}/v1`,
    gateway.httpUrl,
  ]) {
    const result = await createClient(gateway, { baseUrl }).classify(MESSAGES);
    assert.equal(result.decision, 'allow');
  }
  assert.equal(gateway.requests[0].url, '/v1/chat/completions');
  assert.equal(gateway.requests[1].url, '/v1/chat/completions');
});

test('invalid messages degrade without making a request or logging', async (t) => {
  const { gateway } = await createGatewayForTest(t);
  const client = createClient(gateway);
  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args);
  t.after(() => {
    console.log = original;
  });

  const result = await client.classify([]);

  assert.equal(result.decision, 'unknown');
  assert.equal(result.degraded, true);
  assert.equal(result.errorCode, CLASSIFIER_ERROR_CODES.INPUT);
  assert.equal(gateway.requestCount, 0);
  assert.deepEqual(logs, []);
});
