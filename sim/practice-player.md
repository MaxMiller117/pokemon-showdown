# Practice player (list teams + stock AI)

In-process Pokémon Showdown **player bot** (not Discord). Humans challenge it
on **play.rd2lpl.com** with a species list (this week's draft pool); it
accepts, brings a legal team drawn **only from that pool**, and moves with
stock `RandomPlayerAI`. v1 is not a strong ladder bot.

It never opens a socket to smogon main (`sim*.psim.us` /
`play.pokemonshowdown.com`). Public replays follow the censored-replay policy
(rounded HP%, no EVs/IVs/`p1team`/`inputLog`). Autoupdate must **not**
`reset --hard` onto upstream (merge and abort on conflicts).

## How it plays

| Piece | Implementation |
|-------|----------------|
| AI | `sim/tools/random-player-ai.ts` (`RandomPlayerAI`) |
| Team | `buildTeamFromList` → packed `/utm` (`ps-TeamGenerator-randomSet`) |
| Default format | `gen9natdexdraft` ([Gen 9] NatDex Draft — current RD2L draft) |
| Challenge format | Honored when `Dex.formats.get(id).exists` **and** the format is bring-your-own-team. Unknown formats are rejected (default stays `gen9natdexdraft`). Random-team formats (`gen9randombattle`, etc.) are rejected because the sim would ignore `/utm`. |
| 6-from-N vs fixed-6 | Builder `mode: 'pick'` (default) or `'fixed'` via `Config.practiceplayer.mode` |

## Species list (smallest fork-native hook)

No Discord spawn. Give the bot a pool one of these ways:

1. **Room command (preferred):**
   ```
   /practiceplayer pool Garchomp, Heatran, Toxapex, Landorus-Therian, Clefable, Kingambit, Great Tusk, Dragonite
   /challenge RD2LPractice, gen9natdexdraft
   ```
   or one shot:
   ```
   /practice gen9natdexdraft, Garchomp, Heatran, Toxapex, Landorus-Therian, Clefable, Kingambit
   ```
2. **Config** (this week's standing draft pool):
   ```js
   exports.practiceplayer.species = ['Garchomp', 'Heatran', /* ... */];
   ```

Resolution: challenger's `/practiceplayer pool` → last global pool → config `species`.

## Start (side server)

1. In `config/config.js`:

```js
exports.practiceplayer = {
  enabled: true,
  name: 'RD2LPractice',
  format: 'gen9natdexdraft',
  mode: 'pick', // 6-from-N; use 'fixed' to keep list order
  species: [],  // optional default pool
};
```

2. Restart Showdown (`systemctl restart pokemon-showdown` on Contabo, or
   `node pokemon-showdown start` locally).
3. Confirm `/practiceplayer status` (or look for `RD2LPractice` in the user list).

Leave `enabled: false` (the config-example default) until you want the nick
sitting in the userlist.

Admin spawn without restart: `/practiceplayer start` (requires lockdown-level
auth).

## Challenge it

Preferred client: `https://play.pokemonshowdown.com/~~play.rd2lpl.com:443/`

1. Set a pool (`/practiceplayer pool ...` or `/practice FORMAT, Species, ...`).
2. Challenge user `RD2LPractice` in **[Gen 9] NatDex Draft**, or another PS
   format that already exists and lets you bring a team.

Local server: same nick after enabling the plugin.

Do **not** challenge this bot on smogon main. The code refuses those hosts.

## Local sim (no side server)

From the fork checkout, after `node build`:

```bash
node dist/sim/practice-player.js
node dist/sim/practice-player.js --format gen9natdexdraft --species Garchomp,Heatran,Toxapex,Landorus-Therian,Clefable,Kingambit
```

Runs RandomPlayerAI vs RandomPlayerAI with list teams until `|win|`. Does not
open a network socket. Default species is a demo 8-mon pool.

```bash
node dist/sim/practice-player.js --connect play.rd2lpl.com   # allowlisted; no outbound client
node dist/sim/practice-player.js --connect sim3.psim.us      # refused
```

`--connect` never logs into smogon. Live games are the in-process User on
*this* server.

## Tests

```bash
npx mocha test/sim/team-from-list.js test/sim/practice-player.js test/server/chat-plugins/practice-player.js --timeout 20000
```

## Replays

Public pages stay censored (skill `pokemon-showdown-side-server`). This plugin
does not upload `logs/*.log.json`.
