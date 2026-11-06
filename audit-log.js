import { createHash } from 'node:crypto';
import { appendFile, chmod, mkdir, readdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_RETENTION_DAYS = 30;
const AUDIT_FILE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

export const AUDIT_WRITE_FAILED = 'AUDIT_WRITE_FAILED';
export const AUDIT_CLEANUP_FAILED = 'AUDIT_CLEANUP_FAILED';

export class AuditWriteError extends Error {
  constructor() {
    super('Audit write failed.');
    this.name = 'AuditWriteError';
    this.code = AUDIT_WRITE_FAILED;
  }
}

function buildRecord(event, messageText, storeText, timestamp) {
  const text = typeof messageText === 'string' ? messageText : null;
  const record = {
    timestamp: typeof event.timestamp === 'string' ? event.timestamp : timestamp,
    sessionId: event.sessionId ?? null,
    turn: event.turn ?? null,
    decision: event.decision ?? null,
    category: event.category ?? null,
    source: event.source ?? null,
    reason: event.reason ?? null,
    ruleId: event.ruleId ?? null,
    confidence: event.confidence ?? null,
    degraded: event.degraded === true,
    errorCode: event.errorCode ?? null,
    sessionState: event.sessionState ?? null,
    durationMs: event.durationMs ?? null,
  };
  if (text === null) {
    record.messageHash = null;
    record.messageLength = 0;
  } else {
    record.messageHash = createHash('sha256').update(text, 'utf8').digest('hex');
    record.messageLength = text.length;
    if (storeText) {
      record.messageText = text;
    }
  }
  return record;
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function parseFileDate(name) {
  const match = AUDIT_FILE_PATTERN.exec(name);
  if (match === null) {
    return undefined;
  }
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/**
 * Create a private JSONL audit writer.
 *
 * Only known audit fields are serialized. The raw user message is never
 * written unless `storeText` is explicitly enabled; by default the record
 * contains a SHA-256 hash and the message length. Files are created as 0600
 * and old date files are removed on the first write of each day.
 */
export function createJsonlAuditWriter({
  directory = join(homedir(), '.dsh', 'mdt', 'guard-audit'),
  storeText = false,
  retentionDays = DEFAULT_RETENTION_DAYS,
  now = () => new Date(),
  onError = () => {},
} = {}) {
  if (typeof directory !== 'string' || directory.length === 0) {
    throw new TypeError('audit directory must be a non-empty string');
  }
  if (typeof storeText !== 'boolean') {
    throw new TypeError('audit storeText must be a boolean');
  }
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new TypeError('audit retentionDays must be a positive integer');
  }
  if (typeof onError !== 'function') {
    throw new TypeError('audit onError must be a function');
  }

  let lastCleanupDate;

  const report = (code) => {
    try {
      onError(Object.freeze({ code }));
    } catch {
      // The audit error hook is best-effort.
    }
  };

  async function cleanup() {
    let names;
    try {
      names = await readdir(directory);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        report(AUDIT_CLEANUP_FAILED);
      }
      return;
    }

    const current = now();
    const cutoff = Date.UTC(
      current.getUTCFullYear(),
      current.getUTCMonth(),
      current.getUTCDate() - retentionDays,
    );

    for (const name of names) {
      const fileDate = parseFileDate(name);
      if (fileDate === undefined || fileDate >= cutoff) {
        continue;
      }
      try {
        await unlink(join(directory, name));
      } catch {
        report(AUDIT_CLEANUP_FAILED);
      }
    }
  }

  async function write(event, context = {}) {
    const current = now();
    const key = dateKey(current);
    const record = buildRecord(
      event ?? {},
      context?.messageText,
      storeText,
      current.toISOString(),
    );

    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (lastCleanupDate !== key) {
        lastCleanupDate = key;
        await cleanup();
      }
      const file = join(directory, `${key}.jsonl`);
      await appendFile(file, `${JSON.stringify(record)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await chmod(file, 0o600);
    } catch {
      report(AUDIT_WRITE_FAILED);
      throw new AuditWriteError();
    }
  }

  return Object.freeze({ write, cleanup });
}
