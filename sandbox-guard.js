/**
 * Server-side file-path boundary for the MDT guard.
 *
 * DSH's sandbox policy confines file *mutations* to the session workspace but
 * leaves file reads unconfined. This module adds a tool guard on the host
 * side, before any filesystem tool executes:
 *
 * - a file tool may only reach paths inside the calling session's workspace;
 * - relative paths are resolved the same way the DSH fs tools resolve them,
 *   against the session's *effective* working directory (which a session may
 *   change), while containment is still checked against the original
 *   workspace from `session.header.cwd`;
 * - paths under the configured protected roots (default `~/.dsh` and `/root`)
 *   are denied even when the workspace itself contains them;
 * - `..` traversal, home-relative paths and symlinks that resolve outside the
 *   workspace are denied through canonical resolution;
 * - a denial reason is fixed text and never echoes the requested path;
 * - any guard error or missing runtime state fails open as required by FR-10.
 *
 * The guard covers the DSH file tools it knows (`read`, `write`, `edit`,
 * `read_image`, `glob`, `grep`, `str_replace_editor`) plus any tool that takes
 * an unambiguous `file_path` argument. Shell tools are not parsed here: they
 * must stay out of the tool allowlist (`tools.deny` / `tools.allow`) and are
 * confined by DSH's own sandbox policy. See Docs/M3-file-boundaries.md.
 */

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const SANDBOX_WORKSPACE_DENIED =
  'dsh-mdt-guard: file access outside the session workspace is blocked';
export const SANDBOX_PROTECTED_DENIED =
  'dsh-mdt-guard: access to a protected path is blocked';

/** File tools whose path argument is known from the DSH 0.2.1 tool schemas. */
const TOOL_PATH_ARGUMENTS = new Map([
  ['read', 'file_path'],
  ['write', 'file_path'],
  ['edit', 'file_path'],
  ['read_image', 'file_path'],
  ['glob', 'path'],
  ['grep', 'path'],
  ['str_replace_editor', 'path'],
]);

/** Unambiguous path key used for tools not listed above. */
const GENERIC_PATH_KEY = 'file_path';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expandHome(value, home) {
  if (value === '~') return home;
  if (value.startsWith('~/')) return `${home}${path.sep}${value.slice(2)}`;
  return value;
}

/**
 * Resolve one requested path to the spelling the DSH fs tools would use.
 *
 * DSH keeps the raw spelling on POSIX so the kernel resolves `..` *physically*
 * (after following symlinks); collapsing it with `path.normalize` first would
 * check a different path than the one the tool opens. Windows collapses `..`
 * lexically, so the guard does the same there.
 *
 * @returns {string|undefined} `undefined` when a relative path has no base
 *   to resolve against.
 */
function resolveRequestedPath(value, base, home) {
  const expanded = expandHome(value, home);
  if (path.isAbsolute(expanded)) {
    return process.platform === 'win32' ? path.normalize(expanded) : expanded;
  }
  if (base === undefined) return undefined;
  return process.platform === 'win32'
    ? path.resolve(base, expanded)
    : `${base}${path.sep}${expanded}`;
}

/**
 * Resolve symlinks for a path that may not exist yet by canonicalizing its
 * deepest existing ancestor and re-attaching the missing suffix.
 *
 * @returns {string|undefined} `undefined` when no ancestor can be resolved.
 */
function canonicalize(target, realpath) {
  try {
    return path.normalize(realpath(target));
  } catch {
    const parent = path.dirname(target);
    if (parent === target) return undefined;
    const resolvedParent = canonicalize(parent, realpath);
    if (resolvedParent === undefined) return undefined;
    return path.join(resolvedParent, path.basename(target));
  }
}

/** Whether `child` equals `parent` or is contained by it. */
function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === ''
    || (relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative));
}

function normalizeDirectory(value, home) {
  return typeof value === 'string' && value.length > 0
    ? path.normalize(expandHome(value, home))
    : undefined;
}

function resolveProtectedRoots(sandbox, workspace, home) {
  const roots = [];
  const values = Array.isArray(sandbox.denyPaths) ? sandbox.denyPaths : [];
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0) continue;
    const resolved = resolveRequestedPath(value, workspace, home);
    if (resolved !== undefined) roots.push(resolved);
  }
  return roots;
}

function isProtected(target, roots) {
  return roots.some((root) => isWithin(root, target));
}

/**
 * Decide whether one tool call may touch the requested path.
 *
 * @param {{
 *   toolName?: string,
 *   args?: unknown,
 *   workspace?: string,
 *   workingDirectory?: string,
 *   sandbox?: { enforce?: boolean, denyPaths?: string[] },
 *   home?: string,
 *   realpath?: (value: string) => string,
 * }} input
 * @returns {string|undefined} a fixed denial reason, or `undefined` to allow.
 */
export function checkToolAccess({
  toolName,
  args,
  workspace,
  workingDirectory,
  sandbox,
  home = homedir(),
  // `.native` mirrors DSH's own `realpath.native` usage, so symlinks and
  // case-insensitive filesystems canonicalize exactly like the fs tools.
  realpath = realpathSync.native,
} = {}) {
  if (sandbox === null || typeof sandbox !== 'object' || sandbox.enforce !== true) {
    return undefined;
  }
  if (typeof toolName !== 'string' || toolName.length === 0) return undefined;
  if (!isPlainObject(args)) return undefined;

  const normalizedWorkspace = normalizeDirectory(workspace, home);
  const normalizedWorkingDirectory = normalizeDirectory(workingDirectory, home);
  // DSH fs tools resolve relative arguments against the session's effective
  // working directory, which may differ from the workspace recorded at
  // creation. Resolve the same way and keep containment against the workspace.
  const resolutionBase = normalizedWorkingDirectory ?? normalizedWorkspace;
  const containmentRoot = normalizedWorkspace ?? normalizedWorkingDirectory;

  const pathKey = TOOL_PATH_ARGUMENTS.get(toolName) ?? GENERIC_PATH_KEY;
  const requested = args[pathKey];
  // `glob`/`grep` default to the session's effective directory when `path` is
  // omitted, so the implicit target must be checked too.
  const defaultsToWorkingDirectory = (requested === undefined || requested === '')
    && (toolName === 'glob' || toolName === 'grep');
  if (!defaultsToWorkingDirectory && (typeof requested !== 'string' || requested.length === 0)) {
    return undefined;
  }

  const target = defaultsToWorkingDirectory
    ? resolutionBase
    : resolveRequestedPath(requested, resolutionBase, home);
  if (target === undefined) return undefined;

  const roots = resolveProtectedRoots(
    sandbox,
    containmentRoot ?? resolutionBase,
    home,
  );

  // Canonical paths are authoritative: they follow symlinks (and, on
  // case-insensitive filesystems, normalize case), which is what the kernel
  // does for the tool's own `realpath`-based resolution. Lexical comparison is
  // only a fallback when a path cannot be canonicalized at all.
  const canonicalWorkspace = containmentRoot === undefined
    ? undefined
    : canonicalize(containmentRoot, realpath);
  const canonicalTarget = canonicalize(target, realpath);
  const canonicalRoots = roots
    .map((root) => canonicalize(root, realpath) ?? root);

  if (canonicalTarget !== undefined && canonicalWorkspace !== undefined) {
    if (isProtected(canonicalTarget, canonicalRoots)) return SANDBOX_PROTECTED_DENIED;
    if (!isWithin(canonicalWorkspace, canonicalTarget)) return SANDBOX_WORKSPACE_DENIED;
    return undefined;
  }

  if (isProtected(target, roots)) return SANDBOX_PROTECTED_DENIED;
  if (containmentRoot !== undefined && !isWithin(containmentRoot, target)) {
    return SANDBOX_WORKSPACE_DENIED;
  }

  return undefined;
}

/**
 * Create the DSH `ToolGuard` used by the plugin entry point.
 *
 * The guard reads the already-loaded runtime configuration synchronously. It
 * stays inactive until the runtime is available, when the guard is disabled,
 * or when the sandbox section opts out.
 *
 * @param {{
 *   getConfig: () => { enabled?: boolean, sandbox?: object } | undefined,
 *   getWorkingDirectory?: (execution: object) => string|undefined,
 *   getWorkspaceRoot?: (execution: object) => string|undefined,
 *   home?: string,
 *   realpath?: (value: string) => string,
 * }} options
 * @returns {(execution: object) => string|undefined}
 */
export function createSandboxGuard({
  getConfig,
  getWorkingDirectory,
  getWorkspaceRoot,
  home,
  realpath,
} = {}) {
  if (typeof getConfig !== 'function') {
    throw new TypeError('getConfig must be a function');
  }

  return function guard(execution) {
    try {
      const config = getConfig();
      if (config?.enabled !== true) return undefined;
      const sandbox = config.sandbox;
      if (sandbox === null || typeof sandbox !== 'object' || sandbox.enforce !== true) {
        return undefined;
      }
      const workspace = execution?.agent?.session?.header?.cwd
        ?? getWorkspaceRoot?.(execution);
      return checkToolAccess({
        toolName: execution?.name,
        args: execution?.arguments,
        workspace,
        workingDirectory: getWorkingDirectory?.(execution),
        sandbox,
        home,
        realpath,
      });
    } catch {
      // A guard failure must never block a session (FR-10).
      return undefined;
    }
  };
}
