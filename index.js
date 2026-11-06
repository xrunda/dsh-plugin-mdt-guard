import { createJsonlAuditWriter } from './audit-log.js';
import { createClassifierClient } from './classifier-client.js';
import { loadConfig } from './config.js';
import { createGate } from './gate.js';
import { createPreStepHandler } from './pre-step.js';
import { compileRules } from './rules.js';
import {
  TOOL_RESTRICT_DENY_ALL,
  TOOL_RESTRICT_FAILED,
  TOOL_SCHEMA_READ_FAILED,
  createToolScopeInstaller,
} from './tool-policy.js';

/** Host services required before this plugin may register its listeners. */
export const inject = ['agents', 'tools'];

const TOOL_FAILURE_MESSAGES = {
  [TOOL_SCHEMA_READ_FAILED]:
    'dsh-mdt-guard: tool restriction skipped (tool schemas unavailable); tools stay unrestricted for this agent',
  [TOOL_RESTRICT_DENY_ALL]:
    'dsh-mdt-guard: configured tool filter was rejected; denying all inherited tools for this agent',
  [TOOL_RESTRICT_FAILED]:
    'dsh-mdt-guard: tool restriction failed; tools stay unrestricted for this agent',
};

function createRuntime(config) {
  const audit = config.audit.enabled
    ? createJsonlAuditWriter({
      storeText: config.audit.storeText,
      retentionDays: config.audit.retentionDays,
    })
    : undefined;

  const gate = createGate({
    ruleSet: compileRules({
      hardDeny: config.hardDeny,
      fastAllow: config.fastAllow,
    }),
    classifier: createClassifierClient({ ...config.classifier }),
    audit,
    refusalText: config.refusalText,
    failOpen: config.failOpen,
    contextTurns: config.contextTurns,
  });

  return createPreStepHandler({ gate });
}

/**
 * Register the server-side MDT gate with the DSH Host.
 *
 * Configuration is loaded from the server-side file once and validated before
 * the first agent creation or gated message. A disabled guard or an invalid
 * configuration keeps DSH's default behavior. Runtime failures fall through to
 * the host default decision as required by FR-10.
 *
 * Tool restrictions are installed per agent through the agent-scoped tools
 * service, because DSH rejects a context-global restriction. The live-agent
 * list covers agents created before this plugin loaded; `agent/created`
 * covers later agents and subagents.
 */
export function apply(ctx, _config) {
  let runtimePromise;

  const reportInactive = (error) => {
    try {
      const code = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
      const field = typeof error?.field === 'string' ? `, field ${error.field}` : '';
      ctx.logger?.warn(
        `dsh-mdt-guard: runtime initialization failed (${code}${field}); guard inactive`,
      );
    } catch {
      // Reporting is best-effort; the guard stays inactive either way.
    }
  };

  const loadRuntime = () => {
    runtimePromise ??= loadConfig()
      .then((config) => (
        config.enabled
          ? { config, handler: createRuntime(config) }
          : undefined
      ))
      .catch((error) => {
        reportInactive(error);
        return undefined;
      });
    return runtimePromise;
  };

  const installToolRestriction = createToolScopeInstaller({
    tools: ctx.tools,
    loadRuntime,
    reportFailure(code) {
      try {
        ctx.logger?.warn(TOOL_FAILURE_MESSAGES[code] ?? 'dsh-mdt-guard: tool restriction failed');
      } catch {
        // Reporting is best-effort; a failure never blocks the agent.
      }
    },
  });

  for (const agent of ctx.agents.list()) {
    void installToolRestriction(agent).catch(() => {});
  }

  const preStepDisposer = ctx.on('agent/pre-step', async (payload, next) => {
    const runtime = await loadRuntime();
    if (runtime === undefined) return next();
    return runtime.handler.handle(payload, next);
  });
  ctx.on('agent/created', async ({ agent }) => {
    await installToolRestriction(agent);
  });
  return preStepDisposer;
}
