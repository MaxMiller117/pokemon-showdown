# Species-list team builder

Export: `buildTeamFromList(species[], format?)` from `sim/team-from-list.ts`
(also re-exported from `sim/index.ts`).

```js
const { buildTeamFromList } = require('./dist/sim/team-from-list');
const { packed, team, format } = buildTeamFromList(
  ['Garchomp', 'Heatran', 'Toxapex', 'Landorus-Therian', 'Clefable', 'Kingambit', 'Great Tusk', 'Dragonite']
);
// packed: Showdown packed team string (for /utm)
// team:   PokemonSet[] JSON
// format: gen9natdexdraft unless overridden
```

## Generator

**Name:** `ps-TeamGenerator-randomSet`

In-tree PS `Teams.getGenerator` (Random Battle `TeamGenerator`) calling
`randomSet` per picked species. Not Smogon analyses, not `@pkmn/randoms`.

Why: already in this repo, fully offline, produces stock competitive-ish
sets. Species missing a Random Battle file get a learnset stock set; both
paths run through `TeamValidator` for the target format.

## Defaults

| Knob | Default |
|------|---------|
| format | `gen9natdexdraft` ([Gen 9] NatDex Draft — current RD2L draft) |
| mode | `pick` (6-from-N; if N ≤ 6 use the whole list) |
| size | 6 |
| `mode: 'fixed'` | use the list in order, cap at `size`; unknown/illegal names throw |

Unknown / format-illegal species: skipped in `pick`, rejected in `fixed`.
