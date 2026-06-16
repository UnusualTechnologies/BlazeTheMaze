# Blaze The Maze

A high-speed multiplayer maze racing game. First player to reach the centre goal wins the round; first to 3 rounds wins the match.

**Stack:** Vanilla JS + HTML5 Canvas · Colyseus 0.17 (Node.js/TypeScript) · WebSockets  
**Live server:** `wss://gb-lhr-5b4d543b.colyseus.cloud` (auto-deploys on push to `main`)  
**Steam App ID:** `4734010`

---

## Analytics

All telemetry is server-side. The client measures and sends data via WebSocket; `GameRoom.ts` calls the analytics API. No analytics calls are made from the browser/client directly.

Analytics endpoint: `https://analytics-api.unusualtechnologies.com`  
Project key: `blaze_the_maze`

Every event envelope carries two identity fields:
- **`player_id`** — the persistent player identity: the `localStorage` GUID (`blazeTheMazePlayerId`) set once per browser/device. `null` when unavailable (cleared storage, incognito). Use this to group events by unique player across sessions; filter `WHERE player_id IS NOT NULL` for known-player analysis.
- **`session_id`** — a UUID minted fresh on each `onJoin`. Use this to scope events to a single play session.

### Projects
| Project | When used |
|---|---|
| `blaze_the_maze_live` | itch.io (HTML5) and packaged Electron/Steam builds |
| `blaze_the_maze_staging` | GitHub Pages (`staging` branch) |
| *(none)* | Local dev (`electron .`, localhost, file://) — no events sent |

### Events

#### `settings_applied` — fired once per room creation
| Property | Type | Description |
|---|---|---|
| `grid_cols` | `int` | Maze width in cells |
| `grid_rows` | `int` | Maze height in cells |
| `collisions` | `bool` | Whether player collisions are enabled |
| `orb_leader_only` | `bool` | Whether orbs are restricted to the leader |
| `pu_opponent` | `int` | Opponents power-up count |
| `pu_self` | `int` | Self power-up count |
| `pu_rocket` | `int` | Warp Wheel count |
| `pu_mirror` | `int` | Mirror count |
| `pu_mystery` | `int` | Mystery count |
| `pu_freeze` | `int` | Freeze count |
| `pu_beacon` | `int` | Beacon count |
| `active_players` | `int` | Total player slots |
| `human_players` | `int` | Human slots |
| `ai_players` | `int` | AI slots |
| `used_defaults` | `bool` | Whether the host used Quick Start defaults |
| `client_version` | `string` | Game version string (e.g. `v1.5.390`) |

#### `session_start` — fired when a player joins
| Property | Type | Description |
|---|---|---|
| `joined_via_code` | `bool` | Player joined via friend code |
| `is_host` | `bool` | Player created the room |
| `is_mobile` | `bool` | Whether the device is a phone/tablet |
| `screen_w` | `int` | Physical screen width in pixels |
| `screen_h` | `int` | Physical screen height in pixels |
| `human_slot_count` | `int` | Number of human players configured on this device (co-op) |

#### `friend_code_used` — fired when a player joins via friend code
*(no extra properties)*

#### `controls_used` — fired the first time a player actually moves with a given scheme
| Property | Type | Description |
|---|---|---|
| `scheme` | `string` | Control scheme used: `WASD`, `Arrows`, `TFGH`, `IJKL`, `Numpad`, `TouchMouse`, `Gamepad0`…, or `solo_any` when the player is the only local player (all keys merged, so the configured scheme is not meaningful) |
| `slot_index` | `int` | Slot index of the player |

#### `fps_sample` — fired once at the end of each match per connected player
| Property | Type | Description |
|---|---|---|
| `fps` | `int` | Exponential moving average FPS on the client at match end |

#### `latency_sample` — fired every 30 seconds per connected player
| Property | Type | Description |
|---|---|---|
| `latency_ms` | `int` | Round-trip time to the server (ping/pong, measured client-side) |

#### `round_won` — fired at the end of each round
| Property | Type | Description |
|---|---|---|
| `winner_is_ai` | `bool` | Whether the winner was an AI player |
| `round_time_ms` | `int` | How long the round lasted in milliseconds |
| `winner_score` | `int` | Winner's score at time of win |
| `is_match_won` | `bool` | Whether this round also ended the match |
| `round_number` | `int` | Which round this was (1-indexed) |
| `player_count` | `int` | Total players at round end |
| `human_count` | `int` | Human players at round end |

#### `session_end` — fired when a player disconnects
| Property | Type | Description |
|---|---|---|
| `duration_ms` | `int` | How long the player was connected in milliseconds |
| `rounds_played` | `int` | Number of rounds completed during the session |
| `leave_code` | `int` | WebSocket close code (1000 = normal, 4001–4003 = server-initiated, 0 = unknown) |

#### `match_shared` — fired when a player clicks the copy results button post-match
| Property | Type | Description |
|---|---|---|
| `platform` | `string` | Which platform was shared to: `clipboard`, `discord`, or `steam` |

---

## Development

```
# Bump version (run before every commit)
.\build.ps1 -Type patch   # bug fixes / small changes
.\build.ps1 -Type minor   # releases / major features

# Type-check server
cd server && npx tsc --noEmit
```

Deploying server changes = pushing to `main`. Colyseus Cloud auto-deploys on push.
