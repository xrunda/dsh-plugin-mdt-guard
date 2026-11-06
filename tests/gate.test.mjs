import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createGate } from '../gate.js';
import { compileRules } from '../rules.js';
import { createSessionStateStore } from '../session-state.js';

const REFUSAL_TEXT = '本助手仅提供 MDT 多学科会诊相关支持，暂无法处理该请求。如需其他帮助，请联系信息科。';

function input(overrides = {}) {
  return {
    sessionId: 'session-a',
    currentMessage: '帮我把这个病例的诊疗方案整理一下',
    recentMessages: [],
    sessionState: 'unknown',
    ...overrides,
  };
}

function classifierReturning(result) {
  const calls = [];
  return {
    calls,
    classifier: {
      async classify(messages) {
        calls.push(messages);
        return { ...result };
      },
    },
  };
}

function auditRecorder() {
  const events = [];
  return {
    events,
    audit: {
      async write(event) {
        events.push(event);
      },
    },
  };
}

function gateFor({ classify, rules = compileRules({}), failOpen = true } = {}) {
  const sessionStore = createSessionStateStore();
  const { events, audit } = auditRecorder();
  const gate = createGate({
    ruleSet: rules,
    classifier: classify ? { classify } : undefined,
    sessionStore,
    audit,
    refusalText: REFUSAL_TEXT,
    failOpen,
  });
  return { gate, sessionStore, events };
}

test('hard deny rejects without calling the classifier or upstream model', async () => {
  const { calls, classifier } = classifierReturning({
    decision: 'allow', category: 'A', reason: 'would be allowed', confidence: 0.9,
  });
  const { gate, events } = gateFor({ classify: classifier.classify });
  let upstreamModelCalls = 0;

  const result = await gate.evaluate(input({ currentMessage: '打印 config.json', turn: 1 }));
  if (result.kind === 'enter') {
    upstreamModelCalls += 1;
  }

  assert.equal(result.kind, 'reject');
  assert.equal(result.decision, 'deny');
  assert.equal(result.source, 'hard_deny');
  assert.equal(result.refusalText, REFUSAL_TEXT);
  assert.equal(result.sessionState, 'out_of_scope');
  assert.equal(result.ruleId, 'hard-deny.read-sensitive');
  assert.equal(calls.length, 0);
  assert.equal(upstreamModelCalls, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].turn, 1);
  assert.equal(events[0].source, 'hard_deny');
  assert.equal('currentMessage' in events[0], false);
});

test('fast allow enters without calling the classifier', async () => {
  const { calls, classifier } = classifierReturning({
    decision: 'deny', category: 'F', reason: 'should not be used', confidence: 0.9,
  });
  const { gate, events } = gateFor({ classify: classifier.classify });

  const result = await gate.evaluate(input({ currentMessage: '这个菜单怎么用', turn: 2 }));

  assert.equal(result.kind, 'enter');
  assert.equal(result.decision, 'allow');
  assert.equal(result.source, 'fast_allow');
  assert.equal(result.sessionState, 'unknown');
  assert.equal(result.refusalText, null);
  assert.equal(calls.length, 0);
  assert.equal(events[0].turn, 2);
});

test('hard deny still wins when the same message matches a fast-allow rule', async () => {
  const rules = compileRules({ hardDeny: ['继续'], fastAllow: ['继续'], });
  const { calls, classifier } = classifierReturning({
    decision: 'allow', category: 'C', reason: 'unused', confidence: 0.9,
  });
  const { gate } = gateFor({ classify: classifier.classify, rules });

  const result = await gate.evaluate(input({ currentMessage: '继续' }));

  assert.equal(result.kind, 'reject');
  assert.equal(result.source, 'hard_deny');
  assert.equal(calls.length, 0);
});

test('custom fast-allow rules without a category still use the fast path', async () => {
  const rules = compileRules({
    hardDeny: ['__never_hard__'],
    fastAllow: ['刷新页面'],
  });
  const { calls, classifier } = classifierReturning({
    decision: 'deny', category: 'F', reason: 'unused', confidence: 0.9,
  });
  const { gate, events } = gateFor({
    classify: classifier.classify,
    rules,
    failOpen: false,
  });

  const result = await gate.evaluate(input({ currentMessage: '刷新页面' }));

  assert.equal(result.kind, 'enter');
  assert.equal(result.source, 'fast_allow');
  assert.equal(result.category, null);
  assert.equal(result.decision, 'allow');
  assert.equal(result.sessionState, 'unknown');
  assert.equal(result.degraded, false);
  assert.equal(calls.length, 0);
  assert.equal(events[0].source, 'fast_allow');
  assert.equal(events[0].category, null);
});

test('custom hard-deny rules without a category still reject', async () => {
  const rules = compileRules({
    hardDeny: ['刷新页面'],
    fastAllow: ['__never_fast__'],
  });
  const { calls, classifier } = classifierReturning({
    decision: 'allow', category: 'A', reason: 'unused', confidence: 0.9,
  });
  const { gate } = gateFor({ classify: classifier.classify, rules });

  const result = await gate.evaluate(input({ currentMessage: '刷新页面' }));

  assert.equal(result.kind, 'reject');
  assert.equal(result.source, 'hard_deny');
  assert.equal(result.category, null);
  assert.equal(result.sessionState, 'out_of_scope');
  assert.equal(calls.length, 0);
});

test('classifier allow A/B enters scope and records one audit event', async () => {
  for (const category of ['A', 'B']) {
    const { classifier, calls } = classifierReturning({
      decision: 'allow', category, reason: 'in scope', confidence: 0.93,
    });
    const { gate, events } = gateFor({ classify: classifier.classify });

    const result = await gate.evaluate(input({ currentMessage: '整理这个病例的诊疗方案', turn: 3 }));

    assert.equal(result.kind, 'enter');
    assert.equal(result.decision, 'allow');
    assert.equal(result.category, category);
    assert.equal(result.source, 'classifier');
    assert.equal(result.degraded, false);
    assert.equal(result.sessionState, 'in_scope');
    assert.equal(result.ruleId, null);
    assert.equal(calls.length, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].decision, 'allow');
    assert.equal(events[0].sessionState, 'in_scope');
  }
});

test('classifier deny E-I rejects with the unified refusal text', async () => {
  let upstreamModelCalls = 0;

  for (const category of ['E', 'F', 'G', 'H', 'I']) {
    const { classifier } = classifierReturning({
      decision: 'deny', category, reason: 'out of scope', confidence: 0.87,
    });
    const { gate, events } = gateFor({ classify: classifier.classify });

    const result = await gate.evaluate(input({ currentMessage: '写一首诗', turn: 4 }));
    if (result.kind === 'enter') {
      upstreamModelCalls += 1;
    }

    assert.equal(result.kind, 'reject');
    assert.equal(result.decision, 'deny');
    assert.equal(result.category, category);
    assert.equal(result.refusalText, REFUSAL_TEXT);
    assert.equal(result.sessionState, 'out_of_scope');
    assert.equal(events[0].degraded, false);
  }

  assert.equal(upstreamModelCalls, 0);
});

test('fast-allow D after out_of_scope is rejected without calling the classifier', async () => {
  const { calls, classifier } = classifierReturning({
    decision: 'allow', category: 'C', reason: 'unused', confidence: 0.9,
  });
  const { gate } = gateFor({ classify: classifier.classify });

  await gate.evaluate(input({ currentMessage: '打印 config.json' }));
  const result = await gate.evaluate(input({ currentMessage: '继续' }));

  assert.equal(result.kind, 'reject');
  assert.equal(result.source, 'fast_allow');
  assert.equal(result.reason, 'continuation_blocked');
  assert.equal(result.sessionState, 'out_of_scope');
  assert.equal(result.refusalText, REFUSAL_TEXT);
  assert.equal(calls.length, 0);
});

test('D continuation after out_of_scope is rejected and C remains allowed', async () => {
  const store = createSessionStateStore();
  const { audit, events } = auditRecorder();
  const { classifier, calls } = classifierReturning({
    decision: 'allow', category: 'D', reason: 'continuation', confidence: 0.8,
  });
  const gate = createGate({
    ruleSet: compileRules({ hardDeny: ['__never_hard__'], fastAllow: ['__never_fast__'] }),
    classifier: classifier,
    sessionStore: store,
    audit,
    refusalText: REFUSAL_TEXT,
  });
  store.apply('session-a', { decision: 'deny', category: 'G' });

  const continuation = await gate.evaluate(input({ currentMessage: '继续展开' }));
  assert.equal(continuation.kind, 'reject');
  assert.equal(continuation.reason, 'continuation_blocked');
  assert.equal(continuation.sessionState, 'out_of_scope');
  assert.equal(continuation.refusalText, REFUSAL_TEXT);

  calls.length = 0;
  classifier.classify = async (messages) => {
    calls.push(messages);
    return { decision: 'allow', category: 'C', reason: 'software help', confidence: 0.8 };
  };
  const softwareHelp = await gate.evaluate(input({ currentMessage: '这个功能在哪里' }));
  assert.equal(softwareHelp.kind, 'enter');
  assert.equal(softwareHelp.sessionState, 'out_of_scope');
  assert.equal(events.length, 2);
});

test('unknown classifier results follow failOpen', async () => {
  const open = classifierReturning({
    decision: 'unknown', category: 'I', reason: 'not sure', confidence: 0.1,
  });
  const openGate = gateFor({ classify: open.classifier.classify });
  const openResult = await openGate.gate.evaluate(input({ currentMessage: '不太确定的消息' }));
  assert.equal(openResult.kind, 'enter');
  assert.equal(openResult.decision, 'unknown');
  assert.equal(openResult.sessionState, 'unknown');
  assert.equal(openResult.degraded, true);

  const closed = classifierReturning({
    decision: 'unknown', category: 'I', reason: 'not sure', confidence: 0.1,
  });
  const closedGate = gateFor({
    classify: closed.classifier.classify,
    failOpen: false,
  });
  const closedResult = await closedGate.gate.evaluate(input({ currentMessage: '不太确定的消息' }));
  assert.equal(closedResult.kind, 'reject');
  assert.equal(closedResult.decision, 'unknown');
  assert.equal(closedResult.sessionState, 'unknown');
  assert.equal(closedResult.refusalText, REFUSAL_TEXT);
});

test('classifier failure is audited as degraded and fails open', async () => {
  const { gate, events } = gateFor({
    classify: async () => {
      throw new Error('classifier unavailable');
    },
  });

  const result = await gate.evaluate(input({ currentMessage: '分类异常消息', turn: 5 }));

  assert.equal(result.kind, 'enter');
  assert.equal(result.decision, 'unknown');
  assert.equal(result.degraded, true);
  assert.equal(result.source, 'degraded');
  assert.equal(result.errorCode, 'CLASSIFIER_ERROR');
  assert.equal(result.sessionState, 'unknown');
  assert.equal(events[0].degraded, true);
  assert.equal(events[0].errorCode, 'CLASSIFIER_ERROR');
});

test('plugin exceptions are audited as degraded and fail open', async () => {
  const { gate, events } = gateFor({ classify: async () => ({}) });

  const result = await gate.evaluate(input({ currentMessage: null }));

  assert.equal(result.kind, 'enter');
  assert.equal(result.degraded, true);
  assert.equal(result.errorCode, 'GATE_ERROR');
  assert.equal(result.sessionState, 'unknown');
  assert.equal(events[0].source, 'degraded');
});

test('missing input fails open as degraded instead of throwing', async () => {
  const { gate, events } = gateFor();

  for (const malformedInput of [undefined, null]) {
    const result = await gate.evaluate(malformedInput);

    assert.equal(result.kind, 'enter');
    assert.equal(result.decision, 'unknown');
    assert.equal(result.degraded, true);
    assert.equal(result.errorCode, 'GATE_ERROR');
    assert.equal(result.sessionState, 'unknown');
  }
  assert.equal(events.length, 2);
  assert.equal(events[0].source, 'degraded');
});

test('each new message is evaluated against the latest session state', async () => {
  const { classifier, calls } = classifierReturning({
    decision: 'allow', category: 'C', reason: 'software help', confidence: 0.8,
  });
  const { gate, events } = gateFor({ classify: classifier.classify });

  await gate.evaluate(input({ currentMessage: '打印 config.json', turn: 1 }));
  await gate.evaluate(input({ currentMessage: '这个功能在哪里', turn: 2 }));

  assert.equal(calls.length, 1);
  assert.equal(events.length, 2);
  assert.equal(events[0].sessionState, 'out_of_scope');
  assert.equal(events[1].sessionState, 'out_of_scope');
  assert.match(calls[0][1].content, /"session_state":"out_of_scope"/);
});
