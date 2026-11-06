import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  AUDIT_CLEANUP_FAILED,
  AUDIT_WRITE_FAILED,
  createJsonlAuditWriter,
} from '../audit-log.js';

const FIXED_NOW = '2026-11-06T12:00:00.000Z';
const MESSAGE = '帮我把这个病例的诊疗方案整理一下';
const SECRET = 'sentinel-api-key';

function fixedNow() {
  return new Date(FIXED_NOW);
}

function event(overrides = {}) {
  return {
    timestamp: FIXED_NOW,
    sessionId: 'session-a',
    turn: 1,
    decision: 'deny',
    category: 'G',
    source: 'hard_deny',
    reason: 'hard_deny',
    ruleId: 'hard-deny.read-sensitive',
    confidence: 1,
    degraded: false,
    errorCode: null,
    sessionState: 'out_of_scope',
    durationMs: 4,
    apiKey: SECRET,
    hisToken: SECRET,
    certificate: SECRET,
    extra: SECRET,
    ...overrides,
  };
}

async function tempDir(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mdt-guard-audit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function readLines(content) {
  return content.trim().split('\n').map((line) => JSON.parse(line));
}

test('writes one JSONL record with a message digest and length by default', async (t) => {
  const directory = await tempDir(t);
  const writer = createJsonlAuditWriter({ directory, now: fixedNow });

  await writer.write(event(), { messageText: MESSAGE });

  const file = join(directory, '2026-11-06.jsonl');
  const content = await readFile(file, 'utf8');
  const [record] = readLines(content);

  assert.deepEqual(record, {
    timestamp: FIXED_NOW,
    sessionId: 'session-a',
    turn: 1,
    decision: 'deny',
    category: 'G',
    source: 'hard_deny',
    reason: 'hard_deny',
    ruleId: 'hard-deny.read-sensitive',
    confidence: 1,
    degraded: false,
    errorCode: null,
    sessionState: 'out_of_scope',
    durationMs: 4,
    messageHash: createHash('sha256').update(MESSAGE, 'utf8').digest('hex'),
    messageLength: MESSAGE.length,
  });
  assert.equal(content.includes(MESSAGE), false);
  assert.equal(content.includes(SECRET), false);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('explicit storeText includes the message while still dropping unrelated fields', async (t) => {
  const directory = await tempDir(t);
  const writer = createJsonlAuditWriter({
    directory,
    storeText: true,
    now: fixedNow,
  });

  await writer.write(event(), { messageText: MESSAGE });

  const content = await readFile(join(directory, '2026-11-06.jsonl'), 'utf8');
  const [record] = readLines(content);

  assert.equal(record.messageText, MESSAGE);
  assert.equal(record.messageHash, createHash('sha256').update(MESSAGE, 'utf8').digest('hex'));
  assert.equal(content.includes(SECRET), false);
});

test('appends multiple records and writes valid JSON lines', async (t) => {
  const directory = await tempDir(t);
  const writer = createJsonlAuditWriter({ directory, now: fixedNow });

  await writer.write(event({ turn: 1 }), { messageText: '第一条' });
  await writer.write(event({ turn: 2 }), { messageText: '第二条' });

  const records = readLines(await readFile(join(directory, '2026-11-06.jsonl'), 'utf8'));
  assert.equal(records.length, 2);
  assert.equal(records[0].turn, 1);
  assert.equal(records[1].turn, 2);
});

test('removes audit files older than retentionDays and keeps unrelated files', async (t) => {
  const directory = await tempDir(t);
  await Promise.all([
    writeFile(join(directory, '2026-09-01.jsonl'), '{}\n'),
    writeFile(join(directory, '2026-10-06.jsonl'), '{}\n'),
    writeFile(join(directory, '2026-10-07.jsonl'), '{}\n'),
    writeFile(join(directory, 'not-audit.jsonl'), '{}\n'),
  ]);

  const writer = createJsonlAuditWriter({ directory, retentionDays: 30, now: fixedNow });
  await writer.write(event(), { messageText: MESSAGE });

  const names = (await readdir(directory)).sort();
  assert.deepEqual(names, [
    '2026-10-07.jsonl',
    '2026-11-06.jsonl',
    'not-audit.jsonl',
  ]);
});

test('reports cleanup failures without crashing', async (t) => {
  const directory = await tempDir(t);
  const errors = [];
  const writer = createJsonlAuditWriter({
    directory,
    now: fixedNow,
    onError: (error) => errors.push(error),
  });
  await rm(directory, { recursive: true, force: true });
  await writeFile(directory, 'not a directory');

  await assert.rejects(writer.write(event(), { messageText: MESSAGE }));
  assert.deepEqual(errors, [{ code: AUDIT_WRITE_FAILED }]);
});

test('audit write failures are observable and sanitized', async (t) => {
  const directory = await tempDir(t);
  const blocker = join(directory, 'blocked');
  await writeFile(blocker, 'not a directory');
  const errors = [];
  const writer = createJsonlAuditWriter({
    directory: blocker,
    now: fixedNow,
    onError: (error) => errors.push(error),
  });

  await assert.rejects(
    writer.write(event(), { messageText: MESSAGE }),
    (error) => error.code === AUDIT_WRITE_FAILED
      && error.message === 'Audit write failed.'
      && error.cause === undefined
      && !error.message.includes(SECRET)
      && !error.message.includes(blocker),
  );
  assert.deepEqual(errors, [{ code: AUDIT_WRITE_FAILED }]);
});

test('exports the cleanup failure code for callers', () => {
  assert.equal(AUDIT_CLEANUP_FAILED, 'AUDIT_CLEANUP_FAILED');
});
