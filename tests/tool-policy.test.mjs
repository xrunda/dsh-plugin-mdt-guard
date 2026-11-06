import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  TOOL_RESTRICT_DENY_ALL,
  TOOL_RESTRICT_FAILED,
  TOOL_SCHEMA_READ_FAILED,
  createToolScopeInstaller,
  resolveToolFilter,
} from '../tool-policy.js';

const toolsConfig = (allow = [], deny = [], enforce = true) => ({ allow, deny, enforce });

test('empty allow list denies every known inherited tool', () => {
  const filter = resolveToolFilter(toolsConfig(), ['read', 'bash']);

  assert.deepEqual(filter, { allow: [], deny: [] });
});

test('allow keeps only known names and never grants an unknown tool', () => {
  const filter = resolveToolFilter(
    toolsConfig(['ppt_render', 'read', 'not-installed'], []),
    ['read', 'bash', 'ppt_render'],
  );

  assert.deepEqual(filter, { allow: ['ppt_render', 'read'], deny: [] });
});

test('deny wins over allow and is de-duplicated', () => {
  const filter = resolveToolFilter(
    toolsConfig(['read', 'ppt_render', 'read'], ['read', 'read']),
    ['read', 'ppt_render'],
  );

  assert.deepEqual(filter, { allow: ['ppt_render'], deny: ['read'] });
});

test('unknown deny names are dropped so the host restrict call cannot throw', () => {
  const filter = resolveToolFilter(
    toolsConfig(['read'], ['not-installed']),
    ['read', 'bash'],
  );

  assert.deepEqual(filter, { allow: ['read'], deny: [] });
});

test('the reserved run_code transport is never named in a filter', () => {
  const filter = resolveToolFilter(
    toolsConfig(['run_code', 'read'], ['run_code']),
    ['run_code', 'read'],
  );

  assert.deepEqual(filter, { allow: ['read'], deny: [] });
});

function makeAgent() {
  const restrictions = [];
  return {
    restrictions,
    ctx: {
      tools: {
        restrict(filter) {
          restrictions.push(filter);
          return () => {};
        },
      },
    },
  };
}

test('installer applies the resolved filter through the agent-scoped tools service', async () => {
  const agent = makeAgent();
  const schemaScopes = [];
  const tools = {
    schemas(scope) {
      schemaScopes.push(scope);
      return [{ name: 'read' }, { name: 'bash' }];
    },
  };
  const installer = createToolScopeInstaller({
    tools,
    loadRuntime: async () => ({ config: { tools: toolsConfig(['read'], ['bash']) } }),
  });

  assert.equal(await installer(agent), true);
  assert.deepEqual(schemaScopes, [agent]);
  assert.deepEqual(agent.restrictions, [{ allow: ['read'], deny: ['bash'] }]);
});

test('installer does nothing when enforcement is disabled', async () => {
  const agent = makeAgent();
  let schemaReads = 0;
  const installer = createToolScopeInstaller({
    tools: {
      schemas() {
        schemaReads += 1;
        return [];
      },
    },
    loadRuntime: async () => ({ config: { tools: toolsConfig([], [], false) } }),
  });

  assert.equal(await installer(agent), false);
  assert.equal(schemaReads, 0);
  assert.deepEqual(agent.restrictions, []);
});

test('installer does nothing when the guard runtime is inactive', async () => {
  const agent = makeAgent();
  const installer = createToolScopeInstaller({
    tools: { schemas: () => [] },
    loadRuntime: async () => undefined,
  });

  assert.equal(await installer(agent), false);
  assert.deepEqual(agent.restrictions, []);
});

test('installer reports a sanitized code and stays fail-open when schemas cannot be read', async () => {
  const agent = makeAgent();
  const reported = [];
  const installer = createToolScopeInstaller({
    tools: {
      schemas() {
        throw new Error('raw filesystem detail');
      },
    },
    loadRuntime: async () => ({ config: { tools: toolsConfig() } }),
    reportFailure: (code) => reported.push(code),
  });

  assert.equal(await installer(agent), false);
  assert.deepEqual(reported, [TOOL_SCHEMA_READ_FAILED]);
  assert.deepEqual(agent.restrictions, []);
});

test('installer falls back to deny-all when the host rejects configured names', async () => {
  const reported = [];
  const attempts = [];
  const agent = makeAgent();
  agent.ctx.tools.restrict = (filter) => {
    attempts.push(filter);
    if (filter.allow.length > 0 || filter.deny.length > 0) {
      throw new Error('raw host detail');
    }
    return () => {};
  };
  const installer = createToolScopeInstaller({
    tools: { schemas: () => [{ name: 'read' }, { name: 'structured_output' }] },
    loadRuntime: async () => ({
      config: { tools: toolsConfig(['read', 'structured_output']) },
    }),
    reportFailure: (code) => reported.push(code),
  });

  assert.equal(await installer(agent), true);
  assert.deepEqual(attempts, [
    { allow: ['read', 'structured_output'], deny: [] },
    { allow: [], deny: [] },
  ]);
  assert.deepEqual(reported, [TOOL_RESTRICT_DENY_ALL]);
});

test('installer reports a sanitized code and stays fail-open when restrict throws', async () => {
  const reported = [];
  const agent = makeAgent();
  agent.ctx.tools.restrict = () => {
    throw new Error('raw host detail');
  };
  const installer = createToolScopeInstaller({
    tools: { schemas: () => [{ name: 'read' }] },
    loadRuntime: async () => ({ config: { tools: toolsConfig() } }),
    reportFailure: (code) => reported.push(code),
  });

  assert.equal(await installer(agent), false);
  assert.deepEqual(reported, [TOOL_RESTRICT_FAILED]);
});

test('installer treats a malformed agent as a restriction failure without throwing', async () => {
  const reported = [];
  const installer = createToolScopeInstaller({
    tools: { schemas: () => [{ name: 'read' }] },
    loadRuntime: async () => ({ config: { tools: toolsConfig() } }),
    reportFailure: (code) => reported.push(code),
  });

  assert.equal(await installer({}), false);
  assert.deepEqual(reported, [TOOL_RESTRICT_FAILED]);
});
