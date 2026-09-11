/**
 * In-process practice player that accepts challenges on this side server.
 *
 * Spawned as a connected User (RD2LPractice by default). Humans challenge it
 * on play.rd2lpl.com; it auto-accepts, brings a stub random/legal team, and
 * chooses via stock RandomPlayerAI. No outbound connection to smogon main.
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
	stubTeam,
} from '../../sim/practice-player';
import { ObjectReadWriteStream } from '../../lib/streams';

interface PracticePlayerConfig {
	enabled?: boolean;
	name?: string;
	format?: string;
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
		const stub = stubTeam(defaultFormat());
		existing.battleSettings.team = stub.bringTeam ? stub.packed : '';
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
	const stub = stubTeam(defaultFormat());
	user.battleSettings.team = stub.bringTeam ? stub.packed : '';
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

		let stub;
		try {
			stub = stubTeam(String(format) || defaultFormat());
		} catch (err: any) {
			Ladders.challenges.remove(chall, false);
			lastAcceptError = err?.message || 'stub team failed';
			challenger.popup(
				`Practice bot v1 could not build a legal team for ${format}. ` +
				`Challenge ${bot.name} in a random-team format such as ${DEFAULT_FORMAT}.`
			);
			return;
		}
		if (toID(stub.format) !== toID(String(format))) {
			Ladders.challenges.remove(chall, false);
			lastAcceptError = `format mismatch stub=${stub.format} challenged=${format}`;
			challenger.popup(
				`Practice bot v1 only auto-plays formats with a random team generator ` +
				`(e.g. ${DEFAULT_FORMAT}). You challenged ${format}.`
			);
			return;
		}

		bot.battleSettings.team = stub.bringTeam ? stub.packed : '';
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
		const format = Dex.toID(target) || defaultFormat();
		return this.parse(`/challenge ${botName()}, ${format}`);
	},
	practicehelp: [
		`/practice [format] - Challenge the in-process practice bot (stock RandomPlayerAI). Default format: ${DEFAULT_FORMAT}.`,
	],

	practiceplayer: {
		''(target, room, user) {
			return this.parse(`/practiceplayer help`);
		},
		help() {
			this.sendReplyBox(
				`<strong>Practice player</strong> (${AI_NAME}, ${GENERATOR_NAME})<br />` +
				`Challenge <code>${Chat.escapeHTML(botName())}</code> on this server, or <code>/practice [format]</code>.<br />` +
				`v1 team: random/legal stub via <code>Teams.generate</code> (default <code>${DEFAULT_FORMAT}</code>).<br />` +
				`Does not connect to the smogon main ladder. Public replays stay censored.`
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
			this.sendReply(
				`practiceplayer: ${bot ? `online as ${bot.name}` : 'offline'} | ` +
				`enabled=${!!pluginConfig().enabled} | format=${defaultFormat()} | ` +
				`ai=${AI_NAME} | generator=${GENERATOR_NAME}`
			);
		},
	},
	practiceplayerhelp: [
		`/practiceplayer help - How to challenge the practice bot.`,
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
};
