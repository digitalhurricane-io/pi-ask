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

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "ask-permission.json");

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

function matchesConfirm(command: string, entry: string): boolean {
	if (entry.includes("*")) {
		// e.g. "git *" matches any command starting with "git "; "rm *" likewise.
		return globToRegExp(entry).test(command);
	}
	// Exact leading-word match: "git" matches "git status", "git push", etc.
	const firstWord = command.split(/\s+/)[0]?.toLowerCase() ?? "";
	return firstWord === entry.toLowerCase();
}

function wantsConfirmation(command: string, cfg: Config): boolean {
	const normalized = command.trim();

	// Skip patterns win — these never trigger a prompt.
	if (cfg.skipPatterns.some((p) => new RegExp(p, "i").test(normalized))) {
		return false;
	}

	// Confirm if any confirmCommands entry matches.
	if (cfg.confirmCommands.some((c) => matchesConfirm(normalized, c))) {
		return true;
	}

	// Confirm when any risky regex matches anywhere in the command.
	return cfg.patterns.some((p) => new RegExp(p, "i").test(normalized));
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command as string;
		if (!wantsConfirmation(command, config)) return undefined;

		if (!ctx.hasUI) {
			// Fail closed: without a UI there's no way to ask, so block.
			if (config.blockWhenNoUI) {
				return {
					block: true,
					reason: "No UI to confirm command: " + command,
				};
			}
			return undefined; // blockWhenNoUI === false => allow silently
		}

		const ok = await ctx.ui.confirm(
			"Run this command?",
			`Pi wants to run:\n\n${command}\n\nAllow it?`,
		);

		if (!ok) {
			return { block: true, reason: "Command declined by user" };
		}

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
