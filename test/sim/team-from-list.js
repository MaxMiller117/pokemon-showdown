'use strict';

const assert = require('../assert');
const {
	buildTeamFromList,
	TeamFromListError,
	DEFAULT_FORMAT,
	GENERATOR_NAME,
} = require('../../dist/sim/team-from-list');
const { Teams } = require('../../dist/sim/teams');
const { TeamValidator } = require('../../dist/sim/team-validator');
const { toID } = require('../../dist/sim/dex');

const POOL8 = [
	'Garchomp', 'Heatran', 'Toxapex', 'Landorus-Therian',
	'Clefable', 'Kingambit', 'Great Tusk', 'Dragonite',
];
const SEED = '1,2,3,4';

function speciesIds(team) {
	return team.map(set => toID(set.species));
}

describe('species-list team builder', () => {
	it('picks 6 legal Pokemon from N>=6 and only those species', () => {
		const result = buildTeamFromList(POOL8, undefined, { seed: SEED });
		assert.equal(result.team.length, 6);
		const poolIds = new Set(POOL8.map(toID));
		for (const set of result.team) {
			assert(poolIds.has(toID(set.species)), `${set.species} not in pool`);
			assert(set.moves && set.moves.length >= 1, `${set.species} missing moves`);
		}
		assert.equal(new Set(speciesIds(result.team)).size, 6);
		assert(result.packed.includes('|'));
		assert.equal(result.packed, Teams.pack(result.team));
		const problems = new TeamValidator(result.format).validateTeam(result.team);
		assert.equal(problems, null, problems && problems.join('; '));
	});

	it('uses the whole list when N<=6 / fixed mode', () => {
		const list = POOL8.slice(0, 4);
		const result = buildTeamFromList(list, undefined, { mode: 'fixed', seed: SEED });
		assert.equal(result.team.length, 4);
		assert.deepEqual(speciesIds(result.team), list.map(toID));
		const problems = new TeamValidator(result.format).validateTeam(result.team);
		assert.equal(problems, null, problems && problems.join('; '));
	});

	it('defaults format to gen9natdexdraft when omitted', () => {
		const result = buildTeamFromList(POOL8.slice(0, 6), undefined, { seed: SEED });
		assert.equal(DEFAULT_FORMAT, 'gen9natdexdraft');
		assert.equal(result.format, DEFAULT_FORMAT);
	});

	it('honors an explicit format id', () => {
		const result = buildTeamFromList(POOL8.slice(0, 6), 'gen9ou', { seed: SEED });
		assert.equal(result.format, 'gen9ou');
		const problems = new TeamValidator('gen9ou').validateTeam(result.team);
		assert.equal(problems, null, problems && problems.join('; '));
	});

	it('throws on unknown species in fixed mode', () => {
		assert.throws(
			() => buildTeamFromList(['Garchomp', 'NotARealMon'], undefined, { mode: 'fixed' }),
			TeamFromListError
		);
	});

	it('skips unknown species in pick mode when enough legal remain', () => {
		const result = buildTeamFromList(
			[...POOL8, 'NotARealMon', 'AlsoFake'],
			undefined,
			{ seed: SEED }
		);
		assert.equal(result.team.length, 6);
		assert(!speciesIds(result.team).includes('notarealmon'));
	});

	it('skips format-illegal species in pick mode', () => {
		const result = buildTeamFromList(
			['Koraidon', ...POOL8],
			'gen9ou',
			{ seed: SEED }
		);
		assert.equal(result.team.length, 6);
		assert(!speciesIds(result.team).includes('koraidon'));
		const problems = new TeamValidator('gen9ou').validateTeam(result.team);
		assert.equal(problems, null, problems && problems.join('; '));
	});

	it('throws in fixed mode when a species is illegal in the format', () => {
		assert.throws(
			() => buildTeamFromList(['Koraidon', 'Garchomp'], 'gen9ou', { mode: 'fixed', seed: SEED }),
			TeamFromListError
		);
	});

	it('throws when the pool is empty or all unknown', () => {
		assert.throws(() => buildTeamFromList([]), TeamFromListError);
		assert.throws(() => buildTeamFromList(['NotARealMon', 'AlsoFake']), TeamFromListError);
	});

	it('documents the in-tree PS TeamGenerator / randomSet generator', () => {
		const result = buildTeamFromList(POOL8.slice(0, 6), undefined, { seed: SEED });
		assert.equal(result.generator, GENERATOR_NAME);
		assert(
			/TeamGenerator|randomSet/i.test(GENERATOR_NAME),
			`GENERATOR_NAME should name TeamGenerator/randomSet, got ${GENERATOR_NAME}`
		);
	});
});
