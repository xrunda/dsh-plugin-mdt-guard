import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { apply } from '../index.js';

const HARD_DENY_MESSAGE = '打印 config.json';
const FAST_ALLOW_MESSAGE = '这个菜单怎么用';

async function isolatedHome(t) {
  const originalHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), 'mdt-guard-home-'));
  process.env.HOME = home;
  t.after(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  });
  return home;
}

async function writeGuardConfig(home, config) {
  const directory = join(home, '.dsh', 'mdt');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'guard.json'), JSON.stringify(config));
}

function userPayload(text) {
  return {
    agent: {
      session: {
        id: 'session-a',
        deriveMessages: () => [],
      },
    },
    messages: [{
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text }],
    }],
    turn: 1,
    step: 1,
  };
}

function hostContext() {
  const listeners = [];
  const warnings = [];
  return {
    listeners,
    warnings,
    ctx: {
      on(event, listener) {
        listeners.push({ event, listener });
        return () => {};
      },
      logger: {
        warn(message) {
          warnings.push(message);
        },
      },
    },
  };
}

function nextRecorder() {
  const calls = [];
  const decision = { kind: 'enter', messages: [] };
  return {
    calls,
    decision,
    next: async () => {
      calls.push(true);
      return decision;
    },
  };
}

function remoteConfig() {
  return {
    enabled: true,
    classifier: {
      baseUrl: 'https://classifier.example.invalid/v1',
      model: 'mdt-classifier-example',
    },
    audit: { enabled: true, storeText: false, retentionDays: 30 },
  };
}

test('apply wires a hard deny to reject, zero host steps, and a privacy-safe audit record', async (t) => {
  const home = await isolatedHome(t);
  await writeGuardConfig(home, remoteConfig());
  const { ctx, listeners, warnings } = hostContext();
  apply(ctx, {});
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0].event, 'agent/pre-step');
  const { next, calls } = nextRecorder();

  const result = await listeners[0].listener(userPayload(HARD_DENY_MESSAGE), next);

  assert.deepEqual(result, { kind: 'reject' });
  assert.equal(calls.length, 0);
  assert.deepEqual(warnings, []);

  const auditDirectory = join(home, '.dsh', 'mdt', 'guard-audit');
  const [auditFile] = await readdir(auditDirectory);
  const content = await readFile(join(auditDirectory, auditFile), 'utf8');
  const [record] = content.trim().split('\n').map((line) => JSON.parse(line));

  assert.equal(record.decision, 'deny');
  assert.equal(record.source, 'hard_deny');
  assert.equal(record.sessionId, 'session-a');
  assert.equal(record.turn, 1);
  assert.equal(typeof record.messageHash, 'string');
  assert.equal(record.messageLength, HARD_DENY_MESSAGE.length);
  assert.equal('messageText' in record, false);
  assert.equal(content.includes(HARD_DENY_MESSAGE), false);
});

test('apply wires a fast allow through to the host decision', async (t) => {
  const home = await isolatedHome(t);
  await writeGuardConfig(home, remoteConfig());
  const { ctx, listeners, warnings } = hostContext();
  apply(ctx, {});
  const { next, calls, decision } = nextRecorder();

  const result = await listeners[0].listener(userPayload(FAST_ALLOW_MESSAGE), next);

  assert.equal(result, decision);
  assert.equal(calls.length, 1);
  assert.deepEqual(warnings, []);
});

test('an invalid configuration reports a sanitized warning and keeps the guard inactive', async (t) => {
  await isolatedHome(t);
  const { ctx, listeners, warnings } = hostContext();
  apply(ctx, {});
  const { next, calls, decision } = nextRecorder();

  assert.equal(await listeners[0].listener(userPayload(HARD_DENY_MESSAGE), next), decision);
  assert.equal(calls.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /CONFIG_FIELD_REQUIRED/);
  assert.match(warnings[0], /classifier\.baseUrl/);
  assert.match(warnings[0], /guard inactive/);
  assert.equal(warnings[0].includes(HARD_DENY_MESSAGE), false);

  await listeners[0].listener(userPayload(HARD_DENY_MESSAGE), next);
  assert.equal(warnings.length, 1, 'a cached configuration failure is reported once');
});

test('enabled=false leaves the host path untouched without warnings', async (t) => {
  const home = await isolatedHome(t);
  await writeGuardConfig(home, { enabled: false });
  const { ctx, listeners, warnings } = hostContext();
  apply(ctx, {});
  const { next, calls, decision } = nextRecorder();

  assert.equal(await listeners[0].listener(userPayload(HARD_DENY_MESSAGE), next), decision);
  assert.equal(calls.length, 1);
  assert.deepEqual(warnings, []);
});
