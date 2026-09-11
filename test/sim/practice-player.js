'use strict';

const assert = require('../assert');
const common = require('../common');
const { toID } = require('../../dist/sim/dex');
const { Teams } = require('../../dist/sim/teams');
const { TeamValidator } = require('../../dist/sim/team-validator');
const {
	AI_NAME,
	ALLOWED_BATTLE_HOSTS,
	assertAllowedBattleHost,
	chooseFromRequest,
	DEFAULT_FORMAT,
	DEMO_SPECIES_POOL,
	GENERATOR_NAME,
	isAllowedBattleHost,
	isSmogonMainHost,
	parsePracticeTarget,
	parseSpeciesList,
	PracticePlayerError,
	resolveChallengeFormat,
	runLocalGame,
	teamFromSpeciesList,
} = require('../../dist/sim/practice-player');

const POOL8 = DEMO_SPECIES_POOL;
const SEED = '1,2,3,4';

function speciesIds(team) {
	return team.map(set => toID(set.species));
}

describe('practice player (list teams + stock AI)', () => {
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

	it('defaults format to gen9natdexdraft', () => {
		assert.equal(DEFAULT_FORMAT, 'gen9natdexdraft');
		assert.equal(resolveChallengeFormat(''), DEFAULT_FORMAT);
		assert.equal(resolveChallengeFormat(null), DEFAULT_FORMAT);
	});

	it('honors a challenge format PS already supports', () => {
		assert.equal(resolveChallengeFormat('gen9ou'), 'gen9ou');
		assert.equal(resolveChallengeFormat('[Gen 9] NatDex Draft'), 'gen9natdexdraft');
	});

	it('rejects unknown formats and random-team formats', () => {
		assert.throws(() => resolveChallengeFormat('notarealformat'), PracticePlayerError);
		assert.throws(() => resolveChallengeFormat('gen9randombattle'), PracticePlayerError);
	});

	it('builds a legal team drawn only from the species pool', () => {
		const result = teamFromSpeciesList(POOL8, undefined, { seed: SEED });
		assert.equal(result.generator, GENERATOR_NAME);
		assert.equal(result.format, DEFAULT_FORMAT);
		assert.equal(result.team.length, 6);
		assert.equal(result.bringTeam, true);
		assert.equal(result.mode, 'pick');
		assert(result.packed.includes('|'));
		assert.equal(result.packed, Teams.pack(result.team));
		const poolIds = new Set(POOL8.map(toID));
		for (const set of result.team) {
			assert(poolIds.has(toID(set.species)), `${set.species} not in pool`);
			assert(set.moves && set.moves.length >= 1, `${set.species} missing moves`);
		}
		assert.equal(new Set(speciesIds(result.team)).size, 6);
		const problems = new TeamValidator(result.format).validateTeam(result.team);
		assert.equal(problems, null, problems && problems.join('; '));
	});

	it('honors an explicit BYOT format for the list team', () => {
		const result = teamFromSpeciesList(POOL8.slice(0, 6), 'gen9ou', { seed: SEED, mode: 'fixed' });
		assert.equal(result.format, 'gen9ou');
		assert.equal(result.mode, 'fixed');
		const problems = new TeamValidator('gen9ou').validateTeam(result.team);
		assert.equal(problems, null, problems && problems.join('; '));
	});

	it('parses fork-native species lists and /practice args', () => {
		assert.deepEqual(parseSpeciesList('Garchomp, Heatran | Toxapex\nClefable'), [
			'Garchomp', 'Heatran', 'Toxapex', 'Clefable',
		]);
		assert.deepEqual(parsePracticeTarget(''), {
			format: DEFAULT_FORMAT, species: null, formatOverride: false,
		});
		assert.deepEqual(parsePracticeTarget('gen9ou'), {
			format: 'gen9ou', species: null, formatOverride: true,
		});
		const listed = parsePracticeTarget('Garchomp, Heatran, Toxapex');
		assert.equal(listed.format, DEFAULT_FORMAT);
		assert.deepEqual(listed.species, ['Garchomp', 'Heatran', 'Toxapex']);
		assert.equal(listed.formatOverride, false);
		const both = parsePracticeTarget('gen9ou, Garchomp, Heatran');
		assert.equal(both.format, 'gen9ou');
		assert.deepEqual(both.species, ['Garchomp', 'Heatran']);
		assert.equal(both.formatOverride, true);
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

	it('runLocalGame finishes a BattleStream list-team draft game', async function () {
		this.timeout(60000);
		const result = await runLocalGame({
			format: DEFAULT_FORMAT,
			species: POOL8,
			seed: '9,9,9,9',
			maxTurns: 200,
		});
		assert(result.winner);
		assert.atLeast(result.turns, 1);
		assert.equal(result.format, DEFAULT_FORMAT);
		assert.equal(result.ai, AI_NAME);
		assert.equal(result.generator, GENERATOR_NAME);
		assert.equal(result.picked.length, 6);
		const poolIds = new Set(POOL8.map(toID));
		for (const name of result.picked) {
			assert(poolIds.has(toID(name)), `${name} not in pool`);
		}
		assert(result.log.includes('|win|'));
		assert(!result.log.toLowerCase().includes('sim3.psim.us'));
		assert(!result.log.toLowerCase().includes('discord'));
	});
});
