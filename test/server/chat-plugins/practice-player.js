'use strict';

const assert = require('../../assert');
const { makeUser, destroyUser } = require('../../users-utils');

describe('practice player plugin', () => {
	let plugin;

	before(() => {
		plugin = require('../../../dist/server/chat-plugins/practice-player');
		Chat.loadPlugins();
	});

	afterEach(() => {
		plugin.destroyPracticeBot();
	});

	it('does not spawn unless Config.practiceplayer.enabled', () => {
		assert.equal(plugin.getPracticeBot(), null);
		plugin.start();
		assert.equal(plugin.getPracticeBot(), null);
	});

	it('spawns a connected in-process user that can be challenged', () => {
		const bot = plugin.spawnPracticeBot('RD2LPractice');
		assert.equal(bot.name, 'RD2LPractice');
		assert.equal(bot.id, 'rd2lpractice');
		assert(bot.connected);
		assert.equal(Users.getExact('rd2lpractice'), bot);
		assert(plugin.isPracticeBotUser(bot));
		assert.equal(bot.battleSettings.team, '');
		assert.equal(bot.settings.blockChallenges, false);
	});

	it('onChallenge ignores challenges that are not to the bot', () => {
		const a = makeUser('Alice', '127.0.0.10');
		const b = makeUser('Bob', '127.0.0.11');
		assert.doesNotThrow(() => plugin.handlers.onChallenge(a, b, 'gen9randombattle'));
		destroyUser(a);
		destroyUser(b);
	});

	it('auto-accepts a challenge from a human and starts a battle', async function () {
		this.timeout(30000);
		const bot = plugin.spawnPracticeBot('RD2LPractice');
		const human = makeUser('ScrimHuman', '127.0.0.12');
		human.battleSettings.team = '';

		const challenged = await Ladders('gen9randombattle').makeChallenge(human.connections[0], bot);
		assert(challenged);

		// Live plugin handler accepts via Chat.runHandlers('onChallenge').
		let battleRoom = null;
		const deadline = Date.now() + 10000;
		while (Date.now() < deadline) {
			for (const room of Rooms.rooms.values()) {
				if (room.battle && room.battle.playerTable[human.id] && room.battle.playerTable[bot.id]) {
					battleRoom = room;
					break;
				}
			}
			if (battleRoom) break;
			await new Promise(r => { setTimeout(r, 50); });
		}
		assert(battleRoom, `expected a battle room after auto-accept (${plugin.lastAcceptError})`);
		assert.equal(battleRoom.battle.challengeType, 'challenge');

		const deadline2 = Date.now() + 8000;
		while (Date.now() < deadline2) {
			const player = battleRoom.battle.playerTable[bot.id];
			if (player?.request?.choice) break;
			if (battleRoom.battle.ended) break;
			await new Promise(r => { setTimeout(r, 50); });
		}
		const botPlayer = battleRoom.battle.playerTable[bot.id];
		assert(botPlayer.request.request, 'bot should have a choice request');
		if (!battleRoom.battle.ended) {
			assert(
				botPlayer.request.choice || botPlayer.request.isWait !== false,
				'bot should have submitted a choice or be waiting'
			);
		}

		if (!battleRoom.battle.ended) battleRoom.battle.tie();
		destroyUser(human);
	});

	it('exports smogon-block helpers (no main-ladder path)', () => {
		assert(plugin.practicePlayerInternals.isSmogonMainHost('sim3.psim.us'));
		assert(!plugin.practicePlayerInternals.isAllowedBattleHost('play.pokemonshowdown.com'));
		assert(plugin.practicePlayerInternals.isAllowedBattleHost('play.rd2lpl.com'));
		assert.equal(plugin.practicePlayerInternals.AI_NAME, 'ps-RandomPlayerAI');
	});
});
