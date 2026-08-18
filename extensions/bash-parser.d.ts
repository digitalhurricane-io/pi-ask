// Minimal type declarations for bash-parser (a CommonJS package with no
// bundled types). We only use the Script AST + per-node loc char offsets.
declare module "bash-parser" {
	export interface LocPoint {
		char: number; // absolute character offset into the parsed source
		col: number;
		row: number;
	}
	export interface Loc {
		start: LocPoint;
		end: LocPoint;
	}
	export interface BashNode {
		type: string;
		loc?: Loc;
		commands?: BashNode[];
		list?: BashNode;
		clause?: BashNode;
		then?: BashNode;
		do?: BashNode;
		elseBranch?: BashNode;
		left?: BashNode;
		right?: BashNode;
	}
	export interface Script {
		type: "Script";
		commands: BashNode[];
		loc?: Loc;
	}
	function parse(source: string, options?: Record<string, unknown>): Script;
	export default parse;
}
