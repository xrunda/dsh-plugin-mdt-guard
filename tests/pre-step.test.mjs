import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPreStepHandler } from '../pre-step.js';

function textMessage(text, overrides = {}) {
  return {
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
    ...overrides,
  };
}

function payload({ messages = [textMessage('帮我把这个病例整理一下')], history = [] } = {}) {
  return {
    agent: {
      session: {
        id: 'session-a',
        deriveMessages: () => history,
      },
    },
    messages,
    turn: 2,
    step: 1,
    signal: new AbortController().signal,
  };
}

function gateReturning(result) {
  const calls = [];
  return {
    calls,
    gate: {
      async evaluate(input) {
        calls.push(input);
        return result;
      },
    },
  };
}

function nextRecorder() {
  const calls = [];
  const decision = { kind: 'enter', messages: [] };
  return {
    calls,
    next: async () => {
      calls.push(true);
      return decision;
    },
    decision,
  };
}

test('a denied batch returns reject without entering the host next step', async () => {
  const { gate, calls } = gateReturning({ kind: 'reject', decision: 'deny' });
  const handler = createPreStepHandler({ gate });
  const { next, calls: nextCalls } = nextRecorder();

  const decision = await handler.handle(payload(), next);

  assert.deepEqual(decision, { kind: 'reject' });
  assert.equal(nextCalls.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, 'session-a');
  assert.equal(calls[0].currentMessage, '帮我把这个病例整理一下');
  assert.equal(calls[0].turn, 2);
  assert.equal(calls[0].sessionState, 'unknown');
  assert.deepEqual(calls[0].recentMessages, []);
});

test('an allowed batch continues the host default decision unchanged', async () => {
  const { gate, calls } = gateReturning({ kind: 'enter', decision: 'allow' });
  const handler = createPreStepHandler({ gate });
  const { next, calls: nextCalls, decision: expected } = nextRecorder();

  const decision = await handler.handle(payload(), next);

  assert.equal(decision, expected);
  assert.equal(nextCalls.length, 1);
  assert.equal(calls.length, 1);
});

test('tool-loop steps without new user messages bypass classification', async () => {
  const { gate, calls } = gateReturning({ kind: 'reject', decision: 'deny' });
  const handler = createPreStepHandler({ gate });
  const { next, calls: nextCalls, decision } = nextRecorder();

  const result = await handler.handle(payload({ messages: [] }), next);

  assert.equal(result, decision);
  assert.equal(nextCalls.length, 1);
  assert.equal(calls.length, 0);
});

test('injected context without user-authored messages bypasses classification', async () => {
  const injected = textMessage('workspace instructions', {
    source: { kind: 'file', form: 'instructions' },
  });
  const { gate, calls } = gateReturning({ kind: 'reject', decision: 'deny' });
  const handler = createPreStepHandler({ gate });
  const { next, calls: nextCalls } = nextRecorder();

  await handler.handle(payload({ messages: [injected] }), next);

  assert.equal(nextCalls.length, 1);
  assert.equal(calls.length, 0);
});

test('conversation history and attachment types reach the gate', async () => {
  const history = [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '上一个问题' }] },
    { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '上一个回答' }] },
    { role: 'tool', content: [{ type: 'text', text: '工具结果' }] },
    { role: 'user', source: { kind: 'file' }, content: [{ type: 'text', text: '注入的上下文' }] },
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment: {} }] },
  ];
  const messages = [
    textMessage('看看这张图', {
      content: [
        { type: 'text', text: '看看这张图' },
        { type: 'image', attachment: {} },
        { type: 'image', attachment: {} },
        { type: 'file', attachment: {} },
      ],
    }),
    textMessage('再补充一句'),
  ];
  const { gate, calls } = gateReturning({ kind: 'enter', decision: 'allow' });
  const handler = createPreStepHandler({ gate });
  const { next } = nextRecorder();

  await handler.handle(payload({ messages, history }), next);

  assert.equal(calls[0].currentMessage, '看看这张图\n再补充一句');
  assert.deepEqual(calls[0].attachmentTypes, ['image', 'file']);
  assert.deepEqual(calls[0].recentMessages, [
    { role: 'user', content: '上一个问题' },
    { role: 'assistant', content: '上一个回答' },
  ]);
});

test('adapter failures fall through to the host default decision', async () => {
  const handler = createPreStepHandler({
    gate: {
      async evaluate() {
        throw new Error('boom');
      },
    },
  });
  const { next, calls, decision } = nextRecorder();
  const brokenPayload = {
    agent: {
      session: {
        id: 'session-a',
        deriveMessages() {
          throw new Error('history unavailable');
        },
      },
    },
    messages: [textMessage('hello')],
    turn: 1,
  };

  assert.equal(await handler.handle(brokenPayload, next), decision);
  assert.equal(calls.length, 1);
  assert.equal(await handler.handle(payload(), next), decision);
  assert.equal(calls.length, 2);
});

test('a payload without a session id bypasses the gate', async () => {
  const { gate, calls } = gateReturning({ kind: 'reject', decision: 'deny' });
  const handler = createPreStepHandler({ gate });
  const { next, calls: nextCalls } = nextRecorder();

  await handler.handle({ agent: { session: {} }, messages: [textMessage('hello')] }, next);

  assert.equal(nextCalls.length, 1);
  assert.equal(calls.length, 0);
});

test('a host rejection from next propagates without a second call', async () => {
  const { gate } = gateReturning({ kind: 'enter', decision: 'allow' });
  const handler = createPreStepHandler({ gate });
  let calls = 0;

  await assert.rejects(
    handler.handle(payload(), async () => {
      calls += 1;
      throw new Error('host failed');
    }),
    /host failed/,
  );
  assert.equal(calls, 1);
});

test('createPreStepHandler rejects an invalid gate', () => {
  assert.throws(() => createPreStepHandler({}), TypeError);
  assert.throws(() => createPreStepHandler({ gate: { evaluate: 1 } }), TypeError);
});
