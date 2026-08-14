// rules-paths — Claude Code-style `paths:` rule injection for DSH.
//
// The package root exports only the Cordis plugin contract (`name`, `Config`,
// and `apply`), mirroring the official `@deepseek-ai/dsh-agent-instructions`
// layout. Mount it as a preset row:
//
//   - id: rules-paths
//     name: dsh-rules-paths          # or ./lib/index.js inside a copied preset
//     config:
//       rulesDir: "~/.dsh/rules"
//       rulesDirProject: true
//
// Two rule kinds are declared by each file in the rules directory:
//   - rules WITH a `paths:` list are injected when the model successfully reads
//     a file matching any pattern (default trigger tool: `read`), at the next
//     step boundary;
//   - rules WITHOUT `paths` (or with no frontmatter at all) are GLOBAL rules,
//     injected into the first entering step of the session, independent of any
//     file read, like AGENTS.md workspace instructions.
//
// Runtime mechanics replicate `@deepseek-ai/dsh-agent-instructions`:
// `tools/result` observes successful reads and resolves `file_path` against
// `agent.session.header.cwd`; touches bubble through opaque parent execution
// tokens and are projected (serialized per agent) after the durable
// `step/end` boundary; the projection composes the desired message and syncs
// it into `agent.inbox.nextStep`; `agent/pre-step` awaits in-flight
// projections and folds pending rules-paths messages (plus the global-rule
// baseline) into the entering batch right after the last claimed message.
// Injected content is user-role guidance — it does not override system,
// developer, or direct user instructions.

import { isDeepStrictEqual } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { dshHomeDisplay, expandHomePath, resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import picomatch from "picomatch";
import yaml from "js-yaml";

const name = "rules-paths";

// ── configuration ───────────────────────────────────────────────────────────

const DEFAULT_RULES_DIR = "~/.dsh/rules";
const DEFAULT_MAX_BYTES = 65536;
const DEFAULT_MAX_SOURCE_BYTES = 1048576;
const DEFAULT_TRIGGER_TOOLS = ["read"];
const DEFAULT_PROJECT_ROOT_MARKERS = [".git"];

const Config = z.object({
  rulesDir: z.string().default(DEFAULT_RULES_DIR),
  maxBytes: z.number().step(1).min(1).default(DEFAULT_MAX_BYTES),
  maxSourceBytes: z.number().step(1).min(1).default(DEFAULT_MAX_SOURCE_BYTES),
  triggerTools: z.array(z.string()).default([...DEFAULT_TRIGGER_TOOLS]),
  rulesDirProject: z.boolean().default(false),
});

/** Normalize the validated user config into absolute runtime values. */
function resolveConfig(config, env = process.env) {
  const dshHome = resolveDshHome(undefined, env);
  return {
    dshHome,
    rulesDir: resolve(expandHomePath(config.rulesDir ?? DEFAULT_RULES_DIR)),
    maxBytes: config.maxBytes ?? DEFAULT_MAX_BYTES,
    maxSourceBytes: config.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES,
    triggerTools: config.triggerTools !== undefined && config.triggerTools.length > 0
      ? [...config.triggerTools]
      : [...DEFAULT_TRIGGER_TOOLS],
    rulesDirProject: config.rulesDirProject === true,
    projectRootMarkers: DEFAULT_PROJECT_ROOT_MARKERS,
  };
}

// ── small utilities ─────────────────────────────────────────────────────────

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value, maxBytes) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let end = Math.max(0, Math.trunc(maxBytes));
  while (end > 0 && (bytes.readUInt8(end) & 192) === 128) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function sha1(value) {
  return createHash("sha1").update(value).digest("hex");
}

function toPosix(path) {
  return path.split("\\").join("/");
}

// ── frontmatter ─────────────────────────────────────────────────────────────

/**
 * Split a rule file into frontmatter data and body.
 * @returns `{ data, body }`, or `null` when the file has no `---` block.
 */
function splitFrontmatter(source) {
  const lines = source.split(/\r?\n/);
  if (lines.length === 0 || !/^---\s*$/.test(lines[0])) return null;
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (/^---\s*$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  if (end < 0) return null;
  let data;
  try {
    data = yaml.load(lines.slice(1, end).join("\n"));
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  return { data, body: lines.slice(end + 1).join("\n").trim() };
}

// ── rule file loading ───────────────────────────────────────────────────────

async function statProvider(path, fileSystem, signal) {
  if (fileSystem !== undefined) {
    try {
      const target = await fileSystem.resolve(path, { signal });
      signal?.throwIfAborted();
      const info = await fileSystem.stat(target, signal);
      signal?.throwIfAborted();
      return info;
    } catch {
      signal?.throwIfAborted();
      return undefined;
    }
  }
  try {
    const info = await stat(path);
    return { type: info.isFile() ? "file" : info.isDirectory() ? "directory" : "other", size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
}

async function listRulesDirProvider(dir, fileSystem, signal) {
  if (fileSystem !== undefined) {
    try {
      const target = await fileSystem.resolve(dir, { signal });
      signal?.throwIfAborted();
      const entries = await fileSystem.listDir(target, signal);
      signal?.throwIfAborted();
      return entries.map((entry) => ({ name: entry.name, type: entry.type }));
    } catch {
      signal?.throwIfAborted();
      return undefined;
    }
  }
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      type: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other",
    }));
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
}

async function readTextBounded(absolutePath, maxSourceBytes, fileSystem, signal) {
  if (fileSystem !== undefined) {
    try {
      const target = await fileSystem.resolve(absolutePath, { signal });
      signal?.throwIfAborted();
      const info = await fileSystem.stat(target, signal);
      signal?.throwIfAborted();
      if (info === undefined || info.type !== "file") return undefined;
      if (info.size !== undefined && info.size > maxSourceBytes) return undefined;
      const text = await fileSystem.readText(target, signal);
      signal?.throwIfAborted();
      return byteLength(text) > maxSourceBytes ? undefined : text;
    } catch {
      signal?.throwIfAborted();
      return undefined;
    }
  }
  try {
    const info = await stat(absolutePath);
    if (!info.isFile() || info.size > maxSourceBytes) return undefined;
    const text = await readFile(absolutePath, "utf8");
    return byteLength(text) > maxSourceBytes ? undefined : text;
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
}

/**
 * Load and parse one rule file.
 * @returns `{ status: 'ok', rule, statKey }` or `{ status: 'skip', reason }`.
 * A rule is GLOBAL (`patterns: []`, `global: true`) when it declares no
 * usable `paths` — the frontmatter lacks/empties `paths`, or the file has NO
 * frontmatter at all (then the whole file is the rule body). A `paths` field
 * that is neither a string nor a list is skipped as malformed. Oversized
 * files are skipped. The returned rule carries no display path — the caller
 * attaches it per cwd.
 */
async function loadRuleFile(absolutePath, resolved, fileSystem, signal) {
  const info = await statProvider(absolutePath, fileSystem, signal);
  signal?.throwIfAborted();
  if (info === undefined) return { status: "skip", reason: "unreadable" };
  if (info.type !== "file") return { status: "skip", reason: "not-a-file" };
  if (info.size !== undefined && info.size > resolved.maxSourceBytes) return { status: "skip", reason: "oversize" };
  const source = await readTextBounded(absolutePath, resolved.maxSourceBytes, fileSystem, signal);
  signal?.throwIfAborted();
  if (source === undefined) return { status: "skip", reason: "oversize" };
  const frontmatter = splitFrontmatter(source);
  let patterns;
  let body;
  let description;
  if (frontmatter === null) {
    patterns = [];
    body = source.trim();
    description = undefined;
  } else {
    body = frontmatter.body;
    description = typeof frontmatter.data.description === "string" ? frontmatter.data.description : undefined;
    let declared = frontmatter.data.paths;
    if (typeof declared === "string") declared = [declared];
    if (declared === undefined || declared === null) declared = [];
    if (!Array.isArray(declared)) return { status: "skip", reason: "bad-paths" };
    patterns = declared
      .filter((entry) => typeof entry === "string" && entry.trim().length > 0)
      .map((entry) => entry.trim());
  }
  if (body.length > 0 && byteLength(body) > resolved.maxSourceBytes) return { status: "skip", reason: "oversize" };
  return {
    status: "ok",
    statKey: statKeyOf(info),
    rule: {
      absolutePath,
      patterns,
      global: patterns.length === 0,
      description,
      body,
      digest: sha1(body),
    },
  };
}

/** Freshness key for the rule cache: provider version when available, else size + mtime. */
function statKeyOf(info) {
  if (info.version !== undefined) return `v:${String(info.version)}`;
  const mtime = typeof info.mtimeMs === "number" ? `:m:${info.mtimeMs}` : "";
  return `s:${info.size ?? ""}${mtime}`;
}

/** Process-wide stat-validated rule cache (bounded, avoids re-reading unchanged files). */
const ruleCache = new Map();

/** Walk upward from cwd to the first directory containing a root marker. */
async function findProjectRoot(cwd, markers, signal) {
  let current = resolve(cwd);
  for (;;) {
    signal?.throwIfAborted();
    for (const marker of markers) {
      const probe = await statProvider(join(current, marker), undefined, signal);
      if (probe !== undefined && (probe.type === "file" || probe.type === "directory")) return current;
    }
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}

function displayFor(dir, absolutePath, resolved, cwd) {
  const relativeToHome = relative(resolved.dshHome, absolutePath);
  if (relativeToHome !== "" && !relativeToHome.startsWith("..") && !isAbsolute(relativeToHome)) {
    return `${dshHomeDisplay(resolved.dshHome)}/${toPosix(relativeToHome)}`;
  }
  const relativeToCwd = relative(cwd, absolutePath);
  if (relativeToCwd !== "" && !relativeToCwd.startsWith("..") && !isAbsolute(relativeToCwd)) {
    return toPosix(relativeToCwd);
  }
  return toPosix(absolutePath);
}

async function loadAllRules(resolved, cwd, fileSystem, signal, warn) {
  const rulesDirs = [resolved.rulesDir];
  if (resolved.rulesDirProject) {
    const projectRoot = await findProjectRoot(cwd, resolved.projectRootMarkers, signal);
    // Project-scoped rules follow two conventions:
    //   <projectRoot>/.dsh/rules   (this plugin's own convention)
    //   <projectRoot>/.claude/rules (Claude Code convention)
    rulesDirs.push(join(projectRoot, ".dsh", "rules"));
    rulesDirs.push(join(projectRoot, ".claude", "rules"));
  }
  const rules = [];
  const seen = new Set();
  for (const dir of rulesDirs) {
    const entries = await listRulesDirProvider(dir, fileSystem, signal);
    if (entries === undefined) continue;
    const names = entries
      .filter((entry) => entry.type === "file" && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    for (const entryName of names) {
      signal?.throwIfAborted();
      const absolutePath = join(dir, entryName);
      if (seen.has(absolutePath)) continue;
      seen.add(absolutePath);
      const displayPath = displayFor(dir, absolutePath, resolved, cwd);
      const cached = ruleCache.get(absolutePath);
      if (cached !== undefined) {
        const probe = await statProvider(absolutePath, fileSystem, signal);
        signal?.throwIfAborted();
        if (probe !== undefined && probe.type === "file" && statKeyOf(probe) === cached.statKey) {
          rules.push({ ...cached.rule, displayPath, scope: displayPath });
          continue;
        }
        ruleCache.delete(absolutePath);
      }
      const loaded = await loadRuleFile(absolutePath, resolved, fileSystem, signal);
      signal?.throwIfAborted();
      if (loaded.status === "skip") {
        warn(`rules-paths: skipping ${displayPath}: ${loaded.reason}`);
        continue;
      }
      ruleCache.set(absolutePath, { statKey: loaded.statKey, rule: loaded.rule });
      if (ruleCache.size > 512) ruleCache.clear();
      rules.push({ ...loaded.rule, displayPath, scope: displayPath });
    }
  }
  return rules;
}

// ── glob matching (real picomatch) ──────────────────────────────────────────

const matcherCache = new Map();

function patternMatcher(pattern) {
  let matcher = matcherCache.get(pattern);
  if (matcher === undefined) {
    matcher = picomatch(pattern, { dot: true });
    matcherCache.set(pattern, matcher);
  }
  return matcher;
}

/** Match a rule's patterns against a touched file's absolute and cwd-relative paths. */
function ruleMatches(rule, absolutePath, cwd) {
  const absolute = toPosix(absolutePath);
  const relativePath = toPosix(relative(cwd, absolutePath));
  for (const pattern of rule.patterns) {
    const matcher = patternMatcher(pattern);
    if (matcher(absolute) || matcher(relativePath)) return true;
  }
  return false;
}

// ── rendering ───────────────────────────────────────────────────────────────

const SYSTEM_REMINDER_OPEN = "<system-reminder>";
const SYSTEM_REMINDER_CLOSE = "</system-reminder>";
const RULES_INTRO =
  "These rules apply to files matching the declared paths. Use them as guidance when relevant; more specific instructions take precedence. They do not override system, developer, or direct user instructions.";

function escapeFrame(text) {
  return text.replaceAll(SYSTEM_REMINDER_CLOSE, "<\\/system-reminder>");
}

function sectionText(rule, change) {
  if (change.action === "replace") {
    return [
      `Updated rules from: ${rule.displayPath}`,
      "",
      "This file changed after it was loaded. Use the following content instead of the previously loaded rules from this file.",
      "",
      rule.body,
    ].join("\n");
  }
  return [`Additional rules from: ${rule.displayPath}`, "", RULES_INTRO, "", rule.body].join("\n");
}

function markerText(maxBytes, omitted, truncated) {
  if (omitted.length === 0 && truncated.length === 0) return "";
  const parts = [];
  if (omitted.length > 0) parts.push(`omitted ${omitted.map((file) => file.displayPath).join(", ")}`);
  if (truncated.length > 0) {
    parts.push(`truncated ${truncated.map((item) => `${item.displayPath} from ${item.originalBytes} to ${item.includedBytes} bytes`).join(", ")}`);
  }
  return `Rules budget ${maxBytes} bytes: ${parts.join("; ")}`;
}

/**
 * Render an ordered list of `{ change, rule }` items into one bounded
 * system-reminder message. When the full text exceeds `maxBytes`, whole rules
 * are dropped first (from the front), then the last kept rule's body is
 * truncated, and a visible `Rules budget …` notice names every
 * omission/truncation. The rendered text never exceeds `maxBytes`.
 * `changes` lists only the transitions actually represented.
 */
function renderRulesContext(items, maxBytes) {
  const build = (included, omitted, truncated) => {
    const parts = [];
    const notice = markerText(maxBytes, omitted, truncated);
    if (notice !== "") parts.push(escapeFrame(notice));
    for (const item of included) parts.push(escapeFrame(sectionText(item.rule, item.change)));
    return [SYSTEM_REMINDER_OPEN, parts.join("\n\n"), SYSTEM_REMINDER_CLOSE].join("\n");
  };

  if (maxBytes <= 0 || !Number.isFinite(maxBytes)) {
    return { text: "", changes: [], omitted: [], truncated: [] };
  }
  const fullText = build(items, [], []);
  if (byteLength(fullText) <= maxBytes) {
    return { text: fullText, changes: items.map((item) => item.change), omitted: [], truncated: [] };
  }
  for (let start = 1; start < items.length; start += 1) {
    const included = items.slice(start);
    const omitted = items.slice(0, start).map((item) => ({ displayPath: item.rule.displayPath }));
    const text = build(included, omitted, []);
    if (byteLength(text) <= maxBytes) {
      return { text, changes: included.map((item) => item.change), omitted, truncated: [] };
    }
  }
  const mostSpecific = items.at(-1);
  const originalBytes = byteLength(mostSpecific.rule.body);
  const omitted = items.slice(0, -1).map((item) => ({ displayPath: item.rule.displayPath }));
  let low = 0;
  let high = originalBytes;
  let best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = { ...mostSpecific.rule, body: truncateUtf8(mostSpecific.rule.body, mid) };
    const truncated = [{ displayPath: mostSpecific.rule.displayPath, originalBytes, includedBytes: mid }];
    if (byteLength(build([{ change: mostSpecific.change, rule: candidate }], omitted, truncated)) <= maxBytes) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  const truncatedRule = { ...mostSpecific.rule, body: truncateUtf8(mostSpecific.rule.body, best) };
  const truncated = [{
    displayPath: mostSpecific.rule.displayPath,
    originalBytes,
    includedBytes: byteLength(truncatedRule.body),
  }];
  const text = build([{ change: mostSpecific.change, rule: truncatedRule }], omitted, truncated);
  if (byteLength(text) <= maxBytes) {
    return {
      text,
      changes: byteLength(truncatedRule.body) > 0 || originalBytes === 0 ? [mostSpecific.change] : [],
      omitted,
      truncated,
    };
  }
  const noticeOnly = escapeFrame(markerText(maxBytes, omitted, truncated));
  return {
    text: byteLength(noticeOnly) <= maxBytes ? noticeOnly : truncateUtf8(noticeOnly, maxBytes),
    changes: [],
    omitted,
    truncated,
  };
}

// ── message construction and visible state ──────────────────────────────────

function rulesContextMessage(text, changes) {
  return createUserMessage({
    content: [{ type: "text", text }],
    source: { kind: "rules-paths", form: "instructions", changes },
  });
}

function isRulesContext(message) {
  return message !== null && typeof message === "object" && message.source !== null
    && typeof message.source === "object" && message.source.kind === "rules-paths";
}

function rulesChangesOf(source) {
  if (source === null || typeof source !== "object") return [];
  if (source.kind !== "rules-paths" || !Array.isArray(source.changes)) return [];
  const changes = [];
  for (const value of source.changes) {
    if (value === null || typeof value !== "object") continue;
    if (value.action !== "set" && value.action !== "replace" && value.action !== "remove") continue;
    if (typeof value.scope !== "string" || typeof value.path !== "string") continue;
    if (value.digest !== undefined && typeof value.digest !== "string") continue;
    changes.push({
      action: value.action,
      scope: value.scope,
      path: value.path,
      ...(value.digest !== undefined ? { digest: value.digest } : {}),
    });
  }
  return changes;
}

/**
 * Rules already visible to the model: durable `user/message` events on the
 * session surface plus the current step's claimed messages. Keyed by rule
 * scope (the display path of the rule file).
 */
function visibleRuleChanges(agent, authorityMessages) {
  const visibleSeqs = new Set(agent.session.surface.nodes);
  const visible = new Map();
  for (const [seq, event] of agent.session.events.entries()) {
    if (event.type !== "user/message" || !isRulesContext(event.data)) continue;
    for (const change of rulesChangesOf(event.data.source)) {
      if (visibleSeqs.has(seq)) visible.set(change.scope, change);
    }
  }
  for (const message of authorityMessages) {
    if (!isRulesContext(message)) continue;
    for (const change of rulesChangesOf(message.source)) visible.set(change.scope, change);
  }
  return visible;
}

function sameContextPayload(left, right) {
  return isDeepStrictEqual(left.content, right.content) && isDeepStrictEqual(left.source, right.source);
}

// ── composition ─────────────────────────────────────────────────────────────

function resolveTouchedPath(touchedPath, cwd) {
  return isAbsolute(touchedPath) ? resolve(touchedPath) : resolve(cwd, touchedPath);
}

function changeFor(rule, previous) {
  if (previous !== undefined && previous.digest === rule.digest) return undefined;
  return {
    action: previous === undefined ? "set" : "replace",
    scope: rule.scope,
    path: rule.displayPath,
    digest: rule.digest,
  };
}

/**
 * Compose the desired rules-paths message for a successful read touch.
 * Visible (unchanged) rules are not re-injected; a changed rule becomes a
 * `replace` transition. Returns `undefined` when nothing new applies.
 */
async function compose(agent, signal, claimed, touchedPath, resolved, fileSystem, warn) {
  signal.throwIfAborted();
  if (resolved.maxBytes <= 0 || !Number.isFinite(resolved.maxBytes)) return undefined;
  const cwd = agent.session.header.cwd ?? process.cwd();
  const absolutePath = resolveTouchedPath(touchedPath, cwd);
  const rules = await loadAllRules(resolved, cwd, fileSystem, signal, warn);
  const visible = visibleRuleChanges(agent, claimed);
  const items = [];
  for (const rule of rules) {
    signal.throwIfAborted();
    if (!ruleMatches(rule, absolutePath, cwd)) continue;
    const change = changeFor(rule, visible.get(rule.scope));
    if (change === undefined) continue;
    items.push({ change, rule });
  }
  if (items.length === 0) return undefined;
  const rendered = renderRulesContext(items, resolved.maxBytes);
  if (rendered.text.length === 0 || rendered.changes.length === 0) return undefined;
  return rulesContextMessage(rendered.text, rendered.changes);
}

/**
 * Compose the GLOBAL-rules baseline: every rule without `paths` patterns.
 * Global rules apply to the whole session and are injected at the first
 * entering step (and again as `replace` when their content changes), without
 * waiting for any file read. Visible (unchanged) global rules are not
 * re-injected. Returns `undefined` when nothing new applies.
 */
async function composeGlobal(agent, signal, claimed, resolved, fileSystem, warn) {
  signal.throwIfAborted();
  if (resolved.maxBytes <= 0 || !Number.isFinite(resolved.maxBytes)) return undefined;
  const cwd = agent.session.header.cwd ?? process.cwd();
  const rules = await loadAllRules(resolved, cwd, fileSystem, signal, warn);
  const visible = visibleRuleChanges(agent, claimed);
  const items = [];
  for (const rule of rules) {
    signal.throwIfAborted();
    if (!rule.global) continue;
    const change = changeFor(rule, visible.get(rule.scope));
    if (change === undefined) continue;
    items.push({ change, rule });
  }
  if (items.length === 0) return undefined;
  const rendered = renderRulesContext(items, resolved.maxBytes);
  if (rendered.text.length === 0 || rendered.changes.length === 0) return undefined;
  return rulesContextMessage(rendered.text, rendered.changes);
}

/**
 * Insert `injections` into an entering pre-step decision right after the last
 * message that came from the claimed inbox batch. Returns the decision
 * unchanged when there is nothing to inject.
 */
function foldInjections(decision, claimedMessages, injections) {
  if (decision.kind === "reject" || injections.length === 0) return decision;
  const lastClaimedIndex = decision.messages.findLastIndex((message) => claimedMessages.includes(message));
  return {
    kind: "enter",
    messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, ...injections),
  };
}

/** Keep the `next-step` inbox to exactly the composed desired message. */
function syncInbox(agent, claimed, desired) {
  const pending = agent.inbox.nextStep.filter(isRulesContext);
  const alreadySupplied = desired !== undefined && (
    claimed.some((message) => sameContextPayload(message, desired))
    || agent.session.surface.nodes.some((seq) => {
      const event = agent.session.events[seq];
      return event !== undefined && event.type === "user/message" && sameContextPayload(event.data, desired);
    })
  );
  if (desired === undefined || alreadySupplied) {
    for (const message of pending) agent.inbox.remove(message.id);
    return;
  }
  const reusable = pending.find((message) => sameContextPayload(message, desired));
  if (reusable !== undefined) {
    for (const message of pending) {
      if (message !== reusable) agent.inbox.remove(message.id);
    }
    return;
  }
  const replaced = pending[0];
  if (replaced === undefined) agent.inbox.prepend("next-step", desired);
  else agent.inbox.replace(replaced.id, desired);
  for (const message of pending.slice(1)) agent.inbox.remove(message.id);
}

// ── plugin ──────────────────────────────────────────────────────────────────

function apply(ctx, config) {
  const resolved = resolveConfig(config);
  const triggerToolNames = new Set(resolved.triggerTools);
  const fileSystem = ctx.get("fs");
  const warn = (message) => {
    if (ctx.logger !== undefined) ctx.logger.warn(message);
  };
  const projectionLifecycle = new AbortController();
  const executionTouches = new Map();
  const projectionTails = new WeakMap();
  const openSteps = new WeakMap();
  const stepTouches = new WeakMap();

  ctx.effect(() => () => {
    projectionLifecycle.abort(new Error("rules-paths disposed"));
    executionTouches.clear();
  }, "rules-paths.projectionLifecycle");

  const composeAndSync = async (agent, signal, claimed, touchedPath) => {
    const desired = await compose(agent, signal, claimed, touchedPath, resolved, fileSystem, warn);
    signal.throwIfAborted();
    syncInbox(agent, claimed, desired);
  };

  const queueProjection = (agent, touchedPath) => {
    const current = (projectionTails.get(agent) ?? Promise.resolve())
      .then(() => composeAndSync(agent, projectionLifecycle.signal, [], touchedPath))
      .catch((error) => {
        if (!projectionLifecycle.signal.aborted) warn(`rules-paths projection failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    projectionTails.set(agent, current);
    current.then(() => {
      if (projectionTails.get(agent) === current) projectionTails.delete(agent);
    });
  };

  const waitForProjections = async (agent) => {
    let projection;
    while ((projection = projectionTails.get(agent)) !== undefined) await projection;
  };

  const stepIsOpen = (session) => {
    const known = openSteps.get(session);
    if (known !== undefined) return known;
    let open = false;
    for (const event of session.events) {
      if (event.type === "step/start") open = true;
      else if (event.type === "step/end" || event.type === "turn/end") open = false;
    }
    openSteps.set(session, open);
    return open;
  };

  const projectTouch = (touch) => {
    const session = touch.agent.session;
    if (!stepIsOpen(session)) {
      queueProjection(touch.agent, touch.path);
      return;
    }
    const pending = stepTouches.get(session);
    if (pending === undefined) stepTouches.set(session, [touch]);
    else pending.push(touch);
  };

  ctx.on("session/event", (session, event) => {
    if (event.type === "step/start") {
      openSteps.set(session, true);
      return;
    }
    if (event.type === "turn/end") {
      openSteps.set(session, false);
      return;
    }
    if (event.type !== "step/end") return;
    openSteps.set(session, false);
    const pending = stepTouches.get(session);
    if (pending === undefined) return;
    stepTouches.delete(session);
    for (const touch of pending) queueProjection(touch.agent, touch.path);
  });

  ctx.on("agent/pre-step", async ({ agent, messages, step, signal }, next) => {
    const decision = await next();
    await waitForProjections(agent);
    signal.throwIfAborted();
    const pending = agent.inbox.nextStep.filter(isRulesContext);
    const global = await composeGlobal(agent, signal, messages, resolved, fileSystem, warn);
    signal.throwIfAborted();
    if (decision.kind === "reject" || step === 1 && decision.messages.length === 0) return decision;
    const injections = [];
    for (const message of pending) {
      if (!decision.messages.some((existing) => sameContextPayload(existing, message))) injections.push(message);
    }
    if (global !== undefined && !decision.messages.some((existing) => sameContextPayload(existing, global))) injections.push(global);
    for (const message of pending) agent.inbox.remove(message.id);
    return foldInjections(decision, messages, injections);
  });

  ctx.on("tools/result", (exec, result) => {
    const touches = executionTouches.get(exec.token) ?? [];
    executionTouches.delete(exec.token);
    if (!result.isError && exec.agent !== undefined && !exec.signal.aborted) {
      const ownPath = filePathFromExecution(exec, triggerToolNames);
      if (ownPath !== undefined) {
        touches.push({ agent: exec.agent, path: ownPath });
      }
    }
    if (exec.parent !== undefined) {
      if (touches.length > 0) {
        const parentTouches = executionTouches.get(exec.parent);
        if (parentTouches === undefined) executionTouches.set(exec.parent, touches);
        else parentTouches.push(...touches);
      }
      return;
    }
    for (const touch of touches) projectTouch(touch);
  });
}

function filePathFromExecution(exec, triggerToolNames) {
  if (!triggerToolNames.has(exec.name)) return undefined;
  if (typeof exec.arguments !== "object" || exec.arguments === null) return undefined;
  if (!("file_path" in exec.arguments) || typeof exec.arguments.file_path !== "string") return undefined;
  const filePath = exec.arguments.file_path.trim();
  return filePath.length > 0 ? filePath : undefined;
}

export { Config, apply, name };
