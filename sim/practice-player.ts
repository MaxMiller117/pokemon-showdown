/**
 * RD2L practice player (stock PS AI + list teams).
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * In-process practice opponent: build a legal team from a species list
 * (this week's draft pool) and pick moves with RandomPlayerAI. Never opens
 * a socket to smogon main.
 *
 * @license MIT
 */

import { ObjectReadWriteStream } from '../lib/streams';
import { BattleStream, getPlayerStreams } from './battle-stream';
import { Dex } from './dex';
import { PRNG, type PRNGSeed } from './prng';
import type { ChoiceRequest } from './side';
import { RandomPlayerAI } from './tools/random-player-ai';
import {
	buildTeamFromList,
	DEFAULT_FORMAT as LIST_DEFAULT_FORMAT,
	GENERATOR_NAME as LIST_GENERATOR_NAME,
	type BuildTeamFromListOptions,
	type BuiltTeam,
	type TeamPickMode,
} from './team-from-list';

/** Current RD2L draft format. Override on the challenge when PS knows it. */
export const DEFAULT_FORMAT = LIST_DEFAULT_FORMAT;
export const DEFAULT_BOT_NAME = 'RD2LPractice';
export const GENERATOR_NAME = LIST_GENERATOR_NAME;
export const AI_NAME = 'ps-RandomPlayerAI';

/** Offline CLI / tests: a legal 8-mon NatDex Draft-ish pool. */
export const DEMO_SPECIES_POOL = [
	'Garchomp', 'Heatran', 'Toxapex', 'Landorus-Therian',
	'Clefable', 'Kingambit', 'Great Tusk', 'Dragonite',
];

/** Hosts this player may ever talk to. Side server + local sim only. */
export const ALLOWED_BATTLE_HOSTS = [
	'play.rd2lpl.com',
	'localhost',
	'127.0.0.1',
	'::1',
];

const SMOGON_HOST_BLOCKLIST = [
	'sim.psim.us',
	'sim3.psim.us',
	'sim2.psim.us',
	'play.pokemonshowdown.com',
	'pokemonshowdown.com',
	'smogon.com',
];

export class PracticePlayerError extends Error {
	override name = 'PracticePlayerError';
}

function hostnameOf(raw: string): string {
	let host = String(raw || '').trim().toLowerCase();
	host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
	host = host.split('/')[0];
	host = host.split(']')[0].replace('[', '');
	if (host.includes(':') && !host.startsWith(':')) {
		// hostname:port (not ipv6)
		if ((host.match(/:/g) || []).length === 1) host = host.split(':')[0];
	}
	return host;
}

export function isSmogonMainHost(raw: string): boolean {
	const host = hostnameOf(raw);
	return SMOGON_HOST_BLOCKLIST.some(b => host === b || host.endsWith(`.${b}`));
}

export function isAllowedBattleHost(raw: string): boolean {
	const host = hostnameOf(raw);
	if (!host) return false;
	if (isSmogonMainHost(host)) return false;
	return ALLOWED_BATTLE_HOSTS.some(a => host === a || host.endsWith(`.${a}`));
}

/** Throws if the host is smogon main or otherwise not allowlisted. */
export function assertAllowedBattleHost(raw: string): void {
	if (isSmogonMainHost(raw)) {
		throw new PracticePlayerError(
			`practice player refuses smogon/main ladder host: ${raw}`
		);
	}
	if (!isAllowedBattleHost(raw)) {
		throw new PracticePlayerError(`practice player host not allowlisted: ${raw}`);
	}
}

class CaptureStream extends ObjectReadWriteStream<string> {
	last = '';
	override _write(elem: string) {
		this.last = elem;
	}
}

/**
 * One legal choice string from a PS `|request|` JSON blob, using stock
 * RandomPlayerAI (random move / switch / `default` team preview).
 */
export function chooseFromRequest(
	request: ChoiceRequest | { wait?: boolean, [k: string]: any },
	seed?: PRNG | PRNGSeed | null
): string {
	if (!request || (request as ChoiceRequest).wait) return '';
	const stream = new CaptureStream();
	const ai = new RandomPlayerAI(stream, { seed: seed ?? null, move: 1.0 });
	ai.receiveRequest(request as ChoiceRequest);
	return stream.last;
}

/** Split a fork-native species list (comma / newline / `|`). */
export function parseSpeciesList(raw: string | readonly string[] | null | undefined): string[] {
	if (raw == null) return [];
	if (Array.isArray(raw)) {
		return raw.map(s => String(s || '').trim()).filter(Boolean);
	}
	return String(raw)
		.split(/[\n,|]/)
		.map(s => s.trim())
		.filter(Boolean);
}

export interface PracticeTarget {
	/** Format id to challenge in. */
	format: string;
	/** Species to store as the challenger's pool; null = keep existing pool. */
	species: string[] | null;
	/** True when the user named a format PS already knows. */
	formatOverride: boolean;
}

/**
 * Parse `/practice` args: optional format, optional species list.
 *
 *  - `` → default format, keep pool
 *  - `gen9ou` → that format (if PS knows it), keep pool
 *  - `Garchomp, Heatran, ...` → default format, set pool
 *  - `gen9ou, Garchomp, Heatran, ...` → that format + set pool
 */
export function parsePracticeTarget(target: string, fallbackFormat: string = DEFAULT_FORMAT): PracticeTarget {
	const parts = parseSpeciesList(target);
	if (!parts.length) {
		return { format: fallbackFormat, species: null, formatOverride: false };
	}
	const first = Dex.formats.get(parts[0]);
	if (first.exists) {
		return {
			format: first.id,
			species: parts.length > 1 ? parts.slice(1) : null,
			formatOverride: true,
		};
	}
	return { format: fallbackFormat, species: parts, formatOverride: false };
}

/**
 * Honor the challenge format when PS already has it and it is bring-your-own-team.
 * Unknown formats throw; random-team formats throw (list teams cannot be `/utm`'d).
 */
export function resolveChallengeFormat(requested?: string | null): string {
	if (requested == null || String(requested).trim() === '') return DEFAULT_FORMAT;
	const format = Dex.formats.get(requested);
	if (!format.exists) {
		throw new PracticePlayerError(
			`unknown format ${requested}; practice bot default is ${DEFAULT_FORMAT}`
		);
	}
	if (format.team) {
		throw new PracticePlayerError(
			`${format.id} generates random teams; list-based practice needs a ` +
			`bring-your-own-team format such as ${DEFAULT_FORMAT}`
		);
	}
	return format.id;
}

export interface ListTeamResult extends BuiltTeam {
	/** False for random-team formats: the sim generates; `/utm` must be empty. */
	bringTeam: boolean;
	mode: TeamPickMode;
}

/**
 * Build a legal packed team drawn only from `species`, for `/utm`.
 * Default format is gen9natdexdraft; 6-from-N (`pick`) unless `mode: 'fixed'`.
 */
export function teamFromSpeciesList(
	species: readonly string[],
	format?: string | null,
	options: BuildTeamFromListOptions = {}
): ListTeamResult {
	const resolved = resolveChallengeFormat(format);
	const mode: TeamPickMode = options.mode === 'fixed' ? 'fixed' : 'pick';
	const built = buildTeamFromList(species, resolved, { ...options, mode });
	return {
		...built,
		bringTeam: true,
		mode,
	};
}

export function packedTeamFromSpeciesList(
	species: readonly string[],
	format?: string | null,
	options: BuildTeamFromListOptions = {}
): string {
	return teamFromSpeciesList(species, format, options).packed;
}

export interface LocalGameResult {
	winner: string;
	turns: number;
	format: string;
	log: string;
	p1Choices: number;
	p2Choices: number;
	generator: typeof GENERATOR_NAME;
	ai: typeof AI_NAME;
	picked: string[];
}

/**
 * Offline BattleStream game: RandomPlayerAI vs RandomPlayerAI with list teams.
 * Used to verify legal moves without connecting to play.rd2lpl.com.
 */
export async function runLocalGame(options: {
	format?: string,
	species?: readonly string[],
	seed?: PRNGSeed | null,
	p1Name?: string,
	p2Name?: string,
	maxTurns?: number,
	mode?: TeamPickMode,
} = {}): Promise<LocalGameResult> {
	const format = resolveChallengeFormat(options.format || DEFAULT_FORMAT);
	const species = options.species?.length ? options.species : DEMO_SPECIES_POOL;
	const seed = options.seed || '1,2,3,4';
	const prng = PRNG.get(seed);
	const maxTurns = options.maxTurns ?? 300;
	const mode = options.mode === 'fixed' ? 'fixed' : 'pick';

	const p1Team = teamFromSpeciesList(species, format, { seed: prng.getSeed(), mode });
	const p2Team = teamFromSpeciesList(species, format, { seed: prng.getSeed(), mode });

	const streams = getPlayerStreams(new BattleStream());
	const p1 = new RandomPlayerAI(streams.p1, { seed: prng.getSeed(), move: 1.0 });
	const p2 = new RandomPlayerAI(streams.p2, { seed: prng.getSeed(), move: 1.0 });

	void p1.start();
	void p2.start();

	const spec = { formatid: p1Team.format, seed: prng.getSeed() };
	const p1spec = { name: options.p1Name || 'Practice', team: p1Team.packed };
	const p2spec = { name: options.p2Name || 'Human', team: p2Team.packed };

	void streams.omniscient.write(
		`>start ${JSON.stringify(spec)}\n` +
		`>player p1 ${JSON.stringify(p1spec)}\n` +
		`>player p2 ${JSON.stringify(p2spec)}`
	);

	const chunks: string[] = [];
	let winner = '';
	let turns = 0;
	for await (const chunk of streams.omniscient) {
		chunks.push(chunk);
		for (const line of chunk.split('\n')) {
			if (line.startsWith('|turn|')) turns = Number(line.slice(6)) || turns;
			if (line.startsWith('|win|')) winner = line.slice(5);
		}
		if (winner || turns >= maxTurns) break;
	}
	void streams.omniscient.writeEnd();

	if (!winner) {
		throw new PracticePlayerError(
			`local practice game did not finish (turns=${turns}, format=${p1Team.format})`
		);
	}

	return {
		winner,
		turns,
		format: p1Team.format,
		log: chunks.join('\n'),
		p1Choices: p1.log.length,
		p2Choices: p2.log.length,
		generator: GENERATOR_NAME,
		ai: AI_NAME,
		picked: p1Team.picked,
	};
}

async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
	if (argv.includes('--help') || argv.includes('-h')) {
		console.log(`Usage: node dist/sim/practice-player.js [--format FORMAT] [--species LIST] [--connect HOST]

  (default)  Run a local BattleStream game with RandomPlayerAI + list team.
  --species  Comma-separated pool (default: demo 8-mon NatDex pool).
  --format   Defaults to ${DEFAULT_FORMAT}. Honored when PS already has it.
  --connect  Refused unless HOST is play.rd2lpl.com / localhost.
             Live challenges are served by the in-process server plugin,
             not an outbound smogon client.

Never connects to sim*.psim.us / play.pokemonshowdown.com.`);
		return;
	}

	const connectIdx = argv.indexOf('--connect');
	if (connectIdx >= 0) {
		const host = argv[connectIdx + 1] || '';
		assertAllowedBattleHost(host || 'missing-host');
		console.log(
			`Host ${host} is allowlisted. Do not use an outbound client; ` +
			`enable Config.practiceplayer and challenge ${DEFAULT_BOT_NAME} on the side server.`
		);
		return;
	}

	let format = DEFAULT_FORMAT;
	const formatIdx = argv.indexOf('--format');
	if (formatIdx >= 0 && argv[formatIdx + 1]) format = argv[formatIdx + 1];

	let species: string[] | undefined;
	const speciesIdx = argv.indexOf('--species');
	if (speciesIdx >= 0 && argv[speciesIdx + 1]) species = parseSpeciesList(argv[speciesIdx + 1]);

	const result = await runLocalGame({ format, species });
	console.log(JSON.stringify({
		winner: result.winner,
		turns: result.turns,
		format: result.format,
		generator: result.generator,
		ai: result.ai,
		picked: result.picked,
		smogon: false,
	}, null, 2));
}

const invoked = process.argv[1] && /practice-player(?:\.js)?$/.test(
	process.argv[1].replace(/\\/g, '/')
);
if (invoked) {
	void main().catch(err => {
		console.error(err);
		process.exit(1);
	});
}
