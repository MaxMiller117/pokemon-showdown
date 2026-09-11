/**
 * In-process practice player that accepts challenges on this side server.
 *
 * Spawned as a connected User (RD2LPractice by default). Humans challenge it
 * on play.rd2lpl.com with a species list (this week's draft pool); it
 * auto-accepts, brings a legal team drawn only from that pool, and chooses
 * via stock RandomPlayerAI. No outbound connection to smogon main. No Discord.
 *
 * Species list hook (smallest fork-native):
 *   /practiceplayer pool Garchomp, Heatran, ...
 *   /practice gen9natdexdraft, Garchomp, Heatran, ...
 *   Config.practiceplayer.species = ['Garchomp', ...]
 *
 * Enable with Config.practiceplayer.enabled = true.
 */

import type { RoomBattle } from '../room-battle';
import {
	AI_NAME,
	assertAllowedBattleHost,
	chooseFromRequest,
	DEFAULT_BOT_NAME,
	DEFAULT_FORMAT,
	GENERATOR_NAME,
	isAllowedBattleHost,
	isSmogonMainHost,
	parsePracticeTarget,
	parseSpeciesList,
	PracticePlayerError,
	resolveChallengeFormat,
	teamFromSpeciesList,
} from '../../sim/practice-player';
import { ObjectReadWriteStream } from '../../lib/streams';

interface PracticePlayerConfig {
	enabled?: boolean;
	name?: string;
	format?: string;
	species?: string[] | string;
	mode?: 'pick' | 'fixed';
}

function pluginConfig(): PracticePlayerConfig {
	return (Config as AnyObject).practiceplayer || {};
}

export function botName(): string {
	return pluginConfig().name || DEFAULT_BOT_NAME;
}

export function botId(): ID {
	return toID(botName());
}

export function defaultFormat(): string {
	return pluginConfig().format || DEFAULT_FORMAT;
}

export function isPracticeBotUser(user: User | null | undefined): boolean {
	return !!user && user.id === botId();
}

function configSpecies(): string[] {
	return parseSpeciesList(pluginConfig().species);
}

function configMode(): 'pick' | 'fixed' {
	return pluginConfig().mode === 'fixed' ? 'fixed' : 'pick';
}

/** Per-challenger pool from `/practiceplayer pool` / `/practice`. */
const userPools = new Map<ID, string[]>();
/** Room-wide override (last `/practiceplayer pool` with no user scope needed). */
let globalPool: string[] | null = null;

export function setUserPool(userid: string, species: readonly string[]) {
	const list = parseSpeciesList(species as string[]);
	if (!list.length) {
		userPools.delete(toID(userid));
		return;
	}
	userPools.set(toID(userid), list);
}

export function getUserPool(userid: string): string[] | null {
	return userPools.get(toID(userid)) || null;
}

export function setGlobalPool(species: readonly string[] | null) {
	if (species == null) {
		globalPool = null;
		return;
	}
	const list = parseSpeciesList(species as string[]);
	globalPool = list.length ? list : null;
}

export function getGlobalPool(): string[] | null {
	return globalPool;
}

export function resetPools() {
	userPools.clear();
	globalPool = null;
}

/**
 * Challenger pool, then global `/practiceplayer pool`, then config species.
 */
export function resolveSpeciesList(challengerId?: string | null): string[] {
	if (challengerId) {
		const mine = getUserPool(challengerId);
		if (mine?.length) return mine;
	}
	if (globalPool?.length) return globalPool;
	return configSpecies();
}

let botUser: User | null = null;
const playing = new WeakSet<RoomBattle>();
export let lastAcceptError: string | null = null;

class NoopStream extends ObjectReadWriteStream<string> {
	override _write() {}
}

function dummyWorker() {
	return {
		id: 99,
		stream: new NoopStream(),
		process: { connected: true },
	};
}

export function getPracticeBot(): User | null {
	if (botUser?.connected) return botUser;
	const existing = Users.getExact(botId());
	if (existing?.connected) {
		botUser = existing;
		return existing;
	}
	return null;
}

/**
 * Create a connected in-process User so humans can /challenge it.
 * Uses a no-op socket worker — never talks to smogon or the public internet.
 */
export function spawnPracticeBot(name = botName()): User {
	const existing = getPracticeBot();
	if (existing) {
		existing.battleSettings.team = '';
		return existing;
	}

	const worker = dummyWorker();
	let socketid = 900000;
	while (Users.connections.has(`99-${socketid}`)) socketid++;
	const connectionid = `99-${socketid}`;
	const connection = new Users.Connection(
		connectionid, worker as any, String(socketid), null, '127.0.0.1', 'practice-player'
	);
	Users.connections.set(connectionid, connection);
	const user = new Users.User(connection);
	connection.user = user;
	user.forceRename(name, true);
	user.settings.blockChallenges = false;
	user.isPublicBot = true;
	user.battleSettings.team = '';
	botUser = user;
	return user;
}

export function destroyPracticeBot() {
	const user = botUser || Users.getExact(botId());
	botUser = null;
	if (!user) return;
	try {
		user.resetName();
		user.disconnectAll();
		user.destroy();
	} catch {}
}

async function acceptIncomingChallenge(challenger: User, bot: User, format: string | ID) {
	lastAcceptError = null;
	try {
		const chall = Ladders.challenges.search(challenger.id, bot.id);
		if (!chall || chall.to !== bot.id) {
			lastAcceptError = 'no pending challenge';
			return;
		}
		const conn = bot.connections[0];
		if (!conn) {
			lastAcceptError = 'bot has no connection';
			return;
		}

		let resolvedFormat: string;
		try {
			resolvedFormat = resolveChallengeFormat(String(format) || defaultFormat());
		} catch (err: any) {
			Ladders.challenges.remove(chall, false);
			lastAcceptError = err?.message || 'format not supported';
			challenger.popup(
				`Practice bot could not accept ${format}. ` +
				(err?.message || `Default format is ${DEFAULT_FORMAT}.`)
			);
			return;
		}

		const species = resolveSpeciesList(challenger.id);
		if (!species.length) {
			Ladders.challenges.remove(chall, false);
			lastAcceptError = 'no species list';
			challenger.popup(
				`Practice bot needs a species list (this week's draft pool). ` +
				`Use /practiceplayer pool Species1, Species2, ... then challenge, ` +
				`or /practice ${DEFAULT_FORMAT}, Species1, Species2, ...`
			);
			return;
		}

		let built;
		try {
			built = teamFromSpeciesList(species, resolvedFormat, { mode: configMode() });
		} catch (err: any) {
			Ladders.challenges.remove(chall, false);
			lastAcceptError = err?.message || 'list team failed';
			challenger.popup(
				`Practice bot could not build a legal team from the pool for ${resolvedFormat}. ` +
				`${err?.message || ''}`
			);
			return;
		}

		bot.battleSettings.team = built.bringTeam ? built.packed : '';
		const gameRoom = await Ladders.acceptChallenge(conn, chall as Ladders.BattleChallenge);
		if (gameRoom?.battle) {
			void playBattle(gameRoom.battle, bot);
		} else {
			lastAcceptError = 'acceptChallenge returned no room';
		}
	} catch (err: any) {
		lastAcceptError = err?.message || String(err);
		Monitor.crashlog(err, 'practice-player accept');
	}
}

export async function playBattle(battle: RoomBattle, bot: User) {
	if (playing.has(battle)) return;
	playing.add(battle);

	const seen = new Set<number>();
	while (!battle.ended) {
		const player = battle.playerTable[bot.id];
		if (player && player.request.isWait === false && player.request.request) {
			const rqid = player.request.rqid;
			if (!seen.has(rqid)) {
				seen.add(rqid);
				try {
					const request = JSON.parse(player.request.request);
					const choice = chooseFromRequest(request);
					if (choice) battle.choose(bot, `${choice}|${rqid}`);
				} catch (err: any) {
					Monitor.crashlog(err, 'practice-player choose');
					break;
				}
			}
		}
		await new Promise<void>(resolve => { setTimeout(resolve, 25); });
	}
}

export function start() {
	if (!pluginConfig().enabled) return;
	spawnPracticeBot();
}

export function destroy() {
	destroyPracticeBot();
	resetPools();
}

export const handlers: Chat.HandlerTable = {
	onChallenge(user, targetUser, format) {
		if (!isPracticeBotUser(targetUser)) return;
		return acceptIncomingChallenge(user, targetUser, format);
	},
	onBattleCreate(battle, players) {
		const bot = getPracticeBot();
		if (!bot) return;
		if (!players.includes(bot.id)) return;
		void playBattle(battle, bot);
	},
};

export const commands: Chat.ChatCommands = {
	practice(target, room, user) {
		if (!pluginConfig().enabled && !getPracticeBot()) {
			throw new Chat.ErrorMessage(`Practice bot is disabled. Set Config.practiceplayer.enabled = true and restart, or use /practiceplayer start.`);
		}
		if (!getPracticeBot()) spawnPracticeBot();
		const parsed = parsePracticeTarget(target, defaultFormat());
		if (parsed.species?.length) setUserPool(user.id, parsed.species);
		if (!resolveSpeciesList(user.id).length) {
			throw new Chat.ErrorMessage(
				`Set a species list first: /practiceplayer pool Species1, Species2, ... ` +
				`or /practice ${defaultFormat()}, Species1, Species2, ...`
			);
		}
		return this.parse(`/challenge ${botName()}, ${parsed.format}`);
	},
	practicehelp: [
		`/practice [format], [species, ...] - Challenge the practice bot with a species list. Default format: ${DEFAULT_FORMAT}.`,
	],

	practiceplayer: {
		''(target, room, user) {
			return this.parse(`/practiceplayer help`);
		},
		help() {
			this.sendReplyBox(
				`<strong>Practice player</strong> (${AI_NAME}, ${GENERATOR_NAME})<br />` +
				`Challenge <code>${Chat.escapeHTML(botName())}</code> on this server with a species list ` +
				`(this week's draft pool).<br />` +
				`<code>/practiceplayer pool Species1, Species2, ...</code> then challenge, or ` +
				`<code>/practice ${DEFAULT_FORMAT}, Species1, Species2, ...</code>.<br />` +
				`Default format: <code>${DEFAULT_FORMAT}</code> (RD2L NatDex Draft). ` +
				`Challenge format is honored when PS already supports it.<br />` +
				`Team: 6-from-N (<code>pick</code>) or <code>fixed</code> via Config.practiceplayer.mode. ` +
				`Generator: <code>${GENERATOR_NAME}</code>.<br />` +
				`Does not connect to the smogon main ladder. No Discord spawn. Public replays stay censored.`
			);
		},
		pool(target, room, user) {
			const trimmed = target.trim();
			if (!trimmed || trimmed === 'show') {
				const mine = getUserPool(user.id);
				const resolved = resolveSpeciesList(user.id);
				this.sendReply(
					`Your pool: ${mine?.join(', ') || '(none)'} | ` +
					`global: ${globalPool?.join(', ') || '(none)'} | ` +
					`config: ${configSpecies().join(', ') || '(none)'} | ` +
					`resolved: ${resolved.join(', ') || '(empty)'}`
				);
				return;
			}
			if (toID(trimmed) === 'clear') {
				setUserPool(user.id, []);
				this.sendReply(`Cleared your practice species pool.`);
				return;
			}
			if (toID(trimmed) === 'clearglobal') {
				this.checkCan('lockdown');
				setGlobalPool(null);
				this.sendReply(`Cleared the global practice species pool.`);
				return;
			}
			const species = parseSpeciesList(trimmed);
			if (!species.length) {
				throw new Chat.ErrorMessage(`Usage: /practiceplayer pool Species1, Species2, ...`);
			}
			setUserPool(user.id, species);
			setGlobalPool(species);
			this.sendReply(
				`Practice pool set (${species.length}): ${species.join(', ')}. ` +
				`Challenge ${botName()} in ${defaultFormat()} (or another PS format).`
			);
		},
		start() {
			this.checkCan('lockdown');
			const user = spawnPracticeBot();
			this.sendReply(`Practice bot online as ${user.name}.`);
		},
		stop() {
			this.checkCan('lockdown');
			destroyPracticeBot();
			this.sendReply(`Practice bot stopped.`);
		},
		status() {
			const bot = getPracticeBot();
			const resolved = resolveSpeciesList();
			this.sendReply(
				`practiceplayer: ${bot ? `online as ${bot.name}` : 'offline'} | ` +
				`enabled=${!!pluginConfig().enabled} | format=${defaultFormat()} | ` +
				`mode=${configMode()} | pool=${resolved.length} | ` +
				`ai=${AI_NAME} | generator=${GENERATOR_NAME}`
			);
		},
	},
	practiceplayerhelp: [
		`/practiceplayer help - How to challenge the practice bot.`,
		`/practiceplayer pool [species, ...] - Set this week's draft pool (fork-native hook).`,
		`/practiceplayer start - Admin: spawn the in-process bot user.`,
		`/practiceplayer stop - Admin: destroy the bot user.`,
	],
};

export const practicePlayerInternals = {
	assertAllowedBattleHost,
	isAllowedBattleHost,
	isSmogonMainHost,
	AI_NAME,
	GENERATOR_NAME,
	DEFAULT_FORMAT,
	PracticePlayerError,
};
