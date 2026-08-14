/**
 * Type declarations for `dsh-rules-paths`.
 *
 * The package root exports only the Cordis plugin contract (`name`, `Config`,
 * and `apply`), mirroring the official `@deepseek-ai/dsh-agent-instructions`
 * layout. Runtime types (`Agent`, `Session`, `ToolExecution`) come from the
 * peer packages; this plugin consumes them structurally.
 */

import type { Context } from "@deepseek-ai/cordis";

export interface RulesPathsConfig {
  /** User-level rules directory; `~` expands. Default `~/.dsh/rules`. */
  rulesDir?: string;
  /** Byte budget for one injected message. Default 65536. */
  maxBytes?: number;
  /** Max bytes read from one rule file (larger files are skipped). Default 1048576. */
  maxSourceBytes?: number;
  /** Tool names whose successful executions trigger path matching. Default `["read"]`. */
  triggerTools?: string[];
  /** Also scan `<projectRoot>/.dsh/rules` and `<projectRoot>/.claude/rules`. Default false. */
  rulesDirProject?: boolean;
}

export const name: string;

export const Config: import("@deepseek-ai/schemastery").Schema<RulesPathsConfig>;

export function apply(ctx: Context, config: RulesPathsConfig): void;
