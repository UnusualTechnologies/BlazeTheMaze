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

### Events

#### `settings_applied` — fired once per room creation
| Property | Description |
|---|---|
| `grid_cols`, `grid_rows` | Maze dimensions |
| `collisions` | Whether player collisions are enabled |
| `orb_leader_only` | Whether orbs are restricted to the leader |
| `pu_opponent`, `pu_self`, `pu_rocket`, `pu_mirror`, `pu_mystery`, `pu_freeze`, `pu_beacon` | Power-up counts configured for the room |
| `active_players`, `human_players`, `ai_players` | Slot breakdown at room creation |
| `used_defaults` | Whether the host used Quick Start defaults |

#### `session_start` — fired when a player joins
| Property | Description |
|---|---|
| `joined_via_code` | Player joined via friend code |
| `is_host` | Player created the room |
| `player_guid` | Persistent browser/app GUID from `localStorage` — used to identify returning players |
| `is_mobile` | Whether the device is a phone/tablet |
| `screen_w`, `screen_h` | Physical screen resolution |
| `human_slot_count` | Number of human players configured on this device (co-op) |

#### `friend_code_used` — fired when a player joins via friend code
*(no extra properties)*

#### `controls_used` — fired the first time a player actually moves with a given scheme
| Property | Description |
|---|---|
| `scheme` | Control scheme used (e.g. `WASD`, `Arrows`, `TouchMouse`, `Gamepad0`) |
| `slot_index` | Slot index of the player |

#### `fps_sample` — fired every 30 seconds per connected player
| Property | Description |
|---|---|
| `fps` | Exponential moving average FPS on the client |

#### `latency_sample` — fired every 30 seconds per connected player
| Property | Description |
|---|---|
| `latency_ms` | Round-trip time to the server (ping/pong, measured client-side) |

#### `round_won` — fired at the end of each round
| Property | Description |
|---|---|
| `winner_is_ai` | Whether the winner was an AI player |
| `round_time_ms` | How long the round lasted |
| `winner_score` | Winner's score at time of win |
| `is_match_won` | Whether this round also ended the match |
| `round_number` | Which round this was |
| `player_count`, `human_count` | Total and human player counts at round end |

#### `session_end` — fired when a player disconnects
| Property | Description |
|---|---|
| `duration_ms` | How long the player was connected |
| `rounds_played` | Number of rounds completed during the session |
| `leave_code` | WebSocket close code |

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
