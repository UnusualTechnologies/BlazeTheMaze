# Blaze The Maze — Game Rules & Mechanics

Non-obvious rules and numeric constants. Update this file whenever a mechanic is added or changed.

---

## Match & Round Structure
- **Rounds to win a match:** 3 (`WINS_TO_MATCH = 3`)
- **Goal position:** Centre cell — `(floor(cols/2), floor(rows/2))`
- **Round winner:** First player to step onto the goal cell
- **Round-start movement lock:** Players cannot move for the first **3000 ms** of each round (`MOVE_LOCK_MS = 3000`). The unlock point is 2/3 through the countdown ring animation (`ROUND_START_MS = 4500 ms`)
- **Solo wait:** If only one human is left after a round win, the next round auto-starts after **10 s**
- **Match end countdown:** 30 s after match is won before the room resets

## Spawn Positions (8 fixed slots)
| Slot | Position |
|---|---|
| 0 | Top-left corner `(0, 0)` |
| 1 | Top-right corner `(cols-1, 0)` |
| 2 | Bottom-left corner `(0, rows-1)` |
| 3 | Bottom-right corner `(cols-1, rows-1)` |
| 4 | Mid top edge `(midX, 0)` |
| 5 | Mid bottom edge `(midX, rows-1)` |
| 6 | Mid left edge `(0, midY)` |
| 7 | Mid right edge `(cols-1, midY)` |

## Movement
- **Move cooldown (client):** Configurable in lobby — 100 / 125 / **150 (default)** / 175 / 200 ms. Controls minimum time between moves sent.
- **Rate limit (server):** Token bucket — max **20 moves/sec** sustained; burst tolerance of **8 moves** back-to-back (`MOVE_BURST = 8`, refill every `MOVE_REFILL_MS = 50 ms`)
- **Move validation:** Server rejects anything other than exactly 1 orthogonal cell step — no diagonals, no teleport-to-goal, no wall clipping
- **Turn intent leniency:** Client holds a queued turn direction for up to **300 ms** (Pac-Man style cornering)

## Player-Player Collisions
- Controlled by the `collisions` lobby setting (default **on**)
- When two players land on the same cell, **both** are teleported away
- In `orb_leader_only` mode, Opponents power-ups only teleport the single closest player to the goal instead of everyone

## Teleportation Exclusion Rules
When a player is teleported (collision, power-up, rocket hit), the destination must satisfy **all** of these:
- Not the goal cell
- Not occupied by another player
- Not occupied by a power-up
- BFS distance from goal ≥ **10 cells**
- BFS (maze-path) distance from the player's current cell ≥ **15**
- BFS distance from every other player's current position ≥ **10 cells** (checked at moment of teleport)
- Up to `cols × rows × 4` attempts are made; the goal-distance constraint relaxes after 200 failed attempts

## Idle Kick & Reconnection
- **Idle timeout:** 3 minutes (`IDLE_TIMEOUT_MS = 180 000 ms`) — updated on every move or input
- **Reconnection window:** 8 s for unexpected disconnects, **only** if at least one other human remains in the room
- **Intentional leave codes:** 1000, 4001, 4002, 4003 — skips the reconnection window entirely
- **Last human rule:** If the departing player is the last human, the room shuts down immediately (no reconnection hold)

## Room Lifecycle
- **Max clients:** 8
- **Default grid:** 20 × 20 (configurable)
- **Room code format:** 9-character alphanumeric, excluding `I O 0 1` to avoid visual confusion
- **Owner protection:** Room owner and friend-code joiners cannot be kicked to make room for others
- **Room shutdown:** Triggered immediately when the last human leaves

## Tension & Warning System
- **Tension activates** when the closest player is within `cols + rows` cells (BFS) of the goal
- **Tension formula:** `Math.pow(Math.min(1 - minDist / (cols + rows), 0.5), 3)` — cubic, capped at 0.5
- **Screen tint:** Pulses in the leader's colour; alpha = `tension × pulse × maxAlpha`
  - `maxAlpha` = **0.80** when leader is on match point, **0.58** otherwise
- **Pulse rate:** `max(55, 120 - tension × 65)` ms — ranges from 120 ms (low) down to 55 ms (high/match point)
- **Match point chromatic aberration:** Cyan/red edge tint appears when the leader has 2 wins AND tension > 0.3; edge width = `width × (0.12 + tension × 0.10)`

## Power-Ups

### Spawn Rules
- **Dead-end cells** (exactly 1 open passage): eligible for Opponents, Self, Rocket, Mystery, Beacon
- **Corridor cells** (2+ passages, on critical path): eligible for Mirror
- **All cells** (shuffled): eligible for Freeze (can appear anywhere for ambush encounters)
- **Cap:** No power-up type may occupy more than **35%** of available cells (available = all cells minus 1 goal minus 8 spawn positions)

### Default Counts (Quick Start, scales with player count `n`)
| Power-up | Default count |
|---|---|
| Opponents | `max(0, 7 - (n - 1))` |
| Self | `max(0, 7 - (n - 1))` |
| Rocket | `max(0, 4 - floor((n - 1) / 2))` |
| Mirror | 0 |
| Mystery | 0 |
| Freeze | 0 |
| Beacon | 0 |

### Opponents (yellow)
Teleports all other players away from the collector. In `orb_leader_only` mode, only teleports the player closest to the goal.

### Self (cyan)
Teleports the collector away from their current position.

### Warp Wheel (orange) — `ROCKET_STEP_MS = 50 ms/cell`
Server-authoritative Warp Wheel. Travels the BFS-optimal path toward the goal at 50 ms per cell. Teleports any non-owner player it overlaps. Dies on reaching the goal or hitting a dead-end with no improving BFS move. The collector is immune.

### Mirror (magenta) — 3 000 ms
Reverses all directional input for every player **except** the collector. Affected players are shown with a white outline.

### Freeze (blue) — 3 000 ms
Freezes all players **except** the collector in place.

### Beacon (gold) — 4 000 ms
Shows a glowing BFS path from the collector's current position to the goal. Path recalculates as the collector moves. Fades out in the final 1 s.

### Mystery (cycling colour)
Resolves to one of the 6 types above based on `floor(Date.now() / 200) % 6` — the type cycles every ~200 ms, so the effective type depends on the exact moment of collection. The server broadcasts a `mystery_resolved` message with the resolved type.

## AI Behaviour

| Speed tier | Move interval |
|---|---|
| Easy | 1 000 ms |
| Intermediate (default) | 600 ms |
| Hard | 300 ms |
| Custom | 100–1 000 ms (user-set) |
| Random | 100–1 000 ms, re-randomised each round |

| Behaviour | Logic |
|---|---|
| Random | Meta-setting: randomly picks one of Genius / Guesser / Chaotic at the start of each round. The chosen strategy is logged in the server console. |
| Genius | Always tracks the star. If any opponent is ≤ 20 cells from victory AND closer to it than the AI: seek the nearest missile (rocket) or teleport-other within 20 cells (closest of the two wins); if neither found, seek teleport-self within 20 cells; if none found, resume tracking the star. PU threat check runs every move. |
| Guesser | Picks a random non-goal cell and navigates there. Once the first target is reached, or when within 50 cells of victory, switches to tracking the star. Uses the same PU-threat logic as Genius every move. |
| Chaotic | Always seeks the closest power-up of any type. Only tracks the star when within 50 cells of victory or when no power-ups remain on the map. |

AI respects the 3 000 ms movement lock at round start, identical to human players.

## Maze Generation
- Algorithm: iterative depth-first search (stack-based backtracking) starting from `(0, 0)`
- Each cell stores 4 boolean walls `[up, right, down, left]`; walls are removed symmetrically when carving a passage
- Grid size: configurable; default 20 × 20; Quick Start scales by player count: `min(28, max(20, 20 + round((n - 2) × 4/3)))`

## Key Visual Timings
| Effect | Duration |
|---|---|
| Smoke puff (teleport VFX) | 500 ms |
| Power-up burst flash | 600 ms |
| Score float animation | 1 100 ms |
| Rocket move interval | 50 ms/cell |
| Mirror / Freeze pulse | 350 ms cycle |
| Beacon path pulse | 150 ms cycle |
| Mystery colour cycle | 200 ms/type |
| Slow-connection toast | Shown after 5 s connect attempt |
| Room join timeout | 10 s |
