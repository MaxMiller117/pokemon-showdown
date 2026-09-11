'use strict';

const assert = require('../assert');
const common = require('../common');
const {
	AI_NAME,
	ALLOWED_BATTLE_HOSTS,
	assertAllowedBattleHost,
	chooseFromRequest,
	DEFAULT_FORMAT,
	GENERATOR_NAME,
	isAllowedBattleHost,
	isSmogonMainHost,
	PracticePlayerError,
	runLocalGame,
	stubTeam,
} = require('../../dist/sim/practice-player');
const { Teams } = require('../../dist/sim/teams');

describe('practice player (stock AI)', () => {
	it('refuses smogon main ladder hosts', () => {
		assert(isSmogonMainHost('sim3.psim.us'));
		assert(isSmogonMainHost('https://play.pokemonshowdown.com/'));
		assert(isSmogonMainHost('sim.psim.us:8000'));
		assert(isSmogonMainHost('replay.pokemonshowdown.com'));
		assert.throws(
			() => assertAllowedBattleHost('sim3.psim.us'),
			PracticePlayerError
		);
		assert.throws(
			() => assertAllowedBattleHost('play.pokemonshowdown.com'),
			PracticePlayerError
		);
	});

	it('allowlists only the side server and localhost', () => {
		assert(isAllowedBattleHost('play.rd2lpl.com'));
		assert(isAllowedBattleHost('https://play.rd2lpl.com:443/'));
		assert(isAllowedBattleHost('127.0.0.1'));
		assert(isAllowedBattleHost('localhost'));
		assert(!isAllowedBattleHost('example.com'));
		assert(!ALLOWED_BATTLE_HOSTS.includes('sim3.psim.us'));
		assertAllowedBattleHost('play.rd2lpl.com');
	});

	it('stubs a validator-legal random team (Teams.generate)', () => {
		const result = stubTeam(DEFAULT_FORMAT, '1,2,3,4');
		assert.equal(result.generator, GENERATOR_NAME);
		assert.equal(result.format, DEFAULT_FORMAT);
		assert.equal(result.team.length, 6);
		assert(result.packed.includes('|'));
		assert.equal(result.packed, Teams.pack(result.team));
		assert.equal(result.bringTeam, false); // randombattle generates; /utm null
		assert(result.team.every(set => set.moves && set.moves.length >= 1));
	});

	it('RandomPlayerAI emits a legal-looking choice for a move request', () => {
		const battle = common.createBattle([
			[{ species: 'Magikarp', ability: 'swiftswim', moves: ['splash', 'tackle'] }],
			[{ species: 'Magikarp', ability: 'swiftswim', moves: ['splash', 'tackle'] }],
		]);
		const request = battle.p1.activeRequest;
		assert(request);
		const choice = chooseFromRequest(request, '5,6,7,8');
		assert(choice, 'expected a choice string');
		assert(/^(move |switch |default)/.test(choice), `unexpected choice: ${choice}`);
		battle.destroy();
	});

	it('completes a local game with legal RandomPlayerAI moves', function () {
		this.timeout(20000);
		const battle = common.createBattle({ strictChoices: true }, [
			[{ species: 'Magikarp', ability: 'swiftswim', moves: ['tackle'] }],
			[{ species: 'Magikarp', ability: 'swiftswim', moves: ['tackle'] }],
		]);
		let steps = 0;
		while (!battle.ended && steps < 50) {
			const c1 = chooseFromRequest(battle.p1.activeRequest, `1,2,3,${steps}`);
			const c2 = chooseFromRequest(battle.p2.activeRequest, `4,5,6,${steps}`);
			assert(c1 && c2, `missing choice at step ${steps}: ${c1} / ${c2}`);
			battle.makeChoices(c1, c2);
			steps++;
		}
		assert(battle.ended, `battle did not end after ${steps} choices`);
		assert(battle.winner, 'expected a winner');
		assert.equal(AI_NAME, 'ps-RandomPlayerAI');
		battle.destroy();
	});

	it('runLocalGame finishes a BattleStream random battle', async function () {
		this.timeout(60000);
		const result = await runLocalGame({
			format: DEFAULT_FORMAT,
			seed: '9,9,9,9',
			maxTurns: 200,
		});
		assert(result.winner);
		assert.atLeast(result.turns, 1);
		assert.equal(result.format, DEFAULT_FORMAT);
		assert.equal(result.ai, AI_NAME);
		assert.equal(result.generator, GENERATOR_NAME);
		assert(result.log.includes('|win|'));
		assert(!result.log.toLowerCase().includes('sim3.psim.us'));
	});
});
