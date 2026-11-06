import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateConfig } from '../config.js';

let loadCount = 0;

async function loadClientBundle() {
  let entry;
  const previous = globalThis.__ModuleLoader__;
  globalThis.__ModuleLoader__ = {
    load(candidate) {
      entry = candidate;
    },
  };
  try {
    await import(`../client.js?test=${(loadCount += 1)}`);
  } finally {
    if (previous === undefined) delete globalThis.__ModuleLoader__;
    else globalThis.__ModuleLoader__ = previous;
  }
  return entry;
}

function fakeRequire(id) {
  assert.equal(id, 'react/jsx-runtime');
  return {
    // React's jsx(type, config, maybeKey): children live in config, and the
    // third argument is the key. Mirroring that catches children passed in
    // the wrong position.
    jsx(type, config, maybeKey) {
      return { type, props: config, key: maybeKey };
    },
  };
}

function fakeClientContext() {
  const injections = [];
  const registrations = [];
  return {
    injections,
    registrations,
    ctx: {
      slots: {
        inject(name, callback) {
          injections.push({ name, callback });
          return () => {};
        },
        register(options, component) {
          // `conversation.chat.turnTail` is a list slot: DSH requires an id
          // for each registration.
          if (options?.name === 'conversation.chat.turnTail' && options.id === undefined) {
            throw new Error(`list slot "${options.name}" requires options.id`);
          }
          registrations.push({ options, component });
          return () => {};
        },
      },
    },
  };
}

test('the client bundle registers its factory with the module loader', async () => {
  const entry = await loadClientBundle();

  assert.equal(typeof entry, 'object');
  assert.equal(entry.id, '@local/dsh-mdt-guard');
  assert.equal(typeof entry.factory, 'function');

  const exports = entry.factory(fakeRequire);
  assert.deepEqual(exports.inject, ['slots']);
  assert.equal(typeof exports.apply, 'function');
  assert.equal(typeof exports.isBlockedTurn, 'function');
  assert.equal(typeof exports.REFUSAL_TEXT, 'string');
});

test('the bundle import is a no-op without a shell loader', async () => {
  for (const loader of [undefined, null]) {
    if (loader === undefined) delete globalThis.__ModuleLoader__;
    else globalThis.__ModuleLoader__ = loader;
    await assert.doesNotReject(import(`../client.js?no-loader=${(loadCount += 1)}`));
  }
  delete globalThis.__ModuleLoader__;
});

test('apply registers the refusal notice on conversation.chat.turnTail', async () => {
  const entry = await loadClientBundle();
  const exports = entry.factory(fakeRequire);
  const { ctx, injections, registrations } = fakeClientContext();

  exports.apply(ctx);

  assert.deepEqual(injections.map(({ name }) => name), ['conversation.chat.turnTail']);
  const effect = injections[0].callback();
  assert.equal(typeof effect, 'function', 'the injection returns its disposer');
  assert.deepEqual(registrations.map(({ options }) => options.name), [
    'conversation.chat.turnTail',
  ]);
  assert.equal(registrations[0].options.id, '@local/dsh-mdt-guard');
  assert.equal(typeof registrations[0].component, 'function');
});

test('the notice renders only for turns the host blocked', async () => {
  const entry = await loadClientBundle();
  const exports = entry.factory(fakeRequire);
  const { ctx, injections, registrations } = fakeClientContext();
  exports.apply(ctx);
  for (const { callback } of injections) {
    callback();
  }
  const component = registrations[0].component;

  const blocked = {
    turn: { end: { data: { reason: { kind: 'blocked' } } } },
    seq: 7,
    openFile() {},
  };
  const node = component(blocked);
  assert.equal(node.type, 'div');
  assert.equal(node.props.role, 'note');
  assert.equal(node.props['data-mdt-guard'], 'refusal');
  assert.equal(node.props.children, exports.REFUSAL_TEXT);
  assert.equal(node.key, undefined, 'the text must not be passed as the jsx key');

  for (const turn of [
    { end: { data: { reason: { kind: 'completed' } } } },
    { end: { data: { reason: { kind: 'max-tokens' } } } },
    { end: { data: { reason: { kind: 'aborted' } } } },
    { end: { data: { reason: { kind: 'error' } } } },
    { end: { data: { reason: { kind: 'interrupted' } } } },
    { end: { data: { reason: { kind: 'forked' } } } },
    { end: { data: { reason: {} } } },
    { end: { data: {} } },
    { end: undefined },
    undefined,
  ]) {
    assert.equal(component({ turn }), null);
  }
  assert.equal(component(undefined), null);

  for (const value of [undefined, null, {}, { end: null }, { end: { data: {} } }]) {
    assert.equal(exports.isBlockedTurn(value), false);
  }
  assert.equal(exports.isBlockedTurn(blocked.turn), true);
});

test('the client text matches the host default refusal text', async () => {
  const entry = await loadClientBundle();
  const exports = entry.factory(fakeRequire);

  assert.equal(exports.REFUSAL_TEXT, validateConfig({ enabled: false }).refusalText);
});
