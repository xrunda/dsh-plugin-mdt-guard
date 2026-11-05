import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateConfig } from '../config.js';

const refusalText =
  '本助手仅提供 MDT 多学科会诊相关支持，暂无法处理该请求。如需其他帮助，请联系信息科。';

function assertConfigError(input, code, field, options = {}) {
  assert.equal(typeof field, 'string', 'field must be a string');
  assert.ok(field, 'field must be a non-empty string');

  assert.throws(
    () => validateConfig(input),
    (error) => {
      assert.equal(error.name, 'ConfigError');
      assert.equal(error.code, code);
      assert.ok(error.message.includes(field), `error message must identify ${field}`);
      for (const forbidden of options.forbidden ?? []) {
        assert.ok(
          !error.message.includes(forbidden),
          `error message must not include ${forbidden}`,
        );
      }
      return true;
    },
    options.label ?? field,
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

  assert.deepEqual(second.hardDeny, []);
  assert.deepEqual(second.fastAllow, []);
  assert.deepEqual(second.tools.allow, []);
  assert.equal(second.audit.retentionDays, 30);
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
