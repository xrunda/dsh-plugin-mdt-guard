/**
 * Configuration loading, normalization, and validation for the MDT guard
 * bundle.
 *
 * `validateConfig` is pure: it applies the PRD defaults to a supplied object
 * and returns a fresh normalized object graph. `loadConfig` is the only
 * file-I/O entry point; it reads the server-side JSON file and delegates all
 * normalization to `validateConfig`.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  FAST_ALLOW_DEFAULT_SOURCES,
  HARD_DENY_DEFAULT_SOURCES,
  RULE_REGEX_FLAGS,
  isBuiltInRuleSource,
  isNormalizationStableSource,
} from './rule-defaults.js';

const REFUSAL_TEXT =
  '本助手仅提供 MDT 多学科会诊相关支持，暂无法处理该请求。如需其他帮助，请联系信息科。';

const DEFAULT_ENABLED = true;
const DEFAULT_CONTEXT_TURNS = 3;
const DEFAULT_FAIL_OPEN = true;
const DEFAULT_CLASSIFIER_TIMEOUT_MS = 1500;
const DEFAULT_CLASSIFIER_MAX_TOKENS = 200;
const DEFAULT_AUDIT_ENABLED = true;
const DEFAULT_AUDIT_STORE_TEXT = false;
const DEFAULT_AUDIT_RETENTION_DAYS = 30;

const TOP_LEVEL_KEYS = new Set([
  'enabled',
  'classifier',
  'contextTurns',
  'failOpen',
  'hardDeny',
  'fastAllow',
  'refusalText',
  'audit',
  'tools',
]);

const CLASSIFIER_KEYS = new Set([
  'baseUrl',
  'model',
  'apiKey',
  'caCertFile',
  'timeoutMs',
  'maxTokens',
]);

const AUDIT_KEYS = new Set(['enabled', 'storeText', 'retentionDays']);
const TOOLS_KEYS = new Set(['allow', 'deny']);

const NESTED_KEYS = {
  classifier: CLASSIFIER_KEYS,
  audit: AUDIT_KEYS,
  tools: TOOLS_KEYS,
};

const NESTED_SECTIONS = ['classifier', 'audit', 'tools'];

const INTEGER_BOUNDS = {
  'classifier.timeoutMs': [100, 60000],
  'classifier.maxTokens': [1, 4096],
  contextTurns: [0, 20],
  'audit.retentionDays': [1, 3650],
};

const CONFIG_FIELD_REQUIRED = 'CONFIG_FIELD_REQUIRED';
export const CONFIG_FIELD_INVALID = 'CONFIG_FIELD_INVALID';
const CONFIG_UNKNOWN_FIELD = 'CONFIG_UNKNOWN_FIELD';
const CONFIG_JSON_INVALID = 'CONFIG_JSON_INVALID';
const CONFIG_READ_FAILED = 'CONFIG_READ_FAILED';
export const CONFIG_RULE_INVALID = 'CONFIG_RULE_INVALID';
export const CONFIG_RULE_UNSTABLE = 'CONFIG_RULE_UNSTABLE';

/**
 * Sanitized configuration error. Messages are built only from fixed templates
 * and a dotted field path. No supplied value, raw parser detail, or filesystem
 * exception is ever attached, and `cause` is intentionally left undefined.
 */
export class ConfigError extends Error {
  constructor(code, field, message) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
    if (field !== undefined) {
      this.field = field;
    }
  }
}

const ERROR_TEMPLATES = {
  [CONFIG_FIELD_REQUIRED]: 'Missing required configuration field',
  [CONFIG_FIELD_INVALID]: 'Invalid configuration field',
  [CONFIG_UNKNOWN_FIELD]: 'Unknown configuration field',
  [CONFIG_RULE_INVALID]: 'Invalid regular expression in configuration field',
  [CONFIG_RULE_UNSTABLE]:
    'Rule regular expression is incompatible with message normalization',
};

/**
 * Build a sanitized configuration error from a fixed template and a field
 * path.
 *
 * The supplied value, regular-expression source, parser detail and any
 * underlying cause are never attached.
 *
 * @param {string} code
 * @param {string} field
 * @returns {ConfigError}
 */
export function createConfigError(code, field) {
  const template = ERROR_TEMPLATES[code] ?? ERROR_TEMPLATES[CONFIG_FIELD_INVALID];
  return new ConfigError(code, field, `${template} "${field}"`);
}

function fail(code, field) {
  throw createConfigError(code, field);
}

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireBoolean(value, field) {
  if (typeof value !== 'boolean') {
    fail(CONFIG_FIELD_INVALID, field);
  }
}

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(CONFIG_FIELD_INVALID, field);
  }
}

function requireStringArray(value, field) {
  if (!Array.isArray(value)) {
    fail(CONFIG_FIELD_INVALID, field);
  }
  // The array iterator does not skip holes, so sparse arrays are rejected
  // instead of silently normalizing to `undefined` values.
  for (const item of value) {
    if (typeof item !== 'string') {
      fail(CONFIG_FIELD_INVALID, field);
    }
  }
}

/**
 * Validate a regular-expression source array. Shape errors keep the existing
 * `CONFIG_FIELD_INVALID` contract. Empty or whitespace-only sources are
 * rejected as `CONFIG_FIELD_INVALID` before compilation using a full-string
 * predicate equivalent to /^[\s\u0085]*$/; `String#trim()` and `\s` alone
 * miss U+0085 (NEL). An empty `fastAllow` source matches every message and
 * fails open. An empty `hardDeny` source matches every message and denies
 * everything, which is a fail-closed availability loss rather than
 * fail-open. Whitespace-only sources are meaningless and can match most
 * normalized multi-word messages. A custom source that message normalization
 * would erase or fold is rejected as `CONFIG_RULE_UNSTABLE` at the indexed
 * field: literal Cf format characters, variation selectors (U+FE00-U+FE0F),
 * other inert literal whitespace, and regex escapes targeting such characters
 * cannot behave as written. The stability check is conservative and does not
 * fully analyse arbitrary regex semantics; a single internal literal space
 * remains permitted. Exact built-in sources are exempt because some
 * legitimately contain full-width punctuation. A non-empty source that does
 * not compile raises `CONFIG_RULE_INVALID` for the indexed field only; no
 * source text is ever attached to the message.
 */
function requireRegexArray(value, field) {
  requireStringArray(value, field);
  for (const [index, source] of value.entries()) {
    const indexedField = `${field}[${index}]`;
    if (/^[\s\u0085]*$/.test(source)) {
      fail(CONFIG_FIELD_INVALID, indexedField);
    }
    if (!isBuiltInRuleSource(source) && !isNormalizationStableSource(source)) {
      fail(CONFIG_RULE_UNSTABLE, indexedField);
    }
    try {
      RegExp(source, RULE_REGEX_FLAGS);
    } catch {
      fail(CONFIG_RULE_INVALID, indexedField);
    }
  }
}

function requireIntegerInRange(value, field) {
  const bounds = INTEGER_BOUNDS[field];
  if (bounds === undefined) {
    fail(CONFIG_FIELD_INVALID, field);
  }
  const [minimum, maximum] = bounds;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(CONFIG_FIELD_INVALID, field);
  }
}

function requireHttpUrl(value, field) {
  requireNonEmptyString(value, field);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(CONFIG_FIELD_INVALID, field);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fail(CONFIG_FIELD_INVALID, field);
  }
}

function rejectUnknownKeys(object, allowedKeys, prefix) {
  for (const key of Object.keys(object)) {
    if (!allowedKeys.has(key)) {
      fail(CONFIG_UNKNOWN_FIELD, prefix === undefined ? key : `${prefix}.${key}`);
    }
  }
}

/**
 * Validate and normalize a configuration object.
 *
 * @param {object} input
 * @returns {object} a fresh normalized configuration
 * @throws {ConfigError}
 */
export function validateConfig(input) {
  if (!isPlainObject(input)) {
    fail(CONFIG_FIELD_INVALID, 'config');
  }

  rejectUnknownKeys(input, TOP_LEVEL_KEYS);

  for (const key of NESTED_SECTIONS) {
    const value = input[key];
    if (value !== undefined && !isPlainObject(value)) {
      fail(CONFIG_FIELD_INVALID, key);
    }
  }

  for (const key of NESTED_SECTIONS) {
    const value = input[key];
    if (value !== undefined) {
      rejectUnknownKeys(value, NESTED_KEYS[key], key);
    }
  }

  let enabled = DEFAULT_ENABLED;
  if (input.enabled !== undefined) {
    requireBoolean(input.enabled, 'enabled');
    enabled = input.enabled;
  }

  let contextTurns = DEFAULT_CONTEXT_TURNS;
  if (input.contextTurns !== undefined) {
    requireIntegerInRange(input.contextTurns, 'contextTurns');
    contextTurns = input.contextTurns;
  }

  let failOpen = DEFAULT_FAIL_OPEN;
  if (input.failOpen !== undefined) {
    requireBoolean(input.failOpen, 'failOpen');
    failOpen = input.failOpen;
  }

  let refusalText = REFUSAL_TEXT;
  if (input.refusalText !== undefined) {
    requireNonEmptyString(input.refusalText, 'refusalText');
    refusalText = input.refusalText;
  }

  // The built-in rule lists are the fail-safe default. An empty supplied
  // array keeps them so hard-deny cannot be silently disabled; a non-empty
  // array replaces the whole list. Each result is a fresh array.
  let hardDeny = [...HARD_DENY_DEFAULT_SOURCES];
  if (input.hardDeny !== undefined) {
    requireRegexArray(input.hardDeny, 'hardDeny');
    if (input.hardDeny.length > 0) {
      hardDeny = [...input.hardDeny];
    }
  }

  let fastAllow = [...FAST_ALLOW_DEFAULT_SOURCES];
  if (input.fastAllow !== undefined) {
    requireRegexArray(input.fastAllow, 'fastAllow');
    if (input.fastAllow.length > 0) {
      fastAllow = [...input.fastAllow];
    }
  }

  const classifier = {
    timeoutMs: DEFAULT_CLASSIFIER_TIMEOUT_MS,
    maxTokens: DEFAULT_CLASSIFIER_MAX_TOKENS,
  };
  const suppliedClassifier = input.classifier;
  if (suppliedClassifier !== undefined) {
    if (suppliedClassifier.baseUrl !== undefined) {
      requireHttpUrl(suppliedClassifier.baseUrl, 'classifier.baseUrl');
      classifier.baseUrl = suppliedClassifier.baseUrl;
    }
    if (suppliedClassifier.model !== undefined) {
      requireNonEmptyString(suppliedClassifier.model, 'classifier.model');
      classifier.model = suppliedClassifier.model;
    }
    if (suppliedClassifier.apiKey !== undefined) {
      requireNonEmptyString(suppliedClassifier.apiKey, 'classifier.apiKey');
      classifier.apiKey = suppliedClassifier.apiKey;
    }
    if (suppliedClassifier.caCertFile !== undefined) {
      requireNonEmptyString(suppliedClassifier.caCertFile, 'classifier.caCertFile');
      classifier.caCertFile = suppliedClassifier.caCertFile;
    }
    if (suppliedClassifier.timeoutMs !== undefined) {
      requireIntegerInRange(suppliedClassifier.timeoutMs, 'classifier.timeoutMs');
      classifier.timeoutMs = suppliedClassifier.timeoutMs;
    }
    if (suppliedClassifier.maxTokens !== undefined) {
      requireIntegerInRange(suppliedClassifier.maxTokens, 'classifier.maxTokens');
      classifier.maxTokens = suppliedClassifier.maxTokens;
    }
  }

  const audit = {
    enabled: DEFAULT_AUDIT_ENABLED,
    storeText: DEFAULT_AUDIT_STORE_TEXT,
    retentionDays: DEFAULT_AUDIT_RETENTION_DAYS,
  };
  const suppliedAudit = input.audit;
  if (suppliedAudit !== undefined) {
    if (suppliedAudit.enabled !== undefined) {
      requireBoolean(suppliedAudit.enabled, 'audit.enabled');
      audit.enabled = suppliedAudit.enabled;
    }
    if (suppliedAudit.storeText !== undefined) {
      requireBoolean(suppliedAudit.storeText, 'audit.storeText');
      audit.storeText = suppliedAudit.storeText;
    }
    if (suppliedAudit.retentionDays !== undefined) {
      requireIntegerInRange(suppliedAudit.retentionDays, 'audit.retentionDays');
      audit.retentionDays = suppliedAudit.retentionDays;
    }
  }

  const tools = {
    allow: [],
    deny: [],
  };
  const suppliedTools = input.tools;
  if (suppliedTools !== undefined) {
    if (suppliedTools.allow !== undefined) {
      requireStringArray(suppliedTools.allow, 'tools.allow');
      tools.allow = [...suppliedTools.allow];
    }
    if (suppliedTools.deny !== undefined) {
      requireStringArray(suppliedTools.deny, 'tools.deny');
      tools.deny = [...suppliedTools.deny];
    }
  }

  if (enabled === true) {
    if (classifier.baseUrl === undefined) {
      fail(CONFIG_FIELD_REQUIRED, 'classifier.baseUrl');
    }
    if (classifier.model === undefined) {
      fail(CONFIG_FIELD_REQUIRED, 'classifier.model');
    }
  }

  return {
    enabled,
    classifier,
    contextTurns,
    failOpen,
    hardDeny,
    fastAllow,
    refusalText,
    audit,
    tools,
  };
}

/**
 * Load and validate the server-side MDT guard configuration file.
 *
 * The default path is resolved at call time so tests can isolate `HOME`. A
 * missing file starts from PRD defaults and therefore still raises the
 * enabled-default required-field error; the caller must leave the guard
 * inactive. Malformed JSON and filesystem failures become sanitized
 * `ConfigError`s that never retain raw parser detail, filesystem text, or
 * supplied configuration contents. This function never logs and never creates
 * directories or files.
 *
 * @param {{ filePath?: string }} [options]
 * @returns {Promise<object>} a fresh normalized configuration
 * @throws {ConfigError}
 */
export async function loadConfig({ filePath } = {}) {
  const resolvedPath =
    filePath === undefined ? join(homedir(), '.dsh', 'mdt', 'guard.json') : filePath;

  let rawText;
  try {
    rawText = await readFile(resolvedPath, 'utf8');
  } catch (error) {
    if (typeof error === 'object' && error !== null && error.code === 'ENOENT') {
      return validateConfig({});
    }
    throw new ConfigError(CONFIG_READ_FAILED, 'config', 'Unable to read configuration file');
  }

  // Tolerate a single UTF-8 BOM before the JSON document. Nothing else is
  // rewritten: whitespace and all remaining text reach JSON.parse unchanged.
  const text = rawText.startsWith('\uFEFF') ? rawText.slice(1) : rawText;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConfigError(CONFIG_JSON_INVALID, 'config', 'Configuration file is not valid JSON');
  }

  return validateConfig(parsed);
}
