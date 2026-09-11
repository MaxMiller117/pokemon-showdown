# Practice player (stock AI)

In-process Pokémon Showdown **player bot** (not Discord). Humans challenge it
on **play.rd2lpl.com**; it accepts, brings a stub random/legal team, and moves
with stock `RandomPlayerAI`. v1 is not a strong ladder bot.

It never opens a socket to smogon main (`sim*.psim.us` /
`play.pokemonshowdown.com`). Public replays follow the censored-replay policy
(rounded HP%, no EVs/IVs/`p1team`/`inputLog`).

## How it plays

| Piece | Implementation |
|-------|----------------|
| AI | `sim/tools/random-player-ai.ts` (`RandomPlayerAI`) |
| Team stub | `Teams.generate(format)` (PS TeamGenerator / randomSet) |
| Default format | `gen9randombattle` (always has a legal randomizer) |
| Challenge format | Honored when that format can generate a validator-legal team; otherwise the bot rejects and asks for a random-team format |
| List builder | Not wired in this card — sibling `buildTeamFromList` |

## Start (side server)

1. In `config/config.js`:

```js
exports.practiceplayer = {
  enabled: true,
  name: 'RD2LPractice',
  format: 'gen9randombattle',
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

- Challenge user `RD2LPractice` in **[Gen 9] Random Battle**, or
- `/practice` / `/practice gen9randombattle` in chat.

Local server: same nick after enabling the plugin.

Do **not** challenge this bot on smogon main. The code refuses those hosts.

## Local sim (no side server)

From the fork checkout, after `node build`:

```bash
node dist/sim/practice-player.js
node dist/sim/practice-player.js --format gen9randombattle
```

Runs RandomPlayerAI vs RandomPlayerAI with stub teams until `|win|`. Does not
open a network socket.

```bash
node dist/sim/practice-player.js --connect play.rd2lpl.com   # allowlisted; no outbound client
node dist/sim/practice-player.js --connect sim3.psim.us      # refused
```

`--connect` never logs into smogon. Live games are the in-process User on
*this* server.

## Tests

```bash
npx mocha test/sim/practice-player.js test/server/chat-plugins/practice-player.js --timeout 20000
```

## Replays

Public pages stay censored (skill `pokemon-showdown-side-server`). This plugin
does not upload `logs/*.log.json`.
