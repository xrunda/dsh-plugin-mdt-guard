import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateConfig } from '../config.js';

const refusalText =
  '本助手仅提供 MDT 多学科会诊相关支持，暂无法处理该请求。如需其他帮助，请联系信息科。';

function assertConfigError(input, code, field) {
  assert.throws(
    () => validateConfig(input),
    (error) => {
      assert.equal(error.name, 'ConfigError');
      assert.equal(error.code, code);
      if (field) {
        assert.ok(error.message.includes(field), `error message must identify ${field}`);
      }
      return true;
    },
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

test('disabled configuration normalizes to the PRD defaults', () => {
  assert.deepEqual(validateConfig({ enabled: false }), {
    enabled: false,
    classifier: {
      timeoutMs: 1500,
      maxTokens: 200,
    },
    contextTurns: 3,
    failOpen: true,
    hardDeny: [],
    fastAllow: [],
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
  assert.deepEqual(input.tools.allow, ['lookup', 'consult']);
  assert.deepEqual(input, original, 'validation must not mutate its input');
});

test('non-empty tools.allow replaces defaults without mutating its input array', () => {
  const allow = ['tool-one', 'tool-two'];
  const input = {
    enabled: false,
    tools: { allow },
  };
  const originalAllow = [...allow];

  assert.deepEqual(validateConfig(input).tools.allow, ['tool-one', 'tool-two']);
  assert.deepEqual(allow, originalAllow);
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
    assert.throws(
      () => validateConfig(input),
      (error) => {
        assert.equal(error.name, 'ConfigError');
        assert.equal(error.code, 'CONFIG_FIELD_REQUIRED');
        assert.ok(error.message.includes(missingField));
        assert.ok(!error.message.includes(JSON.stringify(input)));
        assert.ok(!error.message.includes('sentinel-api-key'));
        return true;
      },
    );
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
    assertConfigError(input, 'CONFIG_FIELD_INVALID', field);
  }
});

test('rejects unknown top-level and nested keys', () => {
  for (const [input, field] of [
    [{ enabled: false, unexpected: true }, 'unexpected'],
    [{ enabled: false, classifier: { unexpected: true } }, 'classifier.unexpected'],
    [{ enabled: false, audit: { unexpected: true } }, 'audit.unexpected'],
    [{ enabled: false, tools: { unexpected: true } }, 'tools.unexpected'],
  ]) {
    assertConfigError(input, 'CONFIG_UNKNOWN_FIELD', field);
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
      );
    }
    assertConfigError(
      withField(path, minimum + 0.5),
      'CONFIG_FIELD_INVALID',
      path.join('.'),
    );
  }
});
