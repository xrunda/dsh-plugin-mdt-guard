/**
 * Server-side tool visibility policy for the MDT guard.
 *
 * DSH `agent.ctx.tools.restrict()` only accepts global tool names that are
 * currently registered, rejects the reserved `run_code` transport, and treats
 * an empty `allow` list as "admit no inherited tool". Deployment configuration
 * is therefore resolved against the tools each agent can actually see:
 *
 * - only confirmed, currently registered names can be allowed;
 * - names outside the agent's visible set are ignored;
 * - if the host refuses a visible name as a restriction target, the whole
 *   filter falls back to default-deny;
 * - `deny` always wins over `allow`;
 * - an empty `allow` list denies every inherited tool (default deny);
 * - if the host rejects the resolved filter, the installer falls back to an
 *   empty allow list so one bad name cannot disable the whole restriction.
 *
 * Restrictions are applied per agent because the host rejects a
 * context-global restriction. `agent/created` and the live-agent list cover
 * every new and existing agent, including subagents.
 */

export const TOOL_SCHEMA_READ_FAILED = 'TOOL_SCHEMA_READ_FAILED';
export const TOOL_RESTRICT_FAILED = 'TOOL_RESTRICT_FAILED';
export const TOOL_RESTRICT_DENY_ALL = 'TOOL_RESTRICT_DENY_ALL';

const RESERVED_TOOL_NAMES = new Set(['run_code']);

/**
 * Resolve the configured allow/deny lists against one agent's visible names.
 *
 * @param {{ allow?: string[], deny?: string[] }} toolsConfig
 * @param {Iterable<string>} knownNames tool names visible to one agent
 * @returns {{ allow: string[], deny: string[] }}
 */
export function resolveToolFilter(toolsConfig = {}, knownNames = []) {
  const known = new Set(knownNames);
  const allowed = new Set();
  for (const name of toolsConfig.allow ?? []) {
    if (known.has(name) && !RESERVED_TOOL_NAMES.has(name)) {
      allowed.add(name);
    }
  }

  const denied = new Set();
  for (const name of toolsConfig.deny ?? []) {
    if (known.has(name) && !RESERVED_TOOL_NAMES.has(name)) {
      denied.add(name);
      allowed.delete(name);
    }
  }

  return { allow: [...allowed], deny: [...denied] };
}

/**
 * Create the per-agent installer used by the plugin entry point.
 *
 * Failures are reported with fixed codes and never prevent agent creation. A
 * rejected filter is replaced by default-deny; if that also fails, the
 * installer resolves `false` and leaves tools unrestricted (FR-10 fail-open).
 *
 * @param {{
 *   tools: { schemas(scope?: object): Array<{ name?: string }> },
 *   loadRuntime: () => Promise<{ config: { tools: object } } | undefined>,
 *   reportFailure?: (code: string) => void,
 * }} options
 */
export function createToolScopeInstaller({ tools, loadRuntime, reportFailure } = {}) {
  if (tools === null || typeof tools !== 'object' || typeof tools.schemas !== 'function') {
    throw new TypeError('tools must expose a schemas function');
  }
  if (typeof loadRuntime !== 'function') {
    throw new TypeError('loadRuntime must be a function');
  }
  const report = typeof reportFailure === 'function' ? reportFailure : () => {};

  return async function install(agent) {
    let runtime;
    try {
      runtime = await loadRuntime();
    } catch {
      return false;
    }
    if (runtime === undefined || runtime.config?.tools?.enforce !== true) {
      return false;
    }

    let knownNames;
    try {
      const schemas = tools.schemas(agent);
      knownNames = Array.isArray(schemas)
        ? schemas
          .map((schema) => schema?.name)
          .filter((name) => typeof name === 'string')
        : [];
    } catch {
      report(TOOL_SCHEMA_READ_FAILED);
      return false;
    }

    const filter = resolveToolFilter(runtime.config.tools, knownNames);
    const scopedTools = agent?.ctx?.tools;
    try {
      if (typeof scopedTools?.restrict !== 'function') {
        throw new TypeError('restrict is unavailable');
      }
      scopedTools.restrict(filter);
      return true;
    } catch {
      try {
        // A name the host reports as visible but refuses to restrict (for
        // example an agent-scope mechanism tool) rejects the whole filter.
        // Fall back to default-deny rather than leaving every inherited tool
        // callable.
        scopedTools.restrict({ allow: [], deny: [] });
        report(TOOL_RESTRICT_DENY_ALL);
        return true;
      } catch {
        report(TOOL_RESTRICT_FAILED);
        return false;
      }
    }
  };
}
