'use strict';

const assert = require('../../assert');
const { makeUser, destroyUser } = require('../../users-utils');
const { toID } = require('../../../dist/sim/dex');
const {
	DEFAULT_FORMAT,
	DEMO_SPECIES_POOL,
	teamFromSpeciesList,
} = require('../../../dist/sim/practice-player');

describe('practice player plugin', () => {
	let plugin;

	before(() => {
		plugin = require('../../../dist/server/chat-plugins/practice-player');
		Chat.loadPlugins();
	});

	afterEach(() => {
		plugin.destroyPracticeBot();
		plugin.resetPools();
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

	it('resolves species list from user pool then global then config', () => {
		assert.deepEqual(plugin.resolveSpeciesList(), []);
		plugin.setGlobalPool(DEMO_SPECIES_POOL.slice(0, 3));
		assert.deepEqual(plugin.resolveSpeciesList(), DEMO_SPECIES_POOL.slice(0, 3));
		plugin.setUserPool('alice', ['Garchomp', 'Heatran']);
		assert.deepEqual(plugin.resolveSpeciesList('alice'), ['Garchomp', 'Heatran']);
		assert.deepEqual(plugin.resolveSpeciesList('bob'), DEMO_SPECIES_POOL.slice(0, 3));
	});

	it('onChallenge ignores challenges that are not to the bot', () => {
		const a = makeUser('Alice', '127.0.0.10');
		const b = makeUser('Bob', '127.0.0.11');
		assert.doesNotThrow(() => plugin.handlers.onChallenge(a, b, 'gen9natdexdraft'));
		destroyUser(a);
		destroyUser(b);
	});

	it('rejects a challenge when no species list is set', async function () {
		this.timeout(15000);
		const bot = plugin.spawnPracticeBot('RD2LPractice');
		const human = makeUser('ScrimHuman', '127.0.0.12');
		const packed = teamFromSpeciesList(DEMO_SPECIES_POOL.slice(0, 6), DEFAULT_FORMAT, { mode: 'fixed' }).packed;
		human.battleSettings.team = packed;

		const challenged = await Ladders(DEFAULT_FORMAT).makeChallenge(human.connections[0], bot);
		assert(challenged);
		const deadline = Date.now() + 4000;
		while (Date.now() < deadline && !plugin.lastAcceptError) {
			await new Promise(r => { setTimeout(r, 50); });
		}
		assert.equal(plugin.lastAcceptError, 'no species list');
		destroyUser(human);
	});

	it('auto-accepts a list-team challenge and starts a battle', async function () {
		this.timeout(30000);
		const bot = plugin.spawnPracticeBot('RD2LPractice');
		const human = makeUser('ScrimHuman', '127.0.0.13');
		plugin.setUserPool(human.id, DEMO_SPECIES_POOL);
		const packed = teamFromSpeciesList(DEMO_SPECIES_POOL, DEFAULT_FORMAT, { seed: '1,2,3,4', mode: 'fixed' }).packed;
		human.battleSettings.team = packed;

		const challenged = await Ladders(DEFAULT_FORMAT).makeChallenge(human.connections[0], bot);
		assert(challenged);

		let battleRoom = null;
		const deadline = Date.now() + 15000;
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
		assert.equal(toID(battleRoom.battle.format), DEFAULT_FORMAT);

		const botPacked = bot.battleSettings.team;
		assert(botPacked && botPacked.includes('|'), 'bot should bring a packed list team');
		const poolIds = new Set(DEMO_SPECIES_POOL.map(toID));
		for (const chunk of botPacked.split(']')) {
			const species = chunk.split('|')[1] || chunk.split('|')[0];
			if (!species) continue;
			assert(poolIds.has(toID(species)), `bot species ${species} not in pool`);
		}

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
		assert.equal(plugin.practicePlayerInternals.DEFAULT_FORMAT, 'gen9natdexdraft');
		assert(/TeamGenerator|randomSet/i.test(plugin.practicePlayerInternals.GENERATOR_NAME));
	});
});
