import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_STATE,
  createSessionStateStore,
  nextSessionState,
} from '../session-state.js';

const allow = (category) => ({
  decision: 'allow',
  category,
  reason: 'test',
  confidence: 0.9,
});
const deny = (category) => ({
  decision: 'deny',
  category,
  reason: 'test',
  confidence: 0.9,
});
const unknown = (category) => ({
  decision: 'unknown',
  category,
  reason: 'test',
  confidence: 0,
});

test('new sessions start unknown and are isolated', () => {
  const store = createSessionStateStore();

  assert.equal(store.get('session-a'), SESSION_STATE.UNKNOWN);
  assert.equal(store.get('session-b'), SESSION_STATE.UNKNOWN);

  store.apply('session-a', allow('A'));

  assert.equal(store.get('session-a'), SESSION_STATE.IN_SCOPE);
  assert.equal(store.get('session-b'), SESSION_STATE.UNKNOWN);
});

test('nextSessionState implements the PRD transition table', () => {
  const cases = [
    [SESSION_STATE.UNKNOWN, allow('A'), SESSION_STATE.IN_SCOPE],
    [SESSION_STATE.IN_SCOPE, allow('A'), SESSION_STATE.IN_SCOPE],
    [SESSION_STATE.OUT_OF_SCOPE, allow('A'), SESSION_STATE.IN_SCOPE],
    [SESSION_STATE.UNKNOWN, allow('B'), SESSION_STATE.IN_SCOPE],
    [SESSION_STATE.IN_SCOPE, allow('B'), SESSION_STATE.IN_SCOPE],
    [SESSION_STATE.OUT_OF_SCOPE, allow('B'), SESSION_STATE.IN_SCOPE],
    [SESSION_STATE.UNKNOWN, allow('C'), SESSION_STATE.UNKNOWN],
    [SESSION_STATE.IN_SCOPE, allow('C'), SESSION_STATE.IN_SCOPE],
    [SESSION_STATE.OUT_OF_SCOPE, allow('C'), SESSION_STATE.OUT_OF_SCOPE],
    [SESSION_STATE.UNKNOWN, allow('D'), SESSION_STATE.UNKNOWN],
    [SESSION_STATE.IN_SCOPE, allow('D'), SESSION_STATE.IN_SCOPE],
    [SESSION_STATE.OUT_OF_SCOPE, allow('D'), SESSION_STATE.OUT_OF_SCOPE],
    [SESSION_STATE.UNKNOWN, allow(null), SESSION_STATE.UNKNOWN],
    [SESSION_STATE.IN_SCOPE, allow(null), SESSION_STATE.IN_SCOPE],
    [SESSION_STATE.OUT_OF_SCOPE, allow(null), SESSION_STATE.OUT_OF_SCOPE],
    [SESSION_STATE.UNKNOWN, deny('G'), SESSION_STATE.OUT_OF_SCOPE],
    [SESSION_STATE.IN_SCOPE, deny('G'), SESSION_STATE.OUT_OF_SCOPE],
    [SESSION_STATE.OUT_OF_SCOPE, deny('G'), SESSION_STATE.OUT_OF_SCOPE],
    [SESSION_STATE.UNKNOWN, unknown('I'), SESSION_STATE.UNKNOWN],
    [SESSION_STATE.IN_SCOPE, unknown('I'), SESSION_STATE.UNKNOWN],
    [SESSION_STATE.OUT_OF_SCOPE, unknown('I'), SESSION_STATE.UNKNOWN],
  ];

  for (const [current, decision, expected] of cases) {
    assert.equal(nextSessionState(current, decision), expected);
  }
});

test('D continuation in out_of_scope is effectively denied and stays out of scope', () => {
  const store = createSessionStateStore();
  store.apply('session-a', deny('G'));

  const result = store.apply('session-a', allow('D'));

  assert.equal(result.decision.decision, 'deny');
  assert.equal(result.decision.category, 'D');
  assert.equal(result.state, SESSION_STATE.OUT_OF_SCOPE);
  assert.equal(store.get('session-a'), SESSION_STATE.OUT_OF_SCOPE);
});

test('D continuation in scope remains allowed without changing state', () => {
  const store = createSessionStateStore();
  store.apply('session-a', allow('A'));

  const result = store.apply('session-a', allow('D'));

  assert.equal(result.decision.decision, 'allow');
  assert.equal(result.state, SESSION_STATE.IN_SCOPE);
});

test('every applied decision re-evaluates from the latest session state', () => {
  const store = createSessionStateStore();

  assert.equal(store.apply('session-a', allow('A')).state, SESSION_STATE.IN_SCOPE);
  assert.equal(store.apply('session-a', deny('G')).state, SESSION_STATE.OUT_OF_SCOPE);
  assert.equal(store.apply('session-a', unknown('I')).state, SESSION_STATE.UNKNOWN);
  assert.equal(store.apply('session-a', allow('B')).state, SESSION_STATE.IN_SCOPE);
});

test('apply does not mutate the caller decision', () => {
  const store = createSessionStateStore();
  const continuation = allow('D');
  store.apply('session-a', deny('G'));

  store.apply('session-a', continuation);

  assert.equal(continuation.decision, 'allow');
  assert.equal(Object.isFrozen(continuation), false);
});

test('reset returns a session to unknown', () => {
  const store = createSessionStateStore();
  store.apply('session-a', allow('A'));

  store.reset('session-a');

  assert.equal(store.get('session-a'), SESSION_STATE.UNKNOWN);
});

test('invalid states, decisions and allow categories are rejected', () => {
  assert.throws(() => nextSessionState('invalid', allow('A')), TypeError);
  assert.throws(() => nextSessionState(SESSION_STATE.UNKNOWN, null), TypeError);
  assert.throws(
    () => nextSessionState(SESSION_STATE.UNKNOWN, { decision: 'maybe' }),
    TypeError,
  );
  assert.throws(
    () => nextSessionState(SESSION_STATE.UNKNOWN, allow('E')),
    TypeError,
  );
});
