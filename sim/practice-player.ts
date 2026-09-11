/**
 * RD2L practice player (stock PS AI).
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * In-process practice opponent: stub a legal random-format team and pick
 * moves with RandomPlayerAI. Never opens a socket to smogon main.
 *
 * @license MIT
 */

import { ObjectReadWriteStream } from '../lib/streams';
import { BattleStream, getPlayerStreams } from './battle-stream';
import { Dex, toID } from './dex';
import { PRNG, type PRNGSeed } from './prng';
import type { ChoiceRequest } from './side';
import { Teams, type PokemonSet } from './teams';
import { TeamValidator } from './team-validator';
import { RandomPlayerAI } from './tools/random-player-ai';

export const DEFAULT_FORMAT = 'gen9randombattle';
export const DEFAULT_BOT_NAME = 'RD2LPractice';
export const GENERATOR_NAME = 'ps-Teams.generate-randomSet';
export const AI_NAME = 'ps-RandomPlayerAI';

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

export interface StubTeamResult {
	team: PokemonSet[];
	packed: string;
	format: string;
	generator: typeof GENERATOR_NAME;
	/** False for random-team formats: the sim generates; `/utm` must be empty. */
	bringTeam: boolean;
}

function formatHasRandomTeam(format: string): boolean {
	return !!Dex.formats.get(format).team;
}

/**
 * Stub team until the species-list builder is wired. Uses in-tree
 * `Teams.generate` (PS TeamGenerator / randomSet). Random-team formats
 * (gen9randombattle) do not let you bring a packed team — `bringTeam` is
 * false and the battle generates. Falls back to gen9randombattle when the
 * challenge format cannot generate a legal team.
 */
export function stubTeam(format: string = DEFAULT_FORMAT, seed?: PRNG | PRNGSeed | null): StubTeamResult {
	const wanted = format || DEFAULT_FORMAT;
	const tried = [wanted];
	if (toID(wanted) !== toID(DEFAULT_FORMAT)) tried.push(DEFAULT_FORMAT);

	let lastErr: unknown;
	const prng = seed != null ? PRNG.get(seed) : null;
	for (const fmt of tried) {
		try {
			const team = Teams.generate(fmt, prng ? { seed: prng.getSeed() } : null);
			if (!team?.length) continue;
			const bringTeam = !formatHasRandomTeam(fmt);
			if (bringTeam) {
				const problems = new TeamValidator(fmt).validateTeam(team);
				if (problems) {
					lastErr = problems.join('; ');
					continue;
				}
			}
			return {
				team,
				packed: Teams.pack(team),
				format: Dex.formats.get(fmt).id || fmt,
				generator: GENERATOR_NAME,
				bringTeam,
			};
		} catch (err) {
			lastErr = err;
		}
	}
	throw new PracticePlayerError(
		`could not stub a legal team for ${wanted}: ${lastErr}`
	);
}

export function stubPackedTeam(format: string = DEFAULT_FORMAT, seed?: PRNG | PRNGSeed | null): string {
	return stubTeam(format, seed).packed;
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
}

/**
 * Offline BattleStream game: RandomPlayerAI vs RandomPlayerAI with stub teams.
 * Used to verify legal moves without connecting to play.rd2lpl.com.
 */
export async function runLocalGame(options: {
	format?: string,
	seed?: PRNGSeed | null,
	p1Name?: string,
	p2Name?: string,
	maxTurns?: number,
} = {}): Promise<LocalGameResult> {
	const format = options.format || DEFAULT_FORMAT;
	const seed = options.seed || '1,2,3,4';
	const prng = PRNG.get(seed);
	const maxTurns = options.maxTurns ?? 300;

	const p1Team = stubTeam(format, prng);
	const p2Team = stubTeam(format, prng);

	const streams = getPlayerStreams(new BattleStream());
	const p1 = new RandomPlayerAI(streams.p1, { seed: prng.getSeed(), move: 1.0 });
	const p2 = new RandomPlayerAI(streams.p2, { seed: prng.getSeed(), move: 1.0 });

	void p1.start();
	void p2.start();

	const spec = { formatid: p1Team.format, seed: prng.getSeed() };
	const p1spec = p1Team.bringTeam ?
		{ name: options.p1Name || 'Practice', team: p1Team.packed } :
		{ name: options.p1Name || 'Practice', seed: prng.getSeed() };
	const p2spec = p2Team.bringTeam ?
		{ name: options.p2Name || 'Human', team: p2Team.packed } :
		{ name: options.p2Name || 'Human', seed: prng.getSeed() };

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
	};
}

async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
	if (argv.includes('--help') || argv.includes('-h')) {
		console.log(`Usage: node dist/sim/practice-player.js [--format FORMAT] [--connect HOST]

  (default)  Run a local BattleStream game with RandomPlayerAI.
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

	const result = await runLocalGame({ format });
	console.log(JSON.stringify({
		winner: result.winner,
		turns: result.turns,
		format: result.format,
		generator: result.generator,
		ai: result.ai,
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
