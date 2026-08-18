/**
 * Ask Permission
 *
 * Prompts for confirmation before pi runs certain bash commands, such as
 * `git` and `rm`. Acts as a safety net so an agent doesn't run a command
 * you weren't expecting.
 *
 * Behavior:
 *   - Every bash tool call is checked against the config.
 *   - If it should be confirmed, a dialog is shown (ctx.ui.confirm).
 *   - Confirming lets the command run; declining blocks it.
 *   - If there is no UI (headless/automation), it fails closed by default.
 *
 * Configuration (optional JSON; path printed by the /ask-permission command):
 *   {
 *     "confirmCommands": ["git *", "rm"],         // entries may use * globs
 *     "patterns":        ["\\brm\\s+(-[a-z]*[rf])"],  // regex => confirm if matched
 *     "skipPatterns":    ["git\\s+(status|diff|log)\\b"], // matched => never confirm
 *     "blockWhenNoUI":   true                      // false => allow silently when no UI
 *   }
 *
 * The config file is read once at startup (and by /ask-permission). Use
 * /reload inside pi to pick up edits without restarting.
 */

import { appendFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import bashParse from "bash-parser";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "ask-permission.json");

// Diagnostic logger: records every decision this plugin makes, so you can
// audit what/when it prompted and why. Each line gets a timestamp (ISO + local)
// and, when available, the session id.
const LOG_PATH = join(homedir(), ".pi", "agent", "ask-permission.log");
function diag(line: string, sessionId?: string) {
	try {
		const now = new Date();
		const stamp = `${now.toISOString()} ${now.toLocaleString()}`;
		const sid = sessionId ? ` session=${sessionId}` : "";
		appendFileSync(LOG_PATH, `[${stamp}]${sid} ${line}\n`);
	} catch {
		/* ignore */
	}
}

// Safely pull the current session id from any context that has one.
function sessionIdOf(ctx: {
	sessionManager?: { getSessionId?: () => string | undefined };
}): string | undefined {
	try {
		return ctx.sessionManager?.getSessionId?.() ?? undefined;
	} catch {
		return undefined;
	}
}

interface Config {
	confirmCommands: string[];
	patterns: string[];
	skipPatterns: string[];
	blockWhenNoUI: boolean;
}

const DEFAULTS: Config = {
	confirmCommands: ["git", "rm", "sudo"],
	patterns: [
		String.raw`\brm\s+(-[a-z]*[rf])`,
		String.raw`\b(chmod|chown)\b.*\b777\b`,
	],
	// Read-only / probing git commands are safe and frequent — don't nag on these.
	skipPatterns: [
		String.raw`\bgit\s+(status|diff|log|show|ls-files|branch|remote -v|rev-parse|describe)\b`,
	],
	blockWhenNoUI: true,
};

function loadConfig(): Config {
	try {
		const raw = readFileSync(CONFIG_PATH, "utf8");
		const parsed = JSON.parse(raw) as Partial<Config>;
		return {
			...DEFAULTS,
			...parsed,
			confirmCommands: parsed.confirmCommands ?? DEFAULTS.confirmCommands,
			patterns: parsed.patterns ?? DEFAULTS.patterns,
			skipPatterns: parsed.skipPatterns ?? DEFAULTS.skipPatterns,
			blockWhenNoUI: parsed.blockWhenNoUI ?? DEFAULTS.blockWhenNoUI,
		};
	} catch {
		return DEFAULTS;
	}
}

// Loaded once at startup; /reload (or /ask-permission) refreshes it.
let config: Config = loadConfig();

// Turn a glob (with `*` wildcards) into a regex matched against the start of the
// command. A trailing `*` also matches the bare prefix (so `git *` matches `git`
// alone, not just `git <subcommand>`). Plain entries with no `*` fall back to
// exact leading-word matching.
function globToRegExp(glob: string): RegExp {
	let pattern = glob.trim();
	let optionalTail = false;
	if (pattern.endsWith("*")) {
		optionalTail = true;
		pattern = pattern.slice(0, -1).trimEnd();
	}
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
	const re = "\\s*" + escaped + (optionalTail ? ".*" : "");
	return new RegExp("^" + re, "i");
}

// Split a compound shell command into its logical commands so we can match
// against each one. Git/rm are almost always invoked with a prefix like
// `cd <dir> && git push`, so matching only the whole-command first word would
// miss them. Separators: `&&`, `||`, `;`, `|`, and newlines.
// A single logical command within a (possibly compound) bash command, e.g.
// `git push` inside `cd /x && git push`. `start`/`end` are absolute char
// offsets into the original command (from bash-parser's loc); -1 means the
// range is unknown (regex fallback was used, so highlighting rejoins segments).
interface ParsedCommand {
	text: string;
	start: number;
	end: number;
	risky: boolean;
}

function matchesConfirm(command: string, entry: string): boolean {
	if (entry.includes("*")) {
		// e.g. "git *" matches any command starting with "git "; "rm *" likewise.
		return globToRegExp(entry).test(command);
	}
	// Exact leading-word match: "git" matches "git status", "git push", etc.
	const firstWord = command.split(/\s+/)[0]?.toLowerCase() ?? "";
	return firstWord === entry.toLowerCase();
}

// Decide whether a single logical command should be confirmed: skip-patterns
// win, then confirmCommands, then the risky-pattern regexes.
function isRiskyCommand(text: string, cfg: Config): boolean {
	if (cfg.skipPatterns.some((p) => new RegExp(p, "i").test(text))) return false;
	if (cfg.confirmCommands.some((c) => matchesConfirm(text, c))) return true;
	return cfg.patterns.some((p) => new RegExp(p, "i").test(text));
}

// Quote-unaware splitter, used ONLY if bash-parser can't parse the command.
// It wrongly splits on `&&` inside quotes — the parser path avoids this.
function fallbackSegments(command: string): string[] {
	return command
		.split(/\s*(?:&&|;|\|){1,2}\s*|\n/)
		.map((s) => s.trim().replace(/^[({]|[)}]$/g, ""))
		.filter((s) => s.length > 0);
}

// Recursively collect every leaf Command node from the bash-parser AST,
// descending through LogicalExpressions, Pipelines, Lists, Subshells, and
// compound commands (if/while/for/function bodies).
function collectLeafCommands(node: any, out: { type: string; loc?: any }[]) {
	if (!node) return;
	if (node.type === "Command") {
		out.push(node);
		return;
	}
	for (const key of ["commands", "list", "clause", "then", "do", "elseBranch", "left", "right"]) {
		const val = node[key];
		if (Array.isArray(val)) {
			for (const child of val) collectLeafCommands(child, out);
		} else if (val && typeof val === "object") {
			collectLeafCommands(val, out);
		}
	}
}

// Parse a command into its logical commands, each flagged risky or safe.
// Uses bash-parser (full shell grammar, quote-aware) so `&&` inside a quoted
// string isn't treated as a command separator. Falls back to naive splitting
// if parsing fails, so prompt behavior never regresses.
function parseCommands(command: string, cfg: Config): ParsedCommand[] {
	const leaf: { type: string; loc?: { start: { char: number }; end: { char: number } } }[] = [];
	try {
		const ast = bashParse(command, { insertLOC: true });
		if (ast) collectLeafCommands(ast, leaf);
	} catch {
		// parse threw (e.g. unbalanced) — fall through to naive fallback
	}
	if (leaf.length === 0 || leaf.some((n) => !n.loc)) {
		return fallbackSegments(command).map((text) => ({
			text,
			start: -1,
			end: -1,
			risky: isRiskyCommand(text, cfg),
		}));
	}
	return leaf
		.map((n) => ({
			// loc.end.char is the index of the LAST character (inclusive), so +1.
			text: command.slice(n.loc!.start.char, n.loc!.end.char + 1),
			start: n.loc!.start.char,
			end: n.loc!.end.char,
		}))
		.filter((r) => r.text.trim().length > 0)
		.sort((a, b) => a.start - b.start)
		.map((r) => ({ ...r, risky: isRiskyCommand(r.text, cfg) }));
}

function wantsConfirmation(command: string, cfg: Config): boolean {
	// Any parsed logical command is risky → prompt.
	if (parseCommands(command, cfg).some((c) => c.risky)) return true;
	// Safety net: conservatively flag risky patterns or confirmed first-words
	// anywhere in the raw command, even if the parser didn't surface them (e.g.
	// an exotic nested structure). Never suppressed by per-command skip rules.
	if (cfg.confirmCommands.some((c) => matchesConfirm(command.trim(), c))) return true;
	return cfg.patterns.some((p) => new RegExp(p, "i").test(command));
}

// Rebuild the command for display in the confirm dialog. The dialog renders
// title+message as accent+bold, and `fg()` resets only the foreground, so after
// a red (risky) run the next text would fall back to terminal default. To keep
// highlighting correct, we walk the original string using bash-parser's char
// ranges: risky commands red, everything else (safe commands, separators,
// whitespace) blue. Falls back to joined segments if ranges are unavailable.
function renderCommandForPrompt(
	command: string,
	cfg: Config,
	safeColor: (s: string) => string,
	riskyColor: (s: string) => string,
): string {
	const commands = parseCommands(command, cfg);
	const positioned = commands.length > 0 && commands.every((c) => c.start >= 0);
	if (!positioned) {
		return commands
			.map((c) => (c.risky ? riskyColor(c.text) : safeColor(c.text)))
			.join(safeColor(" && "));
	}
	let out = "";
	let cursor = 0;
	for (const c of commands) {
		if (c.start > cursor) out += safeColor(command.slice(cursor, c.start));
		out += c.risky ? riskyColor(c.text) : safeColor(c.text);
		cursor = c.end + 1;
	}
	if (cursor < command.length) out += safeColor(command.slice(cursor));
	return out;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
		const sid = sessionIdOf(ctx);
		diag(`tool_call fired: tool=${event.toolName} id=${event.toolCallId}`, sid);
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command as string;
		const shouldAsk = wantsConfirmation(command, config);
		diag(`bash cmd=${JSON.stringify(command)} shouldAsk=${shouldAsk} hasUI=${ctx.hasUI}`, sid);
		if (!shouldAsk) return undefined;

		if (!ctx.hasUI) {
			// Fail closed: without a UI there's no way to ask, so block.
			if (config.blockWhenNoUI) {
				diag("no UI -> BLOCKED (fail closed)", sid);
				return {
					block: true,
					reason: "No UI to confirm command: " + command,
				};
			}
			diag("no UI -> allowed silently (blockWhenNoUI=false)", sid);
			return undefined; // blockWhenNoUI === false => allow silently
		}

		diag("UI present -> showing confirm dialog", sid);
		// Style helpers — only embed color in the TUI; RPC/JSON bodies stay plain.
		const themeColor =
			(kind: "accent" | "error") =>
			(s: string): string => {
				try {
					return ctx.mode === "tui" ? ctx.ui.theme.fg(kind, s) : s;
				} catch {
					return s;
				}
			};
		const blue = themeColor("accent");
		const red = themeColor("error");
		const title = red("Run this command?");
		const body =
			blue("Pi wants to run:\n\n") +
			renderCommandForPrompt(command, config, blue, red) +
			blue("\n\nAllow it?");
		const ok = await ctx.ui.confirm(title, body);
		diag(`confirm returned ok=${ok}`, sid);

		if (!ok) {
			diag("declined -> BLOCKED", sid);
			return { block: true, reason: "Command declined by user" };
		}

		diag("allowed", sid);
		return undefined;
	});

	// Status / help command.
	pi.registerCommand("ask-permission", {
		description: "Show ask-permission status and config location",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			config = loadConfig();
			const lines = [
				"Ask Permission",
				`Config file: ${CONFIG_PATH}`,
				`Commands always confirmed: ${config.confirmCommands.join(", ") || "(none)"}`,
				`Risk patterns: ${config.patterns.join(" ; ") || "(none)"}`,
				`Skip patterns: ${config.skipPatterns.join(" ; ") || "(none)"}`,
				`Block when no UI: ${config.blockWhenNoUI}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
