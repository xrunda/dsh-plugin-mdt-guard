import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { createConnectProxy, createMockGateway } from './mock-gateway.mjs';
import { postChatCompletion, RequestTimeoutError } from './reference-client.mjs';
import { createTestCertificates } from './test-certificates.mjs';

async function createGatewayForTest(t, options = {}) {
  const certificates = await createTestCertificates();
  t.after(certificates.cleanup);
  const gateway = await createMockGateway({ ...certificates, ...options });
  t.after(gateway.close);
  return { certificates, gateway };
}

test('creates unique temporary CA and localhost server certificates', async (t) => {
  const certificates = await createTestCertificates();
  t.after(async () => {
    await certificates.cleanup();
    await assert.rejects(access(certificates.tempDir), (error) => error.code === 'ENOENT');
  });
  const secondCertificates = await createTestCertificates();
  t.after(secondCertificates.cleanup);
  assert.notEqual(certificates.tempDir, secondCertificates.tempDir);

  const paths = [
    certificates.caCertPath,
    certificates.caKeyPath,
    certificates.serverCertPath,
    certificates.serverKeyPath,
  ];

  assert.equal(new Set(paths).size, paths.length);
  for (const path of paths) {
    await access(path);
  }
});

test('mock gateway records chat completion requests and returns an OpenAI envelope', async (t) => {
  const certificates = await createTestCertificates();
  t.after(certificates.cleanup);
  const gateway = await createMockGateway(certificates);
  t.after(gateway.close);

  const body = { model: 'test-model', messages: [{ role: 'user', content: 'hello' }] };
  const response = await fetch(gateway.httpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const envelope = await response.json();

  assert.equal(response.status, 200);
  assert.equal(gateway.requests.length, 1);
  assert.equal(gateway.requests[0].method, 'POST');
  assert.equal(gateway.requests[0].url, '/v1/chat/completions');
  assert.deepEqual(gateway.requests[0].body, body);
  assert.equal(envelope.choices[0].message.role, 'assistant');
  assert.deepEqual(JSON.parse(envelope.choices[0].message.content), {
    decision: 'allow',
    category: 'A',
    reason: 'In-scope test request.',
    confidence: 0.95,
  });
});

test('mock gateway can return malformed classifier content', async (t) => {
  const certificates = await createTestCertificates();
  t.after(certificates.cleanup);
  const gateway = await createMockGateway({ ...certificates, mode: 'malformed' });
  t.after(gateway.close);

  const response = await fetch(gateway.httpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'test-model' }),
  });
  const envelope = await response.json();

  assert.equal(envelope.choices[0].message.content, '{not-json');
});

test('mock gateway can delay responses and signal handler completion', async (t) => {
  const certificates = await createTestCertificates();
  t.after(certificates.cleanup);
  const gateway = await createMockGateway({ ...certificates, mode: 'delay', delayMs: 20 });
  t.after(gateway.close);

  const responsePromise = fetch(gateway.httpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'test-model' }),
  });
  await gateway.waitForRequests(1);
  assert.equal(gateway.requests.length, 1);
  await gateway.waitForCompletions(1);
  assert.equal((await responsePromise).status, 200);
});

test('reference client sends the required chat completion request and validates the classifier result', async (t) => {
  const { gateway } = await createGatewayForTest(t);

  const result = await postChatCompletion({
    url: gateway.httpUrl,
    body: {
      model: 'test-model',
      messages: [{ role: 'user', content: 'Is this an MDT case?' }],
    },
  });

  assert.deepEqual(result, {
    decision: 'allow',
    category: 'A',
    reason: 'In-scope test request.',
    confidence: 0.95,
  });
  assert.equal(gateway.requests.length, 1);
  assert.equal(gateway.requests[0].method, 'POST');
  assert.equal(gateway.requests[0].url, '/v1/chat/completions');
  assert.deepEqual(gateway.requests[0].body, {
    model: 'test-model',
    messages: [{ role: 'user', content: 'Is this an MDT case?' }],
    temperature: 0,
    max_tokens: 200,
  });
});

test('reference client rejects malformed classifier content', async (t) => {
  const { gateway } = await createGatewayForTest(t, { mode: 'malformed' });

  await assert.rejects(
    postChatCompletion({
      url: gateway.httpUrl,
      body: {
        model: 'test-model',
        messages: [{ role: 'user', content: 'test' }],
      },
    }),
    /classifier content is not valid JSON/i,
  );
});

test('reference client times out once across the full request and does not retry', async (t) => {
  const { gateway } = await createGatewayForTest(t, { mode: 'delay', delayMs: 3500 });
  const startedAt = performance.now();

  await assert.rejects(
    postChatCompletion({
      url: gateway.httpUrl,
      body: {
        model: 'test-model',
        messages: [{ role: 'user', content: 'test' }],
      },
      timeoutMs: 1500,
    }),
    (error) => error instanceof RequestTimeoutError,
  );

  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs >= 1200 && elapsedMs <= 2500, `timeout occurred after ${elapsedMs}ms`);
  await gateway.waitForCompletions(1);
  assert.equal(gateway.requestCount, 1);
});

test('reference client enforces default TLS trust and explicit CA plus hostname validation', async (t) => {
  const { certificates, gateway } = await createGatewayForTest(t);
  const request = {
    body: {
      model: 'test-model',
      messages: [{ role: 'user', content: 'test' }],
    },
  };
  const ca = await readFile(certificates.caCertPath);

  await assert.rejects(
    postChatCompletion({ ...request, url: gateway.httpsUrl }),
    /certificate|self-signed|issuer/i,
  );

  assert.equal(
    (await postChatCompletion({ ...request, url: gateway.httpsUrl, ca })).decision,
    'allow',
  );

  await assert.rejects(
    postChatCompletion({
      ...request,
      url: gateway.httpsUrl.replace('localhost', '127.0.0.1'),
      ca,
    }),
    /hostname|IP address|does not match/i,
  );
});

test('reference client validates TLS through CONNECT proxy and checks its authority', async (t) => {
  const { certificates, gateway } = await createGatewayForTest(t);
  const proxy = await createConnectProxy({ originPort: gateway.httpsPort });
  t.after(proxy.close);
  const request = {
    body: {
      model: 'test-model',
      messages: [{ role: 'user', content: 'test' }],
    },
    url: gateway.httpsUrl,
    proxyUrl: proxy.url,
  };
  const ca = await readFile(certificates.caCertPath);

  assert.equal((await postChatCompletion({ ...request, ca })).decision, 'allow');
  assert.deepEqual(proxy.connectAuthorities, [`localhost:${gateway.httpsPort}`]);
  assert.equal(gateway.requestCount, 1);

  await assert.rejects(
    postChatCompletion({
      ...request,
      url: `https://localhost:${gateway.httpsPort + 1}/v1/chat/completions`,
      ca,
    }),
    /CONNECT proxy returned HTTP 403/i,
  );
  assert.equal(gateway.requestCount, 1);
  assert.equal(proxy.connectAuthorities[1], `localhost:${gateway.httpsPort + 1}`);

  await assert.rejects(
    postChatCompletion(request),
    /certificate|self-signed|issuer/i,
  );
  assert.equal(proxy.connectAuthorities.length, 3);

  await assert.rejects(
    postChatCompletion({
      ...request,
      url: request.url.replace('localhost', '127.0.0.1'),
      ca,
    }),
    /hostname|IP address|does not match/i,
  );
  assert.equal(proxy.connectAuthorities[3], `127.0.0.1:${gateway.httpsPort}`);
});
