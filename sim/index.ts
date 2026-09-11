/**
 * Simulator
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Here's where all the simulator APIs get exported for general use.
 * `require('pokemon-showdown')` imports from here.
 *
 * @license MIT
 */

// battle simulation

export { Battle } from './battle';
export { BattleStream, getPlayerStreams } from './battle-stream';
export { Pokemon } from './pokemon';
export { PRNG } from './prng';
export { Side } from './side';

// dex API

export { Dex, toID } from './dex';

// teams API

export { Teams } from './teams';
export { TeamValidator } from './team-validator';
export {
	buildTeamFromList, TeamFromListError, DEFAULT_FORMAT, GENERATOR_NAME,
} from './team-from-list';

// misc libraries

export * from '../lib';
