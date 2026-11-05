import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ConfigError, loadConfig, validateConfig } from '../config.js';
import {
  FAST_ALLOW_DEFAULT_SOURCES,
  FAST_ALLOW_RULES,
  HARD_DENY_DEFAULT_SOURCES,
  HARD_DENY_RULES,
  RULE_REGEX_FLAGS,
} from '../rule-defaults.js';

const refusalText =
  '本助手仅提供 MDT 多学科会诊相关支持，暂无法处理该请求。如需其他帮助，请联系信息科。';

function assertConfigError(input, code, field, options = {}) {
  assert.equal(typeof field, 'string', 'field must be a string');
  assert.ok(field, 'field must be a non-empty string');

  const label = options.label ?? field;

  assert.throws(
    () => validateConfig(input),
    (error) => {
      assert.equal(error.name, 'ConfigError', `${label}: expected ConfigError`);
      assert.equal(error.code, code, `${label}: unexpected error code`);
      assert.equal(error.field, field, `${label}: unexpected error field`);
      assert.ok(error.message.includes(field), `${label}: error message must identify ${field}`);
      assert.equal(error.cause, undefined, `${label}: ConfigError must not attach a cause`);
      for (const forbidden of options.forbidden ?? []) {
        assert.ok(
          !error.message.includes(forbidden),
          `${label}: error message must not include forbidden text`,
        );
        assert.ok(
          !String(error).includes(forbidden),
          `${label}: stringified error must not include forbidden text`,
        );
      }
      return true;
    },
    label,
  );
}

const readPath = (object, path) => path.reduce((value, key) => value[key], object);

function withField(path, value) {
  const input = { enabled: false };
  let target = input;
  for (const key of path.slice(0, -1)) {
    target[key] = {};
    target = target[key];
  }
  target[path.at(-1)] = value;
  return input;
}

let sentinelSequence = 0;

function uniqueSentinel(label) {
  sentinelSequence += 1;
  return `sentinel-${label}-${Date.now()}-${sentinelSequence}`;
}

async function makeTempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mdt-guard-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function withIsolatedHome(home, fn) {
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn();
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
}

async function assertLoadError(promise, code, secret) {
  let captured;
  await assert.rejects(promise, (error) => {
    captured = error;
    assert.ok(error instanceof ConfigError, 'expected a ConfigError instance');
    assert.equal(error.name, 'ConfigError', 'expected ConfigError name');
    assert.equal(error.code, code, 'unexpected error code');
    assert.equal(error.cause, undefined, 'ConfigError must not attach a cause');
    if (secret !== undefined) {
      assert.ok(!error.message.includes(secret), 'error message must not include the secret');
      assert.ok(!String(error).includes(secret), 'stringified error must not include the secret');
    }
    return true;
  });
  return captured;
}

async function captureConsole(fn) {
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const originals = new Map();
  const calls = [];
  for (const method of methods) {
    originals.set(method, console[method]);
    console[method] = (...args) => calls.push([method, ...args]);
  }
  try {
    await fn();
  } finally {
    for (const method of methods) {
      console[method] = originals.get(method);
    }
  }
  return calls;
}

test('disabled configuration normalizes to the PRD defaults', () => {
  assert.deepEqual(validateConfig({ enabled: false }), {
    enabled: false,
    classifier: {
      timeoutMs: 1500,
      maxTokens: 200,
    },
    contextTurns: 3,
    failOpen: true,
    hardDeny: [...HARD_DENY_DEFAULT_SOURCES],
    fastAllow: [...FAST_ALLOW_DEFAULT_SOURCES],
    refusalText,
    audit: {
      enabled: true,
      storeText: false,
      retentionDays: 30,
    },
    tools: {
      allow: [],
      deny: [],
    },
  });
});

test('supplied refusalText survives normalization unchanged', () => {
  const customRefusalText = 'Custom refusal text.';
  assert.equal(
    validateConfig({ enabled: false, refusalText: customRefusalText }).refusalText,
    customRefusalText,
  );
});

test('enabled configuration merges nested defaults and replaces supplied arrays', () => {
  const input = {
    enabled: true,
    classifier: {
      baseUrl: 'https://classifier.example.test/v1',
      model: 'mdt-classifier',
      timeoutMs: 2500,
    },
    hardDeny: ['custom-deny'],
    fastAllow: ['custom-allow'],
    audit: {
      storeText: true,
    },
    tools: {
      allow: ['lookup', 'consult'],
      deny: ['unsafe-tool'],
    },
  };
  const original = JSON.parse(JSON.stringify(input));

  assert.deepEqual(validateConfig(input), {
    enabled: true,
    classifier: {
      baseUrl: 'https://classifier.example.test/v1',
      model: 'mdt-classifier',
      timeoutMs: 2500,
      maxTokens: 200,
    },
    contextTurns: 3,
    failOpen: true,
    hardDeny: ['custom-deny'],
    fastAllow: ['custom-allow'],
    refusalText,
    audit: {
      enabled: true,
      storeText: true,
      retentionDays: 30,
    },
    tools: {
      allow: ['lookup', 'consult'],
      deny: ['unsafe-tool'],
    },
  });
  assert.deepEqual(input, original, 'validation must not mutate its input');
});

test('non-empty tools.allow replaces defaults without mutating its input array', () => {
  const allow = ['tool-two', 'tool-one'];
  const input = {
    enabled: false,
    tools: { allow },
  };
  const originalAllow = [...allow];

  const result = validateConfig(input);
  assert.notEqual(result.tools.allow, allow);
  assert.deepEqual(result.tools.allow, ['tool-two', 'tool-one']);
  result.tools.allow.reverse();
  assert.deepEqual(allow, originalAllow);
});

test('omitted enabled defaults to true and still requires classifier connection fields', () => {
  assertConfigError({}, 'CONFIG_FIELD_REQUIRED', 'classifier.baseUrl', {
    label: 'empty input',
  });
});

test('each call returns fresh normalized objects rather than shared defaults', () => {
  const first = validateConfig({ enabled: false });
  const second = validateConfig({ enabled: false });

  assert.notEqual(first, second);
  assert.notEqual(first.classifier, second.classifier);
  assert.notEqual(first.audit, second.audit);
  assert.notEqual(first.tools, second.tools);
  assert.notEqual(first.hardDeny, second.hardDeny);
  assert.notEqual(first.fastAllow, second.fastAllow);
  assert.notEqual(first.tools.allow, second.tools.allow);
  assert.notEqual(first.tools.deny, second.tools.deny);

  first.hardDeny.push('mutated-deny');
  first.fastAllow.push('mutated-allow');
  first.tools.allow.push('mutated-tool');
  first.audit.retentionDays = 999;

  assert.deepEqual(second.hardDeny, [...HARD_DENY_DEFAULT_SOURCES]);
  assert.deepEqual(second.fastAllow, [...FAST_ALLOW_DEFAULT_SOURCES]);
  assert.deepEqual(second.tools.allow, []);
  assert.equal(second.audit.retentionDays, 30);
});

test('omitted and empty rule arrays use the built-in sources', () => {
  const omitted = validateConfig({ enabled: false });
  const empty = validateConfig({ enabled: false, hardDeny: [], fastAllow: [] });

  assert.deepEqual(omitted.hardDeny, [...HARD_DENY_DEFAULT_SOURCES]);
  assert.deepEqual(omitted.fastAllow, [...FAST_ALLOW_DEFAULT_SOURCES]);
  assert.deepEqual(empty.hardDeny, omitted.hardDeny);
  assert.deepEqual(empty.fastAllow, omitted.fastAllow);
  assert.notEqual(empty.hardDeny, omitted.hardDeny);
  assert.notEqual(empty.fastAllow, omitted.fastAllow);
});

test('non-empty rule arrays replace the built-in sources with fresh arrays', () => {
  const hardDeny = ['^custom-deny$'];
  const fastAllow = ['^custom-allow$'];
  const result = validateConfig({ enabled: false, hardDeny, fastAllow });

  assert.deepEqual(result.hardDeny, ['^custom-deny$']);
  assert.deepEqual(result.fastAllow, ['^custom-allow$']);
  assert.notEqual(result.hardDeny, hardDeny, 'hardDeny must be a fresh array');
  assert.notEqual(result.fastAllow, fastAllow, 'fastAllow must be a fresh array');
  assert.notEqual(
    result.hardDeny,
    HARD_DENY_DEFAULT_SOURCES,
    'hardDeny must not reuse the default source array',
  );
  assert.notEqual(
    result.fastAllow,
    FAST_ALLOW_DEFAULT_SOURCES,
    'fastAllow must not reuse the default source array',
  );
});

test('built-in rule catalogs are complete, ordered, and compile with RULE_REGEX_FLAGS', () => {
  const expectedHardDeny = [
    ['hard-deny.prompt-injection', 'H'],
    ['hard-deny.role-switch', 'H'],
    ['hard-deny.system-prompt-exfiltration', 'H'],
    ['hard-deny.any-question-permission', 'H'],
    ['hard-deny.jailbreak', 'H'],
    ['hard-deny.sensitive-path', 'G'],
    ['hard-deny.read-sensitive', 'G'],
    ['hard-deny.read-sensitive-reverse', 'G'],
    ['hard-deny.command-exec', 'G'],
    ['hard-deny.software-install', 'G'],
    ['hard-deny.config-modify', 'G'],
    ['hard-deny.service-ops', 'G'],
  ];
  // The five `fast-allow.software-help` rows intentionally share one ID: each
  // row covers a different phrasing family while keeping a single audit
  // identity.
  const expectedFastAllow = [
    ['fast-allow.greeting', 'D'],
    ['fast-allow.continuation', 'D'],
    ['fast-allow.software-help', 'C'],
    ['fast-allow.software-help', 'C'],
    ['fast-allow.software-help', 'C'],
    ['fast-allow.software-help', 'C'],
    ['fast-allow.software-help', 'C'],
  ];

  for (const [label, rules, expected] of [
    ['HARD_DENY_RULES', HARD_DENY_RULES, expectedHardDeny],
    ['FAST_ALLOW_RULES', FAST_ALLOW_RULES, expectedFastAllow],
  ]) {
    assert.ok(Object.isFrozen(rules), `${label} must be frozen`);
    // The exact deepEqual below already proves the array is non-empty.
    assert.deepEqual(
      rules.map((rule) => [rule.id, rule.category]),
      expected,
      `${label} ids and categories must match the documented order`,
    );
    for (const rule of rules) {
      assert.ok(Object.isFrozen(rule), `${rule.id}: rule object must be frozen`);
      assert.equal(typeof rule.source, 'string', `${rule.id}: source must be a string`);
      assert.doesNotThrow(
        () => RegExp(rule.source, RULE_REGEX_FLAGS),
        `${rule.id}: source must compile with RULE_REGEX_FLAGS`,
      );
    }
  }

  assert.ok(
    Object.isFrozen(HARD_DENY_DEFAULT_SOURCES),
    'HARD_DENY_DEFAULT_SOURCES must be frozen',
  );
  assert.ok(
    Object.isFrozen(FAST_ALLOW_DEFAULT_SOURCES),
    'FAST_ALLOW_DEFAULT_SOURCES must be frozen',
  );
});

test('empty and whitespace-only rule sources are rejected before compilation', () => {
  // Both rule fields reject every empty/whitespace-only source. An empty
  // string is never used in `forbidden`: String#includes('') is always true.
  for (const fieldName of ['hardDeny', 'fastAllow']) {
    for (const source of ['', '   ', '　', '\t\n']) {
      const field = `${fieldName}[0]`;
      assertConfigError(
        { enabled: false, [fieldName]: [source] },
        'CONFIG_FIELD_INVALID',
        field,
        {
          label: `${field}: ${JSON.stringify(source)}`,
          forbidden: source === '' ? [] : [source],
        },
      );
    }
  }
});

test('meaningful surrounding whitespace in rule sources is preserved', () => {
  const result = validateConfig({
    enabled: false,
    hardDeny: ['^ foo$'],
    fastAllow: [' foo '],
  });

  assert.deepEqual(result.hardDeny, ['^ foo$']);
  assert.deepEqual(result.fastAllow, [' foo ']);
});

test('sparse rule arrays are rejected as CONFIG_FIELD_INVALID', () => {
  assertConfigError(
    withField(['hardDeny'], [, 'x']),
    'CONFIG_FIELD_INVALID',
    'hardDeny',
    { label: 'hardDeny sparse' },
  );
  assertConfigError(
    withField(['fastAllow'], [, 'x']),
    'CONFIG_FIELD_INVALID',
    'fastAllow',
    { label: 'fastAllow sparse' },
  );
});

test('invalid rule regular expressions raise a sanitized CONFIG_RULE_INVALID error', () => {
  for (const [field, input, forbidden] of [
    ['hardDeny[0]', { hardDeny: ['(unclosed'] }, '(unclosed'],
    ['fastAllow[1]', { fastAllow: ['^ok$', '[z-a]'] }, '[z-a]'],
  ]) {
    assertConfigError(
      { enabled: false, ...input },
      'CONFIG_RULE_INVALID',
      field,
      { label: field, forbidden: [forbidden] },
    );
  }
});

test('enabled configuration requires classifier.baseUrl and classifier.model', () => {
  for (const [missingField, input] of [
    [
      'classifier.baseUrl',
      {
        enabled: true,
        classifier: { model: 'mdt-classifier', apiKey: 'sentinel-api-key' },
      },
    ],
    [
      'classifier.model',
      {
        enabled: true,
        classifier: {
          baseUrl: 'https://classifier.example.test',
          apiKey: 'sentinel-api-key',
        },
      },
    ],
  ]) {
    assertConfigError(input, 'CONFIG_FIELD_REQUIRED', missingField, {
      label: missingField,
      forbidden: [JSON.stringify(input), 'sentinel-api-key'],
    });
  }
});

test('configuration errors expose stable codes for required, invalid, and unknown fields', () => {
  assertConfigError({ enabled: true }, 'CONFIG_FIELD_REQUIRED', 'classifier.baseUrl');
  assertConfigError({ enabled: false, contextTurns: 21 }, 'CONFIG_FIELD_INVALID', 'contextTurns');
  assertConfigError({ enabled: false, typo: true }, 'CONFIG_UNKNOWN_FIELD', 'typo');
});

test('rejects incorrect field types and empty non-empty text fields', () => {
  const invalidCases = [
    [withField(['enabled'], 'false'), 'enabled'],
    [withField(['failOpen'], 1), 'failOpen'],
    [withField(['classifier', 'baseUrl'], 17), 'classifier.baseUrl'],
    [withField(['classifier', 'model'], ''), 'classifier.model'],
    [withField(['classifier', 'apiKey'], ''), 'classifier.apiKey'],
    [withField(['classifier', 'caCertFile'], ''), 'classifier.caCertFile'],
    [withField(['classifier', 'timeoutMs'], '1500'), 'classifier.timeoutMs'],
    [withField(['classifier', 'maxTokens'], 200.5), 'classifier.maxTokens'],
    [withField(['contextTurns'], false), 'contextTurns'],
    [withField(['hardDeny'], {}), 'hardDeny'],
    [withField(['fastAllow'], ['valid-rule', 1]), 'fastAllow'],
    [withField(['refusalText'], ''), 'refusalText'],
    [withField(['audit', 'enabled'], 'true'), 'audit.enabled'],
    [withField(['audit', 'storeText'], 0), 'audit.storeText'],
    [withField(['audit', 'retentionDays'], '30'), 'audit.retentionDays'],
    [withField(['tools', 'allow'], 'tool-name'), 'tools.allow'],
    [withField(['tools', 'deny'], ['valid-tool', null]), 'tools.deny'],
  ];

  for (const [input, field] of invalidCases) {
    assertConfigError(input, 'CONFIG_FIELD_INVALID', field, { label: field });
  }
});

test('rejects unknown top-level and nested keys', () => {
  for (const [input, field] of [
    [{ enabled: false, unexpected: true }, 'unexpected'],
    [{ enabled: false, classifier: { unexpected: true } }, 'classifier.unexpected'],
    [{ enabled: false, audit: { unexpected: true } }, 'audit.unexpected'],
    [{ enabled: false, tools: { unexpected: true } }, 'tools.unexpected'],
  ]) {
    assertConfigError(input, 'CONFIG_UNKNOWN_FIELD', field, { label: field });
  }
});

test('classifier.baseUrl must be an absolute HTTP or HTTPS URL', () => {
  for (const baseUrl of [
    '',
    '/v1/classify',
    'classifier.example.test',
    'ftp://classifier.example.test/model',
    'not a url',
  ]) {
    assertConfigError(
      {
        enabled: true,
        classifier: { baseUrl, model: 'mdt-classifier' },
      },
      'CONFIG_FIELD_INVALID',
      'classifier.baseUrl',
      { label: `classifier.baseUrl=${JSON.stringify(baseUrl)}` },
    );
  }

  const baseUrl = 'http://classifier.example.test/model';
  assert.equal(
    validateConfig({
      enabled: true,
      classifier: { baseUrl, model: 'mdt-classifier' },
    }).classifier.baseUrl,
    baseUrl,
    'absolute http URLs must be accepted and preserved',
  );
});

test('accepts each numeric lower and upper bound and rejects values outside them', () => {
  const bounds = [
    [['classifier', 'timeoutMs'], 100, 60000],
    [['classifier', 'maxTokens'], 1, 4096],
    [['contextTurns'], 0, 20],
    [['audit', 'retentionDays'], 1, 3650],
  ];

  for (const [path, minimum, maximum] of bounds) {
    for (const value of [minimum, maximum]) {
      assert.equal(
        readPath(validateConfig(withField(path, value)), path),
        value,
        `${path.join('.')}=${value} must be preserved`,
      );
    }
    for (const value of [minimum - 1, maximum + 1]) {
      assertConfigError(
        withField(path, value),
        'CONFIG_FIELD_INVALID',
        path.join('.'),
        { label: `${path.join('.')}=${value}` },
      );
    }
    assertConfigError(
      withField(path, minimum + 0.5),
      'CONFIG_FIELD_INVALID',
      path.join('.'),
      { label: `${path.join('.')}=${minimum + 0.5}` },
    );
  }
});

test('loadConfig resolves the default config path from the isolated home', async (t) => {
  const home = await makeTempDir(t);
  const configDir = join(home, '.dsh', 'mdt');
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, 'guard.json'),
    JSON.stringify({ enabled: false, contextTurns: 7 }),
  );

  const config = await withIsolatedHome(home, () => loadConfig());

  assert.deepEqual(config, {
    enabled: false,
    classifier: {
      timeoutMs: 1500,
      maxTokens: 200,
    },
    contextTurns: 7,
    failOpen: true,
    hardDeny: [...HARD_DENY_DEFAULT_SOURCES],
    fastAllow: [...FAST_ALLOW_DEFAULT_SOURCES],
    refusalText,
    audit: {
      enabled: true,
      storeText: false,
      retentionDays: 30,
    },
    tools: {
      allow: [],
      deny: [],
    },
  });
});

test('loadConfig with an empty home applies enabled defaults and creates nothing', async (t) => {
  const home = await makeTempDir(t);

  const error = await withIsolatedHome(home, () =>
    assertLoadError(loadConfig(), 'CONFIG_FIELD_REQUIRED', undefined),
  );
  assert.ok(error.message.includes('classifier.baseUrl'), 'error must identify classifier.baseUrl');

  await assert.rejects(stat(join(home, '.dsh')), { code: 'ENOENT' });
  await assert.rejects(stat(join(home, '.dsh', 'mdt', 'guard.json')), { code: 'ENOENT' });
});

test('loadConfig treats a missing explicit path as defaults and creates nothing', async (t) => {
  const dir = await makeTempDir(t);
  const filePath = join(dir, 'missing.json');

  const error = await assertLoadError(loadConfig({ filePath }), 'CONFIG_FIELD_REQUIRED', undefined);
  assert.ok(error.message.includes('classifier.baseUrl'), 'error must identify classifier.baseUrl');
  await assert.rejects(stat(filePath), { code: 'ENOENT' });
});

test('loadConfig does not fall back to the default path for a null filePath', async (t) => {
  const home = await makeTempDir(t);
  const configDir = join(home, '.dsh', 'mdt');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'guard.json'), JSON.stringify({ enabled: false }));

  await withIsolatedHome(home, () =>
    assertLoadError(loadConfig({ filePath: null }), 'CONFIG_READ_FAILED'),
  );
});

test('loadConfig accepts a UTF-8 BOM before valid JSON', async (t) => {
  const dir = await makeTempDir(t);
  const filePath = join(dir, 'bom.json');
  await writeFile(filePath, `\uFEFF${JSON.stringify({ enabled: false })}`);

  const config = await loadConfig({ filePath });
  assert.equal(config.enabled, false);
  assert.equal('baseUrl' in config.classifier, false);
});

test('loadConfig returns a normalized enabled configuration from disk', async (t) => {
  const dir = await makeTempDir(t);
  const filePath = join(dir, 'guard.json');
  const supplied = {
    enabled: true,
    classifier: {
      baseUrl: 'https://classifier.example.test/v1',
      model: 'mdt-classifier',
      timeoutMs: 2500,
      maxTokens: 512,
    },
    contextTurns: 5,
    failOpen: false,
    hardDeny: ['custom-deny'],
    fastAllow: ['custom-allow'],
    audit: {
      enabled: false,
      storeText: true,
      retentionDays: 90,
    },
    tools: {
      allow: ['lookup', 'consult'],
      deny: ['unsafe-tool'],
    },
  };
  await writeFile(filePath, JSON.stringify(supplied));

  assert.deepEqual(await loadConfig({ filePath }), {
    enabled: true,
    classifier: {
      baseUrl: 'https://classifier.example.test/v1',
      model: 'mdt-classifier',
      timeoutMs: 2500,
      maxTokens: 512,
    },
    contextTurns: 5,
    failOpen: false,
    hardDeny: ['custom-deny'],
    fastAllow: ['custom-allow'],
    refusalText,
    audit: {
      enabled: false,
      storeText: true,
      retentionDays: 90,
    },
    tools: {
      allow: ['lookup', 'consult'],
      deny: ['unsafe-tool'],
    },
  });
});

test('loadConfig accepts a disabled config without classifier connection fields', async (t) => {
  const dir = await makeTempDir(t);
  const filePath = join(dir, 'guard.json');
  await writeFile(filePath, JSON.stringify({ enabled: false }));

  const config = await loadConfig({ filePath });

  assert.deepEqual(config, {
    enabled: false,
    classifier: {
      timeoutMs: 1500,
      maxTokens: 200,
    },
    contextTurns: 3,
    failOpen: true,
    hardDeny: [...HARD_DENY_DEFAULT_SOURCES],
    fastAllow: [...FAST_ALLOW_DEFAULT_SOURCES],
    refusalText,
    audit: {
      enabled: true,
      storeText: false,
      retentionDays: 30,
    },
    tools: {
      allow: [],
      deny: [],
    },
  });
  assert.equal('baseUrl' in config.classifier, false);
  assert.equal('model' in config.classifier, false);
});

test('loadConfig still validates supplied fields while disabled', async (t) => {
  const dir = await makeTempDir(t);

  const badUrl = uniqueSentinel('invalid-url');
  const invalidUrlPath = join(dir, 'invalid-url.json');
  await writeFile(
    invalidUrlPath,
    JSON.stringify({ enabled: false, classifier: { baseUrl: badUrl } }),
  );
  let urlError;
  const urlCalls = await captureConsole(async () => {
    urlError = await assertLoadError(
      loadConfig({ filePath: invalidUrlPath }),
      'CONFIG_FIELD_INVALID',
      badUrl,
    );
  });
  assert.deepEqual(urlCalls, [], 'the loader must not write to the console');
  assert.ok(urlError.message.includes('classifier.baseUrl'), 'error must identify classifier.baseUrl');

  const wrongType = uniqueSentinel('wrong-type');
  const wrongTypePath = join(dir, 'wrong-type.json');
  await writeFile(wrongTypePath, JSON.stringify({ enabled: false, contextTurns: wrongType }));
  let typeError;
  const typeCalls = await captureConsole(async () => {
    typeError = await assertLoadError(
      loadConfig({ filePath: wrongTypePath }),
      'CONFIG_FIELD_INVALID',
      wrongType,
    );
  });
  assert.deepEqual(typeCalls, [], 'the loader must not write to the console');
  assert.ok(typeError.message.includes('contextTurns'), 'error must identify contextTurns');
});

test('malformed JSON raises a sanitized CONFIG_JSON_INVALID error and never logs', async (t) => {
  const dir = await makeTempDir(t);
  const filePath = join(dir, 'malformed.json');
  const sentinel = uniqueSentinel('malformed');
  await writeFile(filePath, `{"enabled": false, "classifier": {"apiKey": "${sentinel}"},}`);

  let error;
  const calls = await captureConsole(async () => {
    error = await assertLoadError(loadConfig({ filePath }), 'CONFIG_JSON_INVALID', sentinel);
  });

  assert.deepEqual(calls, [], 'the loader must not write to the console');
  assert.ok(!error.message.includes('at position'), 'message must not include parser position detail');
  assert.ok(!error.message.includes('SyntaxError'), 'message must not include the parser error name');
});

test('unreadable paths raise CONFIG_READ_FAILED without raw system details', async (t) => {
  const dir = await makeTempDir(t);
  const directoryPath = join(dir, 'not-a-file');
  await mkdir(directoryPath);

  const error = await assertLoadError(loadConfig({ filePath: directoryPath }), 'CONFIG_READ_FAILED');

  assert.ok(!error.message.includes('EISDIR'), 'message must not expose the raw system error');
});

test('invalid field values never expose sentinel secrets', async (t) => {
  const dir = await makeTempDir(t);
  const filePath = join(dir, 'invalid-timeout.json');
  const sentinel = uniqueSentinel('field');
  await writeFile(
    filePath,
    JSON.stringify({ enabled: false, classifier: { apiKey: sentinel, timeoutMs: 5 } }),
  );

  let error;
  const calls = await captureConsole(async () => {
    error = await assertLoadError(loadConfig({ filePath }), 'CONFIG_FIELD_INVALID', sentinel);
  });
  assert.deepEqual(calls, [], 'the loader must not write to the console');
  assert.ok(
    error.message.includes('classifier.timeoutMs'),
    'error must identify classifier.timeoutMs',
  );
});

test('the documented example is valid, matches the documented defaults, and contains no credentials', async () => {
  const text = await readFile(new URL('../Docs/guard.example.json', import.meta.url), 'utf8');
  const example = JSON.parse(text);
  const normalized = validateConfig(example);

  assert.equal(normalized.enabled, true);
  assert.match(normalized.classifier.baseUrl, /^https:\/\/classifier\.example\.invalid\//);
  assert.equal(Object.hasOwn(example.classifier, 'apiKey'), false);
  assert.equal(Object.hasOwn(normalized.classifier, 'apiKey'), false);

  const defaults = validateConfig({ enabled: false });
  for (const [label, actual, expected] of [
    ['classifier.timeoutMs', normalized.classifier.timeoutMs, defaults.classifier.timeoutMs],
    ['classifier.maxTokens', normalized.classifier.maxTokens, defaults.classifier.maxTokens],
    ['contextTurns', normalized.contextTurns, defaults.contextTurns],
    ['failOpen', normalized.failOpen, defaults.failOpen],
    ['refusalText', normalized.refusalText, defaults.refusalText],
    ['audit.enabled', normalized.audit.enabled, defaults.audit.enabled],
    ['audit.storeText', normalized.audit.storeText, defaults.audit.storeText],
    ['audit.retentionDays', normalized.audit.retentionDays, defaults.audit.retentionDays],
    ['hardDeny', normalized.hardDeny, defaults.hardDeny],
    ['fastAllow', normalized.fastAllow, defaults.fastAllow],
    ['tools', normalized.tools, defaults.tools],
  ]) {
    assert.deepEqual(actual, expected, `example ${label} drifted from the config.js default`);
  }
});
