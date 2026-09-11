/**
 * Species-list team builder
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Given a list of species and an optional format, produce a legal packed/JSON
 * team that uses only those species.
 *
 * Generator: `ps-TeamGenerator-randomSet` — the in-tree PS TeamGenerator
 * (`Teams.getGenerator` → `data/random-battles/<mod>/teams`.randomSet).
 *
 * Why this generator:
 * - Already vendored in this fork; no network, no Smogon analysis scrape,
 *   no `@pkmn/randoms` dependency.
 * - randomSet emits stock competitive-ish sets (moves/item/ability/EVs)
 *   for any species that has a Random Battle file.
 * - Species without a Random Battle file fall back to a learnset stock set,
 *   then both paths are checked with TeamValidator for the target format.
 *
 * Default format: gen9natdexdraft ([Gen 9] NatDex Draft), the current RD2L
 * draft format. Override by passing a format id/name.
 *
 * v1 knobs: mode `'pick'` (6-from-N, default) vs `'fixed'` (use the list in
 * order, capped at `size`). Unknown / format-illegal species are skipped in
 * pick mode and rejected in fixed mode.
 *
 * Export: `buildTeamFromList(species[], format?)` → `{ team, packed, format }`.
 *
 * @license MIT
 */
import { Dex, toID } from './dex';
import { PRNG, type PRNGSeed } from './prng';
import { Teams, type PokemonSet } from './teams';
import { TeamValidator } from './team-validator';

/** Current RD2L draft format. */
export const DEFAULT_FORMAT = 'gen9natdexdraft';
export const DEFAULT_TEAM_SIZE = 6;
export const GENERATOR_NAME = 'ps-TeamGenerator-randomSet';

export class TeamFromListError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'TeamFromListError';
	}
}

export type TeamPickMode = 'pick' | 'fixed';

export interface BuildTeamFromListOptions {
	/** `'pick'` = sample up to `size` (6-from-N). `'fixed'` = list order, capped at `size`. */
	mode?: TeamPickMode;
	size?: number;
	seed?: PRNGSeed | PRNG | null;
}

export interface BuiltTeam {
	team: PokemonSet[];
	packed: string;
	format: string;
	generator: string;
	picked: string[];
}

interface RandomSetSource {
	prng: PRNG;
	randomSet: (
		s: string,
		teamDetails?: object,
		isLead?: boolean,
		isDoubles?: boolean
	) => Partial<PokemonSet> & { species: string, moves: string[], gender?: string | boolean };
	randomSets?: { [id: string]: { sets?: unknown[] } };
	randomDoublesSets?: { [id: string]: { sets?: unknown[] } };
}

const STAT_ZERO: PokemonSet['evs'] = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
const STAT_MAX_IV: PokemonSet['ivs'] = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };

function uniqueSpecies(speciesList: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of speciesList) {
		const name = String(raw || '').trim();
		if (!name) continue;
		const id = toID(name);
		if (!id || seen.has(id)) continue;
		seen.add(id);
		out.push(name);
	}
	return out;
}

function toPokemonSet(raw: RandomSetSource['randomSet'] extends (...args: any) => infer R ? R : never): PokemonSet {
	return {
		name: raw.name || raw.species,
		species: raw.species,
		item: raw.item || '',
		ability: raw.ability || '',
		moves: Array.isArray(raw.moves) ? raw.moves.slice() : [],
		nature: raw.nature || '',
		gender: typeof raw.gender === 'string' ? raw.gender : '',
		evs: { ...STAT_ZERO, ...(raw.evs || {}) },
		ivs: { ...STAT_MAX_IV, ...(raw.ivs || {}) },
		level: raw.level || 100,
		shiny: !!raw.shiny,
		teraType: raw.teraType,
	};
}

function learnsetStockSet(speciesName: string, dex: ReturnType<typeof Dex.forFormat>): PokemonSet | null {
	const species = dex.species.get(speciesName);
	if (!species.exists) return null;
	const learnset = dex.species.getLearnsetData(species.id).learnset || {};
	const moves: string[] = [];
	for (const moveid of Object.keys(learnset)) {
		const move = dex.moves.get(moveid);
		if (!move.exists || move.isMax || move.isZ || move.isNonstandard === 'Future') continue;
		moves.push(move.name);
		if (moves.length >= 4) break;
	}
	if (!moves.length) return null;
	const ability = species.abilities[0] || '';
	return {
		name: species.baseSpecies,
		species: species.name,
		item: '',
		ability,
		moves,
		nature: 'Serious',
		gender: species.gender || '',
		evs: { hp: 252, atk: 0, def: 4, spa: 0, spd: 0, spe: 252 },
		ivs: { ...STAT_MAX_IV },
		level: 100,
	};
}

function hasRandomFile(generator: RandomSetSource, id: string, isDoubles: boolean): boolean {
	const table = isDoubles ? generator.randomDoublesSets : generator.randomSets;
	return !!table?.[id]?.sets?.length;
}

function setProblems(validator: TeamValidator, set: PokemonSet): string[] | null {
	try {
		return validator.validateSet(set, {});
	} catch (err) {
		return [String(err)];
	}
}

function generateLegalSet(
	speciesName: string,
	generator: RandomSetSource,
	validator: TeamValidator,
	dex: ReturnType<typeof Dex.forFormat>,
	isDoubles: boolean
): PokemonSet | null {
	const species = dex.species.get(speciesName);
	if (!species.exists) return null;

	if (hasRandomFile(generator, species.id, isDoubles)) {
		for (let attempt = 0; attempt < 8; attempt++) {
			try {
				const set = toPokemonSet(generator.randomSet(species.name, {}, attempt === 0, isDoubles));
				if (!set.moves.length) continue;
				if (!setProblems(validator, set)) return set;
			} catch {
				break;
			}
		}
	}

	const stock = learnsetStockSet(species.name, dex);
	if (stock && !setProblems(validator, stock)) return stock;
	return null;
}

function sampleN<T>(items: T[], n: number, prng: PRNG): T[] {
	if (n >= items.length) return items.slice();
	const copy = items.slice();
	prng.shuffle(copy);
	return copy.slice(0, n);
}

/**
 * Build a legal team from a constrained species list.
 *
 * @param speciesList Pool of species names (Showdown ids or display names).
 * @param format Format id or name. Defaults to {@link DEFAULT_FORMAT}.
 * @param options `mode` (`pick` | `fixed`), `size` (default 6), `seed`.
 */
export function buildTeamFromList(
	speciesList: readonly string[],
	format?: string | null,
	options: BuildTeamFromListOptions = {}
): BuiltTeam {
	const size = options.size ?? DEFAULT_TEAM_SIZE;
	if (size < 1) throw new TeamFromListError('team size must be >= 1');

	const unique = uniqueSpecies(speciesList);
	if (!unique.length) throw new TeamFromListError('empty species list');

	const formatid = format == null || format === '' ? DEFAULT_FORMAT : format;
	const formatData = Dex.formats.get(formatid);
	if (!formatData.exists) throw new TeamFromListError(`unknown format: ${formatid}`);

	const mode: TeamPickMode = options.mode === 'fixed' ? 'fixed' : 'pick';
	const prng = PRNG.get(options.seed ?? null);
	const generator = Teams.getGenerator(formatData, prng) as unknown as RandomSetSource;
	const validator = new TeamValidator(formatData);
	const dex = Dex.forFormat(formatData);
	const isDoubles = formatData.gameType === 'doubles' || formatData.gameType === 'freeforall';

	const unknown: string[] = [];
	const illegal: string[] = [];
	const legal: { name: string, set: PokemonSet }[] = [];

	for (const name of unique) {
		const species = dex.species.get(name);
		if (!species.exists) {
			unknown.push(name);
			continue;
		}
		const set = generateLegalSet(name, generator, validator, dex, isDoubles);
		if (!set) {
			illegal.push(name);
			continue;
		}
		legal.push({ name: species.name, set });
	}

	if (mode === 'fixed') {
		if (unknown.length) {
			throw new TeamFromListError(`unknown species: ${unknown.join(', ')}`);
		}
		if (illegal.length) {
			throw new TeamFromListError(`illegal species in ${formatData.id}: ${illegal.join(', ')}`);
		}
	}

	if (!legal.length) {
		const bits = [];
		if (unknown.length) bits.push(`unknown: ${unknown.join(', ')}`);
		if (illegal.length) bits.push(`illegal: ${illegal.join(', ')}`);
		throw new TeamFromListError(
			bits.length ? `no legal species in list (${bits.join('; ')})` : 'no legal species in list'
		);
	}

	const chosen = mode === 'fixed' ?
		legal.slice(0, size) :
		(legal.length <= size ? legal : sampleN(legal, size, prng));

	const team = chosen.map(entry => entry.set);
	const teamProblems = validator.validateTeam(team);
	if (teamProblems) {
		throw new TeamFromListError(`generated team failed validation: ${teamProblems.join('; ')}`);
	}

	return {
		team,
		packed: Teams.pack(team),
		format: formatData.id,
		generator: GENERATOR_NAME,
		picked: chosen.map(entry => entry.name),
	};
}
