import { Room } from "colyseus";
import { type Client } from "@colyseus/core";
import { GameState, Player, Cell, PowerUp, Slot } from "./GameState.js";
import { randomUUID } from "crypto";

// ── Analytics ──────────────────────────────────────────────────────────────
const ANALYTICS_URL             = 'https://analytics-api.unusualtechnologies.com';
const ANALYTICS_API_KEY         = process.env.ANALYTICS_API_KEY         ?? '';
const ANALYTICS_PROJECT_STAGING = process.env.ANALYTICS_PROJECT_STAGING ?? 'blaze_the_maze_staging';
const ANALYTICS_PROJECT_LIVE    = process.env.ANALYTICS_PROJECT_LIVE    ?? 'blaze_the_maze_live';

type AnalyticsEnv = 'live' | 'staging' | 'none';

function track(event_name: string, player_id: string | null, session_id: string, properties: Record<string, unknown> = {}, env: AnalyticsEnv = 'none'): void {
    if (env === 'none' || !ANALYTICS_API_KEY) return;
    const project = env === 'live' ? ANALYTICS_PROJECT_LIVE : ANALYTICS_PROJECT_STAGING;
    fetch(ANALYTICS_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANALYTICS_API_KEY },
        body:    JSON.stringify({ project, event_name, player_id, session_id, properties }),
    }).catch(() => {});
}
// ───────────────────────────────────────────────────────────────────────────

/** Typed lobby options sent by the client when creating a room. */
interface SlotConfig {
    mode?: string;
    id?: string;
    color?: string;
    aiBehavior?: string;
    controlScheme?: string;
    aiSpeed?: string;
    aiCustomSpeed?: number;
}

interface LobbyOptions {
    desiredRoomId?: string;
    cols?: number;
    rows?: number;
    collisions?: boolean;
    orbLeaderOnly?: boolean;
    slots?: SlotConfig[];
    puOpp?: number;
    puSelf?: number;
    puRocket?: number;
    puMirror?: number;
    puMystery?: number;
    puFreeze?: number;
    puBeacon?: number;
    isPrivate?: boolean;
    clientVersion?: string;
}

interface JoinOptions {
    joinedViaCode?: boolean;
    playerGuid?:   string;
    isMobile?:     boolean;
    screenW?:      number;
    screenH?:      number;
    humanSlotCount?: number;
    analyticsEnv?: AnalyticsEnv;
}

export class GameRoom extends Room<{ state: GameState }> {
    maxClients = 8;
    cols = 20;
    rows = 20;
    collisions = true;
    spawnOptions: LobbyOptions = {};

    // BFS distance map from goal — flat array indexed by idx(x, y)
    distanceMap: number[] = [];
    // Tracks which connected sessionIds joined via friend code (cannot be kicked)
    friendCodeJoiners = new Set<string>();
    // Human sessionIds currently inside their allowReconnection() hold window. Colyseus
    // removes suspended clients from `this.clients`, so without this the "last human left"
    // check would tear the room down while these players are mid-reconnect, dropping them.
    pendingReconnects = new Set<string>();
    // Per-client analytics state: analytics session UUID, join timestamp, round number at join
    private clientAnalytics = new Map<string, { playerId: string | null; analyticsSessionId: string; startMs: number; joinRound: number; env: AnalyticsEnv }>();
    // Incremented on every round win — used to calculate rounds_played per session
    private roundCount = 0;
    // Per-AI session state (not broadcast)
    aiCooldowns = new Map<string, number>();
    scalingSpeedSlots = new Set<number>(); // slot indices configured with "scaling" speed
    guesserData = new Map<string, { target: { x: number; y: number }; distMap: number[]; reachedFirst: boolean }>();
    aiPUTarget = new Map<string, { x: number; y: number; distMap: number[] } | null>();
    frozenPlayers = new Map<string, number>(); // sessionId → unfreeze timestamp (ms)
    aiLoggedState = new Map<string, string>(); // sessionId → last logged sub-state (for change detection)
    aiLastPos = new Map<string, { x: number; y: number }>(); // sessionId → cell visited before current (for random anti-backtrack)
    aiResolvedBehavior = new Map<string, string>(); // sessionId → concrete behavior (resolves "random" meta-setting to a real strategy)
    // Freeze simulation while waiting for round reset
    roundOver: boolean = false;
    // True once a match is won; blocks new joins until someone with the code restarts
    matchComplete: boolean = false;
    // Last round_won payload — sent to clients who join during the round-over countdown
    lastRoundWon: { winnerId: string; winnerColor: string; winnerScore: number; isMatchWon: boolean } | null = null;
    // Last input timestamp per human sessionId — used for idle kick
    lastInputTime = new Map<string, number>();
    // Token-bucket move limiter per sessionId. Absorbs network jitter (so a legitimately
    // paced move is never dropped — dropping one would desync the client now that moves are
    // validated as single steps) while still capping the sustained move rate.
    moveBuckets = new Map<string, { tokens: number; last: number }>();
    // Session ID of the room creator — only they may drive secondary local slots
    ownerSessionId: string = '';
    // Timestamp (Date.now()) when the current round started — AI and move messages are blocked
    roundStartMs: number = 0;
    // Diagnostics: per-client count of moves dropped/rejected since the current round
    // started, so the logs show reconciliation firing (and NOT cascading like before).
    moveRejectCounts = new Map<string, { lockDrops: number; illegal: number }>();
    // Tracks each player's cell before their most recent move — used for crossing/swap
    // collision detection: if A moved X→Y and B moved Y→X in the same step, they passed
    // through each other and should both be teleported even though they never occupied the
    // same cell at the same server tick.
    playerPrevPos = new Map<string, { x: number; y: number }>();
    dirStreaks = new Map<string, { dx: number; dy: number; count: number }>();
    orbLeaderOnly: boolean = false;
    // Server-authoritative rockets. A rocket is spawned when a player collects a rocket
    // power-up; it walks the BFS path to the goal and teleports any non-owner it overlaps.
    // Resolving hits here (instead of trusting a client "rocket_hit" message) prevents a
    // modified client from teleporting arbitrary opponents at will.
    activeRockets: { x: number; y: number; ownerSessionId: string; accumMs: number; hit: Set<string> }[] = [];

    // --- Constants ---

    static readonly WINS_TO_MATCH   = 3;               // rounds needed to win a match
    static readonly IDLE_TIMEOUT_MS = 3 * 60 * 1000;  // 3 minutes
    static readonly MOVE_LOCK_MS    = 3000;            // movement blocked at round start — matches client pulse-3 unlock (4500ms * 2/3)
    static readonly MOVE_LOCK_GRACE_MS = 200;          // tolerance at the tail of the lock: a legal single-step move arriving
                                                       // in the final 200ms is accepted, not dropped. Absorbs small client/server
                                                       // clock skew (~13–30ms observed) so a player who unlocks a hair early
                                                       // isn't snapped back. Grid is long-synced by this point, so it's safe.
    static readonly MOVE_REFILL_MS  = 50;              // one move token regenerates every 50ms → 20 moves/sec sustained
    static readonly MOVE_BURST      = 8;               // max moves accepted back-to-back — absorbs network jitter without dropping
    static readonly ROCKET_STEP_MS  = 50;              // ms per rocket cell — mirrors the client rocket's moveInterval

    /** Navigation directions with wall indices and their opposites. */
    private static readonly DIRS = [
        { dx:  0, dy: -1, wall: 0, oppWall: 2 },
        { dx:  1, dy:  0, wall: 1, oppWall: 3 },
        { dx:  0, dy:  1, wall: 2, oppWall: 0 },
        { dx: -1, dy:  0, wall: 3, oppWall: 1 },
    ] as const;

    // --- Lifecycle ---

    onCreate(options: LobbyOptions) {
        // Use an unambiguous uppercase-only room ID; accept a desired ID from the client
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const desired = options.desiredRoomId;
        if (typeof desired === 'string' && /^[A-Z0-9]{3,9}$/.test(desired)) {
            this.roomId = desired;
        } else {
            let customId = '';
            for (let i = 0; i < 9; i++) customId += chars.charAt(Math.floor(Math.random() * chars.length));
            this.roomId = customId;
        }
        this.cols = Math.max(15, Math.min(100, Number(options.cols) || 20));
        this.rows = Math.max(15, Math.min(100, Number(options.rows) || 20));
        this.collisions = options.collisions !== false; // default true
        this.orbLeaderOnly = options.orbLeaderOnly === true;

        const state = new GameState();
        state.cols = this.cols;
        state.rows = this.rows;
        state.goalX = Math.floor(this.cols / 2);
        state.goalY = Math.floor(this.rows / 2);

        const defaultColors = [
            '#ff0055', '#ff8800', '#ffee00', '#00ff22',
            '#00ffff', '#4466ff', '#aa00ff', '#ff00ff'
        ];

        const aiSpeedMs: Record<string, number> = {
            easy: 1000, intermediate: 600, hard: 300, scaling: 600
        };

        for (let i = 0; i < 8; i++) {
            const slot = new Slot();
            const config = options.slots ? options.slots[i] : null;

            if (config) {
                slot.mode = config.mode || "inactive";
                slot.id = GameRoom.sanitizeId(config.id, `Player ${i + 1}`);
                slot.color = GameRoom.sanitizeColor(config.color, defaultColors[i]);
                slot.aiBehavior = config.aiBehavior || "random";
                slot.controlScheme = config.controlScheme || "WASD";

                const speedKey = config.aiSpeed || "intermediate";
                if (speedKey === "custom") {
                    slot.aiSpeed = Math.max(100, Math.min(1000, Number(config.aiCustomSpeed) || 600));
                } else if (speedKey === "random") {
                    slot.aiSpeed = Math.floor(Math.random() * 900 + 100);
                } else if (speedKey === "scaling") {
                    slot.aiSpeed = 600; // starts at medium; updated each move from scores
                    this.scalingSpeedSlots.add(i);
                } else {
                    slot.aiSpeed = aiSpeedMs[speedKey] ?? 600;
                }
            } else {
                if (i === 0) slot.mode = "local";
                else if (i < 4) slot.mode = "ai_online";
                else slot.mode = "inactive";
                slot.id = `Player ${i + 1}`;
                slot.color = defaultColors[i];
            }
            state.slots.push(slot);

            if (slot.mode !== "inactive" && slot.mode !== "friend_only") {
                const player = new Player();
                player.id = slot.id;
                player.color = slot.color;
                player.isAI = true;
                player.slotIndex = i;
                const spawn = this.getSpawnPosition(i);
                player.x = spawn.x;
                player.y = spawn.y;
                state.players.set(`ai_${i}`, player);
            }
        }

        // Cap power-ups so they can always fit: leave room for all spawn points + goal + players
        const reservedCells = 1 + 8; // goal + 8 spawn corners/edges
        const availableCells = this.cols * this.rows - reservedCells;
        const maxPuPerType = Math.max(0, Math.floor(availableCells * 0.35));
        options.puOpp     = Math.min(isNaN(Number(options.puOpp))     ? 10 : Number(options.puOpp),     maxPuPerType);
        options.puSelf    = Math.min(isNaN(Number(options.puSelf))    ? 10 : Number(options.puSelf),    maxPuPerType);
        options.puRocket  = Math.min(isNaN(Number(options.puRocket))  ? 0  : Number(options.puRocket),  maxPuPerType);
        options.puMirror  = Math.min(isNaN(Number(options.puMirror))  ? 0  : Number(options.puMirror),  maxPuPerType);
        options.puMystery = Math.min(isNaN(Number(options.puMystery)) ? 0  : Number(options.puMystery), maxPuPerType);
        options.puFreeze  = Math.min(isNaN(Number(options.puFreeze))  ? 0  : Number(options.puFreeze),  maxPuPerType);
        options.puBeacon  = Math.min(isNaN(Number(options.puBeacon))  ? 0  : Number(options.puBeacon),  maxPuPerType);

        this.spawnOptions = options;
        state.roomCode = this.roomId;
        this.setState(state);
        this.roundStartMs = Date.now();
        this.generateMaze();
        this.distanceMap = this.computeDistanceMap(state.goalX, state.goalY);
        this.spawnPowerUps(options);

        // Pre-compute guesser targets for any guesser AI slots
        state.players.forEach((player, sid) => {
            if (player.isAI) this.initAIState(sid, player);
        });

        // Log Round 1 assignments (subsequent rounds log via resetRound)
        this.logRoundStart();

        // Schedule movement unlock broadcast. Client and server use different clocks
        // (Date.now vs performance.now) and network delay creates skew, so the client
        // can't safely rely on a hard-coded timer. Instead, the server sends an explicit
        // "unlock" message when the lock expires, and the client respects that.
        this.clock.setTimeout(() => {
            this.broadcast("movement_unlock");
        }, GameRoom.MOVE_LOCK_MS);

        if (options.isPrivate) this.setPrivate(true);

        // Lock immediately if this room was created with no random-joinable slots
        // (e.g. all friend_only/inactive), so random matchmaking never reserves a seat
        // here that onJoin would reject with ROOM_FULL.
        this.refreshLock();

        // 100 ms tick — AI moves every 300–600 ms so 60 fps server ticks are pointless overhead
        this.setSimulationInterval((dt) => {
            // Idle kick runs regardless of round state so players can't squat through post-match
            const now = Date.now();
            for (const client of [...this.clients]) {
                const last = this.lastInputTime.get(client.sessionId);
                if (last !== undefined && now - last > GameRoom.IDLE_TIMEOUT_MS) {
                    this.lastInputTime.delete(client.sessionId);
                    client.leave(4003);
                }
            }

            if (this.roundOver) return; // Freeze AI and timer during round-over countdown
            this.state.timer += dt / 1000;

            const moveLocked = now - this.roundStartMs < GameRoom.MOVE_LOCK_MS;
            this.state.players.forEach((player, sessionId) => {
                if (player.isAI) {
                    // 'local' slots are meant for human co-op on the host machine — skip AI
                    if (this.state.slots[player.slotIndex]?.mode === 'local') return;
                    if (moveLocked) { this.aiCooldowns.set(sessionId, 0); return; }
                    const cooldown = (this.aiCooldowns.get(sessionId) ?? 0) + dt;
                    this.aiCooldowns.set(sessionId, cooldown);
                    const slotSpeed = this.state.slots[player.slotIndex]?.aiSpeed ?? 600;
                    const effectiveSpeed = player.speedBoostActive ? Math.round(slotSpeed * 2 / 3) : slotSpeed;
                    if (cooldown >= effectiveSpeed) {
                        this.aiCooldowns.set(sessionId, 0);
                        this.moveAI(sessionId, player);
                    }
                }
            });

            this.updateRockets(dt);
        }, 100);

        this.onMessage("move", (client, message) => {
            try {
                if (this.roundOver) return;
                const player = this.state.players.get(client.sessionId);
                if (!player || player.isAI) return;
                // Rate limit: max 20 moves/sec per client
                const now = Date.now();
                const rj = this.moveRejectCounts.get(client.sessionId) ?? { lockDrops: 0, illegal: 0 };
                const lockElapsed = now - this.roundStartMs;
                // Hard lock for the bulk of the window; grace tolerance at the tail. A move in the
                // final GRACE ms is allowed through to normal validation (must still be a legal
                // single step) rather than dropped — this is what stops the round-start jump-back
                // for clients whose unlock fires a few ms before the server's.
                if (lockElapsed < GameRoom.MOVE_LOCK_MS - GameRoom.MOVE_LOCK_GRACE_MS) {
                    // Move arrived during the round-start lock window. Silently dropping it
                    // desyncs the client: it predicted the move locally and gets no rejection,
                    // so its position runs ahead of the server's (still at spawn). Every later
                    // move is then a multi-cell jump → rejected → snap-back. Tell the client
                    // its authoritative position so it stays pinned to spawn until truly unlocked.
                    try { client.send("move_reject", { x: player.x, y: player.y }); } catch (_) {}
                    rj.lockDrops++;
                    this.moveRejectCounts.set(client.sessionId, rj);
                    if (rj.lockDrops === 1) {
                        console.log(`[move_reject] lock-drop for ${client.sessionId}: client tried ${JSON.stringify(message)} during lock (${Math.round(GameRoom.MOVE_LOCK_MS - lockElapsed)}ms left), pinned to (${player.x},${player.y})`);
                    }
                    return;
                }
                if (now < (this.frozenPlayers.get(client.sessionId) ?? 0)) return; // frozen
                if (!this.allowMove(client.sessionId, now)) return; // burst-tolerant rate limit
                // Validate the move is a single legal step: in-bounds, exactly one
                // orthogonal cell away, with no wall in between. Blocks teleport-to-goal
                // and wall-hacking from modified clients.
                if (!this.isLegalStep(player, message?.x, message?.y)) {
                    console.warn(`Illegal move from ${client.sessionId}: ${JSON.stringify(message)} (server: from (${player.x},${player.y}), round=${this.roundCount}, gridGen=${this.state.gridGeneration})`);
                    // Authoritative correction: snap the client back to the server's real
                    // position so a single bad move can't cascade into an 8-move drift.
                    try { client.send("move_reject", { x: player.x, y: player.y }); } catch (_) {}
                    rj.illegal++;
                    this.moveRejectCounts.set(client.sessionId, rj);
                    return;
                }
                // Move accepted. If this client hit the round-start lock window this round,
                // log a one-line recovery summary (canary — should be rare/zero now that the
                // grace tolerance is in place), then clear the counter. Mid-round illegals from
                // power-up teleports are already logged individually above, so don't double-log.
                if (rj.lockDrops > 0) {
                    console.log(`[move_reject] ${client.sessionId} recovered: accepted move to ${JSON.stringify(message)} after ${rj.lockDrops} lock-drop(s) + ${rj.illegal} illegal this round`);
                }
                if (rj.lockDrops > 0 || rj.illegal > 0) this.moveRejectCounts.delete(client.sessionId);
                this.lastInputTime.set(client.sessionId, now);
                const _hPrevX = player.x, _hPrevY = player.y;
                this.playerPrevPos.set(client.sessionId, { x: player.x, y: player.y });
                player.x = message.x;
                player.y = message.y;
                this.updateDirStreak(client.sessionId, player, player.x - _hPrevX, player.y - _hPrevY);
                this.checkCollisions(player, client.sessionId);
            } catch (err) {
                console.error(`Move handler error for ${client.sessionId}:`, err);
            }
        });

        // Debug: teleport player to a specific cell (bypasses move validation for testing)
        this.onMessage("debug_teleport", (client, message) => {
            try {
                const player = this.state.players.get(client.sessionId);
                if (!player || player.isAI) return;
                const { x, y } = message;
                // Validate the target is a valid in-bounds cell
                if (!this.isInBounds(x, y)) return;
                const cell = this.state.grid[this.idx(x, y)];
                if (!cell) return;
                // Update position without move validation
                this.playerPrevPos.set(client.sessionId, { x: player.x, y: player.y });
                player.x = x;
                player.y = y;
                this.lastInputTime.set(client.sessionId, Date.now());
                console.log(`[DEBUG] ${client.sessionId} teleported to (${x},${y})`);
                // Check for collisions/goal/power-ups at the new position
                this.checkCollisions(player, client.sessionId);
            } catch (err) {
                console.error(`Debug teleport handler error for ${client.sessionId}:`, err);
            }
        });

        // Allows the host to drive unclaimed 'local' slots from the same machine (co-op)
        this.onMessage("move_secondary", (client, message) => {
            try {
                if (this.roundOver) return;
                if (Date.now() - this.roundStartMs < GameRoom.MOVE_LOCK_MS) return;
                if (client.sessionId !== this.ownerSessionId) return;
                const { slotIndex, x, y } = message;
                const slot = this.state.slots[slotIndex];
                if (!slot || slot.mode !== 'local' || slot.sessionId !== '') return;
                const aiId = `ai_${slotIndex}`;
                const player = this.state.players.get(aiId);
                if (!player || !player.isAI) return;
                // Same single-legal-step validation as the primary move handler.
                if (!this.isLegalStep(player, x, y)) {
                    console.warn(`Illegal move_secondary from ${client.sessionId}:`, message);
                    return;
                }
                this.lastInputTime.set(client.sessionId, Date.now()); // host is active
                this.playerPrevPos.set(aiId, { x: player.x, y: player.y });
                player.x = x;
                player.y = y;
                this.checkCollisions(player, aiId);
            } catch (err) {
                console.error(`move_secondary handler error for ${client.sessionId}:`, err);
            }
        });

        // Host broadcasts the Steam lobby ID so all players can join it and
        // become visible to their own friends via Steam's "Join Game" button.
        this.onMessage("set_steam_lobby", (client, message) => {
            try {
                if (client.sessionId !== this.ownerSessionId) return;
                if (typeof message?.lobbyId === 'string' && message.lobbyId.length <= 256) {
                    this.state.steamLobbyId = message.lobbyId;
                }
            } catch (err) {
                console.error(`set_steam_lobby handler error for ${client.sessionId}:`, err);
            }
        });

        // Rocket hits are now resolved server-side (see updateRockets) so they can't be
        // spoofed. Kept as a no-op so older clients that still emit this message don't
        // trigger Colyseus "no handler registered" warnings.
        this.onMessage("rocket_hit", () => {});

        // Echo the client's timestamp back so it can measure round-trip latency.
        this.onMessage("ping", (client, message) => {
            try { client.send("pong", { t: message?.t ?? 0 }); } catch (_) {}
        });

        // Periodic client-side metrics: fps and measured latency.
        this.onMessage("client_telemetry", (client, message) => {
            try {
                const _anal = this.clientAnalytics.get(client.sessionId);
                if (!_anal) return;
                const fps = typeof message?.fps === 'number' ? Math.round(message.fps) : null;
                const latency_ms = typeof message?.latency_ms === 'number' ? Math.round(message.latency_ms) : null;
                if (fps !== null) track('fps_sample', _anal.playerId, _anal.analyticsSessionId, { fps }, _anal.env);
                if (latency_ms !== null) track('latency_sample', _anal.playerId, _anal.analyticsSessionId, { latency_ms }, _anal.env);
            } catch (_) {}
        });

        // First time a player actually uses a control scheme (vs just selecting it).
        this.onMessage("controls_used", (client, message) => {
            try {
                const _anal = this.clientAnalytics.get(client.sessionId);
                if (!_anal) return;
                const scheme = typeof message?.scheme === 'string' ? message.scheme.slice(0, 32) : null;
                if (!scheme) return;
                track('controls_used', _anal.playerId, _anal.analyticsSessionId, {
                    scheme,
                    slot_index: typeof message?.slotIndex === 'number' ? message.slotIndex : null,
                }, _anal.env);
            } catch (_) {}
        });

        this.onMessage("share_action", (client, message) => {
            try {
                const _anal = this.clientAnalytics.get(client.sessionId);
                if (!_anal) return;
                const platform = typeof message?.platform === 'string' ? message.platform.slice(0, 32) : null;
                if (!platform) return;
                track('match_shared', _anal.playerId, _anal.analyticsSessionId, {
                    platform,
                }, _anal.env);
            } catch (_) {}
        });

        console.log(`Room created: ${this.roomId}`);
        // settings_applied is fired in onJoin (host) so we have the client's analyticsEnv.
    }

    onJoin(client: Client, options: JoinOptions) {
        console.log(`Client ${client.sessionId} joining...`);

        const joinedViaCode = !!options.joinedViaCode;
        const isHost = this.clients.length === 1;

        if (isHost) {
            this.ownerSessionId = client.sessionId;
            // Delay slightly so the message arrives after the client has registered
            // its onMessage("owner_confirm") handler in setupRoom.
            this.clock.setTimeout(() => client.send("owner_confirm", {}), 150);
        }

        if (this.matchComplete) {
            // Room is locked after a match — nobody can join. Throw so the client
            // falls through to the create-new-room path.
            throw new Error("MATCH_OVER");
        }

        // Step 1: find an empty slot
        // Friend-code joiners can also claim friend_only slots; random joiners cannot
        let assignedSlotIndex = this.state.slots.findIndex(s => {
            if (s.sessionId !== "") return false;
            if (joinedViaCode) return s.mode === "local" || s.mode === "ai_online" || s.mode === "friend_only" || s.mode === "ai_friend";
            return s.mode === "local" || s.mode === "ai_online";
        });

        // Step 2 (friend-code join only): kick a non-friend-code human to make room
        if (assignedSlotIndex === -1 && joinedViaCode) {
            const kickIdx = this.state.slots.findIndex(
                s => s.mode === "ai_online" && s.sessionId !== "" && !this.friendCodeJoiners.has(s.sessionId)
            );
            if (kickIdx !== -1) {
                const kickSlot = this.state.slots[kickIdx];
                const kickedId = kickSlot.sessionId;
                const kickedPlayer = this.state.players.get(kickedId);
                if (kickedPlayer) {
                    this.state.players.delete(kickedId);
                    kickedPlayer.isAI = true;
                    const aiId = `ai_${kickIdx}`;
                    this.state.players.set(aiId, kickedPlayer);
                    this.initAIState(aiId, kickedPlayer);
                }
                kickSlot.sessionId = "";
                this.friendCodeJoiners.delete(kickedId);
                this.clients.find(c => c.sessionId === kickedId)?.leave(4001);
                assignedSlotIndex = kickIdx;
            }
        }

        if (assignedSlotIndex === -1) {
            console.log(`No available slots for client ${client.sessionId}`);
            throw new Error("ROOM_FULL");
        }

        // Host and friend-code joiners are protected from future kicks
        if (isHost || joinedViaCode) this.friendCodeJoiners.add(client.sessionId);

        const slot = this.state.slots[assignedSlotIndex];
        slot.sessionId = client.sessionId;

        // Take over the existing AI player at this slot (preserving position and score)
        let existingPlayer: Player | undefined;
        let existingId: string | undefined;
        this.state.players.forEach((p: Player, id: string) => {
            if (p.slotIndex === assignedSlotIndex) {
                existingPlayer = p;
                existingId = id;
            }
        });

        if (existingPlayer !== undefined && existingId !== undefined) {
            this.state.players.delete(existingId);
            this.guesserData.delete(existingId);
            this.aiPUTarget.delete(existingId);
            existingPlayer.isAI = false;
            this.state.players.set(client.sessionId, existingPlayer);
        } else {
            // No AI placeholder found — create fresh at start position
            const player = new Player();
            player.id = slot.id;
            player.color = slot.color;
            player.isAI = false;
            player.slotIndex = assignedSlotIndex;
            const spawn = this.getSpawnPosition(assignedSlotIndex);
            player.x = spawn.x;
            player.y = spawn.y;
            this.state.players.set(client.sessionId, player);
        }
        this.lastInputTime.set(client.sessionId, Date.now()); // start idle clock from join time
        // Send the authoritative maze directly to the joiner via reliable message so
        // the client never has to decode the grid from schema state (see broadcastGridSync).
        if (this.state.grid.length === this.cols * this.rows) {
            const total = this.cols * this.rows;
            const walls: number[] = new Array(total);
            for (let i = 0; i < total; i++) {
                const c = this.state.grid[i];
                walls[i] = c ? ((c.walls[0] ? 1 : 0) | (c.walls[1] ? 2 : 0) | (c.walls[2] ? 4 : 0) | (c.walls[3] ? 8 : 0)) : 0;
            }
            client.send("grid_sync", {
                gen: this.state.gridGeneration, cols: this.cols, rows: this.rows,
                goalX: this.state.goalX, goalY: this.state.goalY, walls,
            });
        }
        // Catch up a late joiner who missed the round_won broadcast during the countdown
        if (this.roundOver && this.lastRoundWon) {
            client.send("round_won", this.lastRoundWon);
        }
        // If this joiner arrived after the round-start lock window already elapsed, the
        // scheduled movement_unlock broadcast has long fired. Send it directly so the
        // client's buffered failsafe lock releases immediately instead of stalling.
        if (Date.now() - this.roundStartMs >= GameRoom.MOVE_LOCK_MS) {
            client.send("movement_unlock", {});
        }
        console.log(`Client ${client.sessionId} assigned to slot ${assignedSlotIndex}`);

        // ── Telemetry: session start ───────────────────────────────────────────
        const _aid = randomUUID();
        const _playerId = options.playerGuid ?? null;
        const _env: AnalyticsEnv = (options.analyticsEnv === 'live' || options.analyticsEnv === 'staging')
            ? options.analyticsEnv : 'none';
        this.clientAnalytics.set(client.sessionId, { playerId: _playerId, analyticsSessionId: _aid, startMs: Date.now(), joinRound: this.roundCount, env: _env });
        if (isHost) {
            // settings_applied is fired here (on host join) rather than onCreate so we
            // have access to _env for routing to the correct analytics project.
            const _so = this.spawnOptions;
            const _activeSlots = (_so.slots ?? []).filter(s => s.mode !== 'inactive' && s.mode !== 'friend_only');
            track('settings_applied', null, randomUUID(), {
                grid_cols:       this.cols,
                grid_rows:       this.rows,
                collisions:      this.collisions,
                orb_leader_only: this.orbLeaderOnly,
                pu_opponent:     _so.puOpp     ?? 0,
                pu_self:         _so.puSelf    ?? 0,
                pu_rocket:       _so.puRocket  ?? 0,
                pu_mirror:       _so.puMirror  ?? 0,
                pu_mystery:      _so.puMystery ?? 0,
                pu_freeze:       _so.puFreeze  ?? 0,
                pu_beacon:       _so.puBeacon  ?? 0,
                active_players:  _activeSlots.length,
                human_players:   _activeSlots.filter(s => s.mode === 'local' || s.mode === 'secondary').length,
                ai_players:      _activeSlots.filter(s => s.mode === 'ai' || s.mode === 'ai_online' || s.mode === 'ai_friend').length,
                used_defaults:   !_so.slots || _so.slots.length === 0,
                client_version:  typeof _so.clientVersion === 'string' ? _so.clientVersion : null,
            }, _env);
        }
        track('session_start', _playerId, _aid, {
            joined_via_code:  joinedViaCode,
            is_host:          isHost,
            is_mobile:        options.isMobile   ?? false,
            screen_w:         options.screenW    ?? null,
            screen_h:         options.screenH    ?? null,
            human_slot_count: options.humanSlotCount ?? 1,
        }, _env);
        if (joinedViaCode) track('friend_code_used', _playerId, _aid, {}, _env);
        // ───────────────────────────────────────────────────────────────────────

        // This seat is now taken — re-evaluate whether random matchmaking should still
        // target this room (prevents the seat-reservation race that yields ROOM_FULL).
        this.refreshLock();
    }

    async onLeave(client: Client, code?: number) {
        // Codes 1000 (normal close) and our server-initiated codes mean the player
        // intentionally left. Anything else (1001, 1006, undefined, etc.) is an
        // unexpected drop — hold the slot for 8 seconds before converting to AI.
        const intentional = code === 1000 || code === 4001 || code === 4002 || code === 4003;

        if (!intentional) {
            // Only hold the reconnect window if other humans are still in the game.
            // If this player is the last human, tear down immediately so joinOrCreate
            // doesn't match new players to a zombie room and hit "seat reservation expired".
            // Count both still-connected humans and humans currently in their own
            // reconnect hold — Colyseus has already pulled suspended clients out of
            // `this.clients`, so relying on that alone would tear down the room while
            // others are mid-reconnect.
            const otherHumans =
                this.clients.filter(c => c.sessionId !== client.sessionId).length +
                [...this.pendingReconnects].filter(id => id !== client.sessionId).length;
            if (otherHumans > 0) {
                this.pendingReconnects.add(client.sessionId);
                try {
                    await this.allowReconnection(client, 8);
                    // Player reconnected — restore activity timestamp and keep playing
                    this.pendingReconnects.delete(client.sessionId);
                    this.lastInputTime.set(client.sessionId, Date.now());
                    console.log(`Client ${client.sessionId} reconnected.`);
                    return;
                } catch {
                    this.pendingReconnects.delete(client.sessionId);
                    console.log(`Client ${client.sessionId} reconnection window expired. Cleaning up.`);
                }
            }
        }

        // Capture any active freeze before cleanup so it can transfer to the AI takeover.
        const frozenUntil = this.frozenPlayers.get(client.sessionId);

        // Player is truly leaving — clean up all tracking state
        this.lastInputTime.delete(client.sessionId);
        this.moveBuckets.delete(client.sessionId);
        this.friendCodeJoiners.delete(client.sessionId);
        this.guesserData.delete(client.sessionId);
        this.aiPUTarget.delete(client.sessionId);
        this.aiCooldowns.delete(client.sessionId);
        this.playerPrevPos.delete(client.sessionId);
        this.frozenPlayers.delete(client.sessionId);
        this.moveRejectCounts.delete(client.sessionId);

        // ── Telemetry: session end ─────────────────────────────────────────────
        const _anal = this.clientAnalytics.get(client.sessionId);
        if (_anal) {
            track('session_end', _anal.playerId, _anal.analyticsSessionId, {
                duration_ms:   Date.now() - _anal.startMs,
                rounds_played: this.roundCount - _anal.joinRound,
                leave_code:    code ?? 0,
            }, _anal.env);
            this.clientAnalytics.delete(client.sessionId);
        }
        // ───────────────────────────────────────────────────────────────────────

        const player = this.state.players.get(client.sessionId);
        if (player) {
            const slotIndex = player.slotIndex;
            const slot = this.state.slots[slotIndex];
            if (slot.mode === "ai_online" || slot.mode === "local" || slot.mode === "ai_friend") {
                this.convertPlayerToAI(client.sessionId, player, slotIndex);
                // Carry over an in-progress freeze so the AI takeover stays frozen for
                // the remaining duration instead of moving freely.
                if (frozenUntil !== undefined && frozenUntil > Date.now()) {
                    this.frozenPlayers.set(`ai_${slotIndex}`, frozenUntil);
                }
                const label = slot.mode === "ai_friend" ? "Friend" : "Player";
                console.log(`${label} ${client.sessionId} left. AI taking over slot ${slotIndex}.`);
            } else if (slot.mode === "friend_only") {
                slot.sessionId = "";
                this.state.players.delete(client.sessionId);
            }
        }

        // When the owner leaves, promote all unclaimed local slots to ai_online so AI
        // resumes and other players can fill them.
        if (client.sessionId === this.ownerSessionId) {
            this.ownerSessionId = '';
            this.state.slots.forEach((slot) => {
                if (slot.mode === 'local' && slot.sessionId === '') {
                    slot.mode = 'ai_online';
                }
            });
        }

        // Shut down only if no human players remain AND nobody is mid-reconnect.
        // Suspended (reconnecting) clients are not in `this.clients`, so we must also
        // honour pendingReconnects — otherwise the last connected human leaving would
        // disconnect the room out from under players still trying to rejoin.
        const remaining = this.clients.filter(c => c.sessionId !== client.sessionId).length;
        const holding = [...this.pendingReconnects].filter(id => id !== client.sessionId).length;
        if (remaining === 0 && holding === 0) {
            console.log(`Room ${this.roomId}: no players remain. Shutting down.`);
            this.disconnect();
            return;
        }

        // A slot likely just reopened (player converted to AI / friend slot freed) —
        // reopen the room to random matchmaking if there's now a joinable slot.
        this.refreshLock();
    }

    // --- Helpers ---

    /** Flat grid index for cell at (x, y). */
    private idx(x: number, y: number): number {
        return x * this.rows + y;
    }

    /** True if (x, y) is an integer cell inside the grid. */
    private isInBounds(x: unknown, y: unknown): boolean {
        return Number.isInteger(x) && Number.isInteger(y) &&
            (x as number) >= 0 && (x as number) < this.cols &&
            (y as number) >= 0 && (y as number) < this.rows;
    }

    /** Validate that moving to (x, y) is a single legal step from the player's current
     *  cell: in-bounds, exactly one orthogonal cell away, with no wall between. A repeat
     *  of the current cell (dist 0) is treated as a harmless no-op. */
    private isLegalStep(player: Player, x: unknown, y: unknown): boolean {
        if (!this.isInBounds(x, y)) return false;
        const nx = x as number, ny = y as number;
        const dx = nx - player.x, dy = ny - player.y;
        const dist = Math.abs(dx) + Math.abs(dy);
        if (dist === 0) return true;
        if (dist !== 1) return false;
        const cell = this.state.grid[this.idx(player.x, player.y)];
        if (!cell) return false;
        const wall = dy === -1 ? 0 : dx === 1 ? 1 : dy === 1 ? 2 : 3;
        return !cell.walls[wall];
    }

    /** Track consecutive same-direction moves; set speedBoostActive after 4 in a row. */
    private updateDirStreak(sessionId: string, player: Player, dx: number, dy: number): void {
        const prev = this.dirStreaks.get(sessionId);
        if (prev && prev.dx === dx && prev.dy === dy) {
            prev.count++;
        } else {
            this.dirStreaks.set(sessionId, { dx, dy, count: 1 });
        }
        player.speedBoostActive = (this.dirStreaks.get(sessionId)!.count >= 4);
    }

    /** Token-bucket rate limit. Refills MOVE_BURST tokens at one per MOVE_REFILL_MS and
     *  consumes one per accepted move. Short bursts (network jitter delivering several
     *  client-paced moves at once) are absorbed instead of dropped — dropping a legit move
     *  would leave the next move >1 cell from the server position and cascade into a visible
     *  snap-back. Sustained spam beyond the refill rate still drains the bucket and is capped. */
    private allowMove(sessionId: string, now: number): boolean {
        const cap = GameRoom.MOVE_BURST;
        let b = this.moveBuckets.get(sessionId);
        if (!b) { b = { tokens: cap, last: now }; this.moveBuckets.set(sessionId, b); }
        b.tokens = Math.min(cap, b.tokens + (now - b.last) / GameRoom.MOVE_REFILL_MS);
        b.last = now;
        if (b.tokens < 1) return false;
        b.tokens -= 1;
        return true;
    }

    /** Only accept 6-digit hex colors; clients render player colors into innerHTML,
     *  so anything else is rejected to prevent HTML/CSS injection. */
    private static sanitizeColor(value: unknown, fallback: string): string {
        return (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)) ? value : fallback;
    }

    /** Restrict player ids to a short alphanumeric charset (no HTML metacharacters). */
    private static sanitizeId(value: unknown, fallback: string): string {
        if (typeof value !== 'string') return fallback;
        const cleaned = value.replace(/[^A-Za-z0-9 _\-]/g, '').trim().slice(0, 24);
        return cleaned.length > 0 ? cleaned : fallback;
    }

    /** Advance every active rocket along the BFS gradient toward the goal, teleporting any
     *  non-owner it lands on. Mirrors the client's rocket pathing so visuals stay in sync. */
    private updateRockets(dt: number): void {
        if (this.activeRockets.length === 0) return;
        for (const rocket of this.activeRockets) {
            rocket.accumMs += dt;
            // Catch a player who walked onto the rocket's current cell since the last step
            // (it can sit on a cell between 50 ms steps within a 100 ms tick).
            if (rocket.x >= 0) {
                this.state.players.forEach((p, sid) => {
                    if (sid === rocket.ownerSessionId || rocket.hit.has(sid)) return;
                    if (p.x === rocket.x && p.y === rocket.y) {
                        rocket.hit.add(sid);
                        this.teleportPlayer(p, "rocket");
                    }
                });
            }
            while (rocket.accumMs >= GameRoom.ROCKET_STEP_MS && rocket.x >= 0) {
                rocket.accumMs -= GameRoom.ROCKET_STEP_MS;
                if (rocket.x === this.state.goalX && rocket.y === this.state.goalY) {
                    rocket.x = -1; // reached goal — mark dead
                    break;
                }
                const cell = this.state.grid[this.idx(rocket.x, rocket.y)];
                if (!cell) { rocket.x = -1; break; }
                const currDist = this.getDistance(rocket.x, rocket.y);
                let best: { x: number; y: number } | null = null;
                let bestDist = currDist;
                for (const d of GameRoom.DIRS) {
                    if (cell.walls[d.wall]) continue;
                    const nx = rocket.x + d.dx, ny = rocket.y + d.dy;
                    if (nx < 0 || nx >= this.cols || ny < 0 || ny >= this.rows) continue;
                    const nd = this.getDistance(nx, ny);
                    if (nd < bestDist) { bestDist = nd; best = { x: nx, y: ny }; }
                }
                if (!best) { rocket.x = -1; break; } // dead-end / no improving move
                // Remember the cell the rocket is leaving so we can catch a head-on pass.
                const fromX = rocket.x, fromY = rocket.y;
                rocket.x = best.x;
                rocket.y = best.y;
                this.state.players.forEach((p, sid) => {
                    if (sid === rocket.ownerSessionId || rocket.hit.has(sid)) return;
                    // Direct hit: the player is on the cell the rocket just entered.
                    if (p.x === rocket.x && p.y === rocket.y) {
                        rocket.hit.add(sid);
                        this.teleportPlayer(p, "rocket");
                        return;
                    }
                    // Crossing/swap: the rocket moved fromX,fromY -> rocket.x,rocket.y while
                    // the player moved the opposite way (rocket.x,rocket.y -> fromX,fromY),
                    // so they passed through each other without ever sharing a cell. Mirrors
                    // the player-vs-player crossing detection.
                    const prev = this.playerPrevPos.get(sid);
                    if (p.x === fromX && p.y === fromY &&
                        prev && prev.x === rocket.x && prev.y === rocket.y) {
                        rocket.hit.add(sid);
                        this.teleportPlayer(p, "rocket-crossing");
                    }
                });
            }
        }
        this.activeRockets = this.activeRockets.filter(r => r.x >= 0);
    }

    /** Convert a human player's slot back to AI control. */
    private convertPlayerToAI(clientSessionId: string, player: Player, slotIndex: number): void {
        const aiId = `ai_${slotIndex}`;
        player.isAI = true;
        this.state.slots[slotIndex].sessionId = "";
        this.state.players.delete(clientSessionId);
        this.state.players.set(aiId, player);
        this.initAIState(aiId, player);
    }

    /**
     * Keep the room's matchmaking lock in sync with whether a *random* joiner could
     * actually be seated. Colyseus reserves seats purely on client-count vs maxClients,
     * but onJoin only accepts empty `local`/`ai_online` slots — so a room with free seats
     * but only `friend_only`/`inactive` openings would hand out a reservation that onJoin
     * then rejects with ROOM_FULL (the seat-reservation race). Locking removes the room
     * from random matchmaking while still allowing friend-code joinById, which bypasses the lock.
     *
     * The match-over flow (matchComplete) owns the lock during its 25s freeze / 5s window,
     * so we defer to it and do nothing while it's active.
     */
    private refreshLock(): void {
        if (this.matchComplete) return;
        const hasOpenSlot = this.state.slots.some(
            s => s.sessionId === "" && (s.mode === "local" || s.mode === "ai_online")
        );
        if (hasOpenSlot) {
            this.unlock();
        } else {
            this.lock();
        }
    }

    // --- AI Navigation ---

    /** BFS from (goalX, goalY) through the maze; returns flat distance array indexed by idx(x, y).
     *  Uses a head-index pointer instead of Array.shift() to keep BFS O(n) rather than O(n²). */
    computeDistanceMap(goalX: number, goalY: number): number[] {
        const map = new Array(this.cols * this.rows).fill(Infinity);
        map[this.idx(goalX, goalY)] = 0;
        const queue: { x: number; y: number }[] = [{ x: goalX, y: goalY }];
        let head = 0;
        while (head < queue.length) {
            const curr = queue[head++];
            const cell = this.state.grid[this.idx(curr.x, curr.y)];
            const currDist = map[this.idx(curr.x, curr.y)];
            for (const d of GameRoom.DIRS) {
                const nx = curr.x + d.dx, ny = curr.y + d.dy;
                if (nx >= 0 && nx < this.cols && ny >= 0 && ny < this.rows && !cell.walls[d.wall]) {
                    const ni = this.idx(nx, ny);
                    if (map[ni] === Infinity) {
                        map[ni] = currDist + 1;
                        queue.push({ x: nx, y: ny });
                    }
                }
            }
        }
        return map;
    }

    initAIState(sessionId: string, player: Player) {
        const configured = this.state.slots[player.slotIndex]?.aiBehavior ?? "random";

        // "random" is a meta-setting: pick a real strategy for this round
        const realStrategies = ["genius", "guesser", "chaotic"];
        const behavior = configured === "random"
            ? realStrategies[Math.floor(Math.random() * realStrategies.length)]
            : configured;
        this.aiResolvedBehavior.set(sessionId, behavior);

        if (behavior === "guesser") {
            let rx: number, ry: number;
            do {
                rx = Math.floor(Math.random() * this.cols);
                ry = Math.floor(Math.random() * this.rows);
            } while (rx === this.state.goalX && ry === this.state.goalY);
            this.guesserData.set(sessionId, {
                target: { x: rx, y: ry },
                distMap: this.computeDistanceMap(rx, ry),
                reachedFirst: false,
            });
        }
        this.aiPUTarget.delete(sessionId);
    }

    // BFS from (px,py) up to maxDist steps; returns nearest PU of given types and its full distMap, or null.
    private findNearestPowerUp(px: number, py: number, types: string[], maxDist: number): { x: number; y: number; distMap: number[] } | null {
        const visited = new Set<number>();
        const queue: { x: number; y: number; dist: number }[] = [{ x: px, y: py, dist: 0 }];
        visited.add(this.idx(px, py));
        while (queue.length > 0) {
            const curr = queue.shift()!;
            if (curr.dist > 0) {
                const pu = this.state.powerUps.find((p: any) => p.x === curr.x && p.y === curr.y && types.includes(p.type));
                if (pu) return { x: curr.x, y: curr.y, distMap: this.computeDistanceMap(curr.x, curr.y) };
            }
            if (curr.dist >= maxDist) continue;
            const cell = this.state.grid[this.idx(curr.x, curr.y)];
            for (const d of GameRoom.DIRS) {
                const nx = curr.x + d.dx, ny = curr.y + d.dy;
                if (nx < 0 || nx >= this.cols || ny < 0 || ny >= this.rows || cell.walls[d.wall]) continue;
                const ni = this.idx(nx, ny);
                if (!visited.has(ni)) { visited.add(ni); queue.push({ x: nx, y: ny, dist: curr.dist + 1 }); }
            }
        }
        return null;
    }

    // Check if cached PU target still exists on the map; clear if not.
    private validatePUTarget(sessionId: string): { x: number; y: number; distMap: number[] } | null {
        const cached = this.aiPUTarget.get(sessionId) ?? null;
        if (!cached) return null;
        const still = this.state.powerUps.some((p: any) => p.x === cached.x && p.y === cached.y);
        if (!still) { this.aiPUTarget.set(sessionId, null); return null; }
        return cached;
    }

    // Returns a move toward a PU-seek target if an opponent is within cols*2 cells of victory and ahead.
    // Priority: missile/teleport-other (closest), then teleport-self if neither found.
    private seekPowerUpIfThreatened(sessionId: string, player: Player, open: { x: number; y: number }[]): { x: number; y: number } | null {
        const threatRange = this.cols * 2;
        const myDist = this.distanceMap[this.idx(player.x, player.y)];
        // If we're close enough to win ourselves, sprint for the goal — never detour for a power-up.
        const sprintThreshold = Math.ceil(this.cols / 2);
        if (myDist <= sprintThreshold) { this.aiPUTarget.set(sessionId, null); return null; }
        let threatened = false;
        this.state.players.forEach((other, sid) => {
            if (sid === sessionId) return;
            const d = this.distanceMap[this.idx(other.x, other.y)];
            if (d <= threatRange && d < myDist) threatened = true;
        });
        if (!threatened) { this.aiPUTarget.set(sessionId, null); return null; }

        // Check cached target first
        let target = this.validatePUTarget(sessionId);
        if (!target) {
            // Search for missile or teleport-other within cols*2 cells
            target = this.findNearestPowerUp(player.x, player.y, ["rocket", "opponents"], threatRange);
            if (!target) {
                // Fallback: teleport-self within cols*2 cells
                target = this.findNearestPowerUp(player.x, player.y, ["self"], threatRange);
            }
            this.aiPUTarget.set(sessionId, target);
        }
        if (!target) return null;

        const tDist = target.distMap[this.idx(player.x, player.y)];
        let move: { x: number; y: number } | null = null;
        for (const n of open) {
            const d = target.distMap[this.idx(n.x, n.y)];
            if (d < tDist && (!move || d < target.distMap[this.idx(move.x, move.y)])) move = n;
        }
        return move;
    }

    moveAI(sessionId: string, player: Player) {
        if (Date.now() < (this.frozenPlayers.get(sessionId) ?? 0)) return; // frozen
        const slot = this.state.slots[player.slotIndex];
        // Use the resolved behavior (resolves "random" meta-setting to a concrete strategy)
        const configuredBehavior = slot?.aiBehavior ?? "random";
        let behavior = this.aiResolvedBehavior.get(sessionId) ?? configuredBehavior;

        const cell = this.state.grid[this.idx(player.x, player.y)];

        // Collect open neighbours
        const open = GameRoom.DIRS
            .filter(d => {
                const nx = player.x + d.dx, ny = player.y + d.dy;
                return nx >= 0 && nx < this.cols && ny >= 0 && ny < this.rows && !cell.walls[d.wall];
            })
            .map(d => ({ x: player.x + d.dx, y: player.y + d.dy }));

        if (open.length === 0) return;

        let move: { x: number; y: number } | null = null;

        let aiSubState = "idle";

        if (behavior === "genius") {
            // Check power-up seeking first (overrides goal-tracking if threatened)
            move = this.seekPowerUpIfThreatened(sessionId, player, open);
            aiSubState = move ? "seeking-pu (threatened)" : "tracking-star";
            if (!move) {
                // Track the star
                const currDist = this.distanceMap[this.idx(player.x, player.y)];
                for (const n of open) {
                    const d = this.distanceMap[this.idx(n.x, n.y)];
                    if (d < currDist && (!move || d < this.distanceMap[this.idx(move.x, move.y)])) move = n;
                }
            }

        } else if (behavior === "guesser") {
            // Check power-up seeking first
            move = this.seekPowerUpIfThreatened(sessionId, player, open);
            if (move) {
                aiSubState = "seeking-pu (threatened)";
            } else {
                const aiDist = this.distanceMap[this.idx(player.x, player.y)];
                const gd = this.guesserData.get(sessionId);
                const atTarget = !gd || (player.x === gd.target.x && player.y === gd.target.y);

                if (atTarget && gd && !gd.reachedFirst) gd.reachedFirst = true;

                const useGoal = aiDist <= this.cols * 2 || (gd?.reachedFirst ?? true);
                aiSubState = useGoal ? "tracking-star" : "navigating-random-target";
                if (useGoal) {
                    // Navigate toward star
                    for (const n of open) {
                        const d = this.distanceMap[this.idx(n.x, n.y)];
                        if (d < aiDist && (!move || d < this.distanceMap[this.idx(move.x, move.y)])) move = n;
                    }
                } else if (gd && !atTarget) {
                    // Navigate toward random target
                    const currDist = gd.distMap[this.idx(player.x, player.y)];
                    for (const n of open) {
                        const d = gd.distMap[this.idx(n.x, n.y)];
                        if (d < currDist && (!move || d < gd.distMap[this.idx(move.x, move.y)])) move = n;
                    }
                }
            }

        } else if (behavior === "chaotic") {
            const aiDist = this.distanceMap[this.idx(player.x, player.y)];
            const hasPowerUps = this.state.powerUps.length > 0;
            const useGoal = aiDist <= this.cols * 2 || !hasPowerUps;

            if (useGoal) {
                aiSubState = "tracking-star";
                for (const n of open) {
                    const d = this.distanceMap[this.idx(n.x, n.y)];
                    if (d < aiDist && (!move || d < this.distanceMap[this.idx(move.x, move.y)])) move = n;
                }
            } else {
                // Seek the closest power-up (any type); cache target until picked up
                let target = this.validatePUTarget(sessionId);
                if (!target) {
                    target = this.findNearestPowerUp(player.x, player.y,
                        ["rocket", "opponents", "self", "mirror", "freeze", "beacon", "mystery"], this.cols * this.rows);
                    this.aiPUTarget.set(sessionId, target);
                }
                aiSubState = target ? `seeking-pu (${target.x},${target.y})` : "tracking-star (no pu)";
                if (target) {
                    const tDist = target.distMap[this.idx(player.x, player.y)];
                    for (const n of open) {
                        const d = target.distMap[this.idx(n.x, n.y)];
                        if (d < tDist && (!move || d < target.distMap[this.idx(move.x, move.y)])) move = n;
                    }
                }
            }

        } else if (behavior === "focused") {
            aiSubState = "tracking-star";
            // Legacy: always track the star
            const currDist = this.distanceMap[this.idx(player.x, player.y)];
            for (const n of open) {
                const d = this.distanceMap[this.idx(n.x, n.y)];
                if (d < currDist && (!move || d < this.distanceMap[this.idx(move.x, move.y)])) move = n;
            }
        }

        // Final fallback: random (handles dead-ends with no improving move)
        if (!move) move = open[Math.floor(Math.random() * open.length)];

        // Log sub-state changes only (avoids spam on every tick)
        const prevState = this.aiLoggedState.get(sessionId);
        if (prevState !== aiSubState) {
            this.aiLoggedState.set(sessionId, aiSubState);
            const slot = this.state.slots[player.slotIndex];
            const speedMs = slot?.aiSpeed ?? 600;
            console.log(`  AI slot ${player.slotIndex} (${player.color}) [${behavior}@${speedMs}ms] → ${aiSubState}  pos=(${player.x},${player.y})`);
        }

        // Remember where the player was before this move (for random anti-backtrack next tick)
        this.aiLastPos.set(sessionId, { x: player.x, y: player.y });
        this.playerPrevPos.set(sessionId, { x: player.x, y: player.y });
        const _aiPrevX = player.x, _aiPrevY = player.y;

        player.x = move.x;
        player.y = move.y;
        this.updateDirStreak(sessionId, player, player.x - _aiPrevX, player.y - _aiPrevY);
        this.checkCollisions(player, sessionId);
    }

    // --- Maze & Powerups ---

    generateMaze() {
        this.state.gridGeneration++;   // signal to clients that the grid has changed
        const totalCells = this.cols * this.rows;
        if (this.state.grid.length === totalCells) {
            // Grid already populated (round 2+): reset walls in-place.
            // Colyseus sends only the changed wall values as a delta — much simpler
            // and more reliable than clear() + repopulate, which encodes as DELETE-all
            // then ADD-all and can leave the client schema in a partially-reconstructed
            // state when onStateChange fires.
            for (let i = 0; i < totalCells; i++) {
                this.state.grid[i].walls[0] = true;
                this.state.grid[i].walls[1] = true;
                this.state.grid[i].walls[2] = true;
                this.state.grid[i].walls[3] = true;
            }
        } else {
            // First generation: grid is empty, push all cells fresh.
            this.state.grid.splice(0);  // ensure clean
            for (let x = 0; x < this.cols; x++) {
                for (let y = 0; y < this.rows; y++) {
                    const cell = new Cell();
                    cell.walls[0] = cell.walls[1] = cell.walls[2] = cell.walls[3] = true;
                    this.state.grid.push(cell);
                }
            }
        }

        const stack: { x: number; y: number }[] = [];
        const visited = new Set<string>();
        stack.push({ x: 0, y: 0 });
        visited.add('0,0');

        while (stack.length > 0) {
            const curr = stack[stack.length - 1];
            const neighbors: { x: number; y: number; wall: number; oppWall: number }[] = [];
            for (const d of GameRoom.DIRS) {
                const nx = curr.x + d.dx, ny = curr.y + d.dy;
                if (nx >= 0 && nx < this.cols && ny >= 0 && ny < this.rows && !visited.has(`${nx},${ny}`)) {
                    neighbors.push({ x: nx, y: ny, wall: d.wall, oppWall: d.oppWall });
                }
            }
            if (neighbors.length > 0) {
                const next = neighbors[Math.floor(Math.random() * neighbors.length)];
                this.state.grid[this.idx(curr.x, curr.y)].walls[next.wall] = false;
                this.state.grid[this.idx(next.x, next.y)].walls[next.oppWall] = false;
                visited.add(`${next.x},${next.y}`);
                stack.push({ x: next.x, y: next.y });
            } else {
                stack.pop();
            }
        }

        // Broadcast the freshly-generated maze as a RELIABLE MESSAGE, not just via
        // schema state. The grid is a 441-element ArraySchema of sub-schemas; Colyseus
        // delta-encodes round-2+ changes (clear()+repopulate OR in-place wall edits)
        // and the client can decode that delta into a corrupted/partial grid — the
        // root cause of the round-2 "illegal move / snap to spawn" desync. Round 1
        // worked only because joins get a full snapshot, not a delta. A plain message
        // carries the authoritative walls verbatim, bypassing schema diffing entirely.
        this.broadcastGridSync();
    }

    /** Packs each cell's 4 walls into a 4-bit mask and broadcasts the whole maze
     *  as a reliable message. Client rebuilds its grid directly from this. */
    private broadcastGridSync() {
        const total = this.cols * this.rows;
        const walls: number[] = new Array(total);
        for (let i = 0; i < total; i++) {
            const c = this.state.grid[i];
            if (!c) { walls[i] = 0; continue; }
            walls[i] = (c.walls[0] ? 1 : 0) | (c.walls[1] ? 2 : 0)
                     | (c.walls[2] ? 4 : 0) | (c.walls[3] ? 8 : 0);
        }
        this.broadcast("grid_sync", {
            gen:   this.state.gridGeneration,
            cols:  this.cols,
            rows:  this.rows,
            goalX: this.state.goalX,
            goalY: this.state.goalY,
            walls,
        });
    }

    spawnPowerUps(options: Partial<LobbyOptions> = {}) {
        this.state.powerUps.clear();
        this.activeRockets = [];
        const playerCount = this.state.players.size;
        const dynamicDefault = Math.max(2, 10 - playerCount);
        const puOpp     = options.puOpp     !== undefined ? Number(options.puOpp)     : dynamicDefault;
        const puSelf    = options.puSelf    !== undefined ? Number(options.puSelf)    : dynamicDefault;
        const puRocket  = options.puRocket  !== undefined ? Number(options.puRocket)  : 0;
        const puMirror  = options.puMirror  !== undefined ? Number(options.puMirror)  : 0;
        const puMystery = options.puMystery !== undefined ? Number(options.puMystery) : 0;
        const puFreeze  = options.puFreeze  !== undefined ? Number(options.puFreeze)  : 0;
        const puBeacon  = options.puBeacon  !== undefined ? Number(options.puBeacon)  : 0;

        // Collect dead-end cells (exactly 1 open passage) and corridor cells (2+ passages)
        const deadEnds:  { x: number; y: number }[] = [];
        const corridors: { x: number; y: number }[] = [];
        for (let x = 0; x < this.cols; x++) {
            for (let y = 0; y < this.rows; y++) {
                if (this.isReservedCell(x, y)) continue;
                const cell = this.state.grid[this.idx(x, y)];
                if (!cell) continue;
                let openCount = 0;
                for (let w = 0; w < 4; w++) { if (!cell.walls[w]) openCount++; }
                if (openCount === 1) deadEnds.push({ x, y });
                else if (openCount >= 2) corridors.push({ x, y });
            }
        }
        // Fisher-Yates shuffle for corridors
        const shuffle = (arr: { x: number; y: number }[]) => {
            for (let i = arr.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [arr[i], arr[j]] = [arr[j], arr[i]];
            }
        };
        shuffle(corridors);

        // Weighted sort for dead ends: farther from goal = 2× more likely than closest.
        // Uses Efraimidis-Spirakis: key = U^(1/w), sort descending, take top N.
        {
            const dMap = this.distanceMap;
            const rawDists = deadEnds.map(({ x, y }) => {
                const d = dMap ? dMap[this.idx(x, y)] : Infinity;
                return isFinite(d) ? d : 0;
            });
            const minD = Math.min(...rawDists);
            const maxD = Math.max(...rawDists);
            const range = maxD - minD;
            const keyed = deadEnds.map((cell, i) => {
                const t = range > 0 ? (rawDists[i] - minD) / range : 0;
                const w = 1 + t; // 1.0 at closest, 2.0 at farthest
                return { cell, key: Math.random() ** (1 / w) };
            });
            keyed.sort((a, b) => b.key - a.key);
            deadEnds.length = 0;
            for (const { cell } of keyed) deadEnds.push(cell);
        }

        // Spawn power-ups from a given cell list
        const spawnFrom = (cells: { x: number; y: number }[], count: number, type: string) => {
            if (isNaN(count) || count <= 0) return;
            let placed = 0;
            for (const { x, y } of cells) {
                if (placed >= count) break;
                if (this.state.powerUps.some((pu: PowerUp) => pu.x === x && pu.y === y)) continue;
                const pu = new PowerUp();
                pu.x = x;
                pu.y = y;
                pu.type = type;
                this.state.powerUps.push(pu);
                placed++;
            }
        };

        // All cells combined (shuffled) for power-ups that can appear anywhere
        const allCells = [...corridors, ...deadEnds];
        shuffle(allCells);

        spawnFrom(deadEnds,  puOpp,     "opponents");
        spawnFrom(deadEnds,  puSelf,    "self");
        spawnFrom(deadEnds,  puRocket,  "rocket");
        spawnFrom(corridors, puMirror,  "mirror");  // on the critical path — players run into these naturally
        spawnFrom(deadEnds,  puMystery, "mystery"); // dead-ends — must be sought out
        spawnFrom(allCells,  puFreeze,  "freeze");  // anywhere — ambush encounters on path and off
        spawnFrom(deadEnds,  puBeacon,  "beacon");  // dead-ends — reward for exploration
    }

    // --- Collision & Teleport ---

    /** Apply a power-up effect for the given collector. Shared by direct pickup and mystery resolution. */
    private applyPowerUpEffect(type: string, sessionId: string, player: Player): void {
        if (type === "opponents") {
            if (this.orbLeaderOnly) {
                let leaderSid: string | null = null;
                let minDist = Infinity;
                this.state.players.forEach((p, sid) => {
                    if (sid === sessionId) return;
                    const d = this.getDistance(p.x, p.y);
                    if (d < minDist) { minDist = d; leaderSid = sid; }
                });
                const leaderPlayer = leaderSid ? this.state.players.get(leaderSid) : null;
                if (leaderPlayer) this.teleportPlayer(leaderPlayer, "pu-opponents-leader");
                else this.teleportPlayer(player, "pu-self"); // sole player — send yourself to the back
            } else {
                this.state.players.forEach((p, sid) => {
                    if (sid !== sessionId) this.teleportPlayer(p, "pu-opponents");
                });
            }
        } else if (type === "self") {
            this.teleportPlayer(player, "pu-self");
        } else if (type === "rocket") {
            // Spawn a server-authoritative rocket at the collector's cell. It walks the BFS
            // path to the goal each tick and teleports any non-owner it overlaps. Clients
            // still render their own copy for visuals, but the hit is decided server-side.
            this.activeRockets.push({ x: player.x, y: player.y, ownerSessionId: sessionId, accumMs: 0, hit: new Set() });
        } else if (type === "mirror") {
            const targetClient = this.clients.find(c => c.sessionId === sessionId);
            if (targetClient) targetClient.send("mirror_controls", { duration: 3000, collectorSessionId: sessionId });
        } else if (type === "freeze") {
            const freezeUntil = Date.now() + 3000;
            this.state.players.forEach((_p, sid) => {
                if (sid !== sessionId) this.frozenPlayers.set(sid, freezeUntil);
            });
            this.broadcast("freeze", { collectorSessionId: sessionId, duration: 3000 });
        } else if (type === "beacon") {
            this.broadcast("beacon", { collectorSessionId: sessionId, duration: 4000 });
        }
    }

    checkCollisions(player: Player, sessionId: string) {
        // Snapshot the cell the player physically stepped into — used for collision detection
        // below so that a self-teleport effect doesn't shift the reference point and cause a
        // second (cascading) teleport at the random landing position.
        const movedToX = player.x, movedToY = player.y;

        // Power-up pickup (always active)
        const puIndex = this.state.powerUps.findIndex(pu => pu.x === movedToX && pu.y === movedToY);
        if (puIndex !== -1) {
            const pu = this.state.powerUps[puIndex];
            this.state.powerUps.splice(puIndex, 1);

            if (pu.type === "mystery") {
                const MYSTERY_TYPES = ["opponents", "self", "rocket", "mirror", "freeze", "beacon"] as const;
                const resolvedType = MYSTERY_TYPES[Math.floor(Date.now() / 200) % MYSTERY_TYPES.length];
                this.applyPowerUpEffect(resolvedType, sessionId, player);
                this.broadcast("mystery_resolved", { x: pu.x, y: pu.y, resolvedType, collectorSessionId: sessionId });
            } else {
                this.applyPowerUpEffect(pu.type, sessionId, player);
            }
        }

        // Player-player collisions (respects lobby setting).
        // Always checked against movedToX/movedToY (the stepped-into cell), never the
        // post-teleport position, so a self-teleport can't chain into a collision teleport.
        if (this.collisions) {
            this.state.players.forEach((other, sid) => {
                if (sid !== sessionId && other.x === movedToX && other.y === movedToY) {
                    this.teleportPlayer(player, `collision-with-slot${other.slotIndex}`);
                    this.teleportPlayer(other, `collision-with-slot${player.slotIndex}`);
                }
            });

            // Crossing/swap collision: two players who swapped cells in the same step never
            // share a cell at any server tick, so the check above misses them entirely.
            // Example: human at A moves A→B while AI at B moves B→A — they pass through
            // each other. Detect by comparing each player's previous position against the
            // mover's current and previous cells.
            const prev = this.playerPrevPos.get(sessionId);
            if (prev) {
                this.state.players.forEach((other, sid) => {
                    if (sid === sessionId) return;
                    const otherPrev = this.playerPrevPos.get(sid);
                    if (!otherPrev) return;
                    // other is now at mover's previous cell AND came from mover's current cell
                    if (other.x === prev.x && other.y === prev.y &&
                        otherPrev.x === movedToX && otherPrev.y === movedToY) {
                        this.teleportPlayer(player, `crossing-slot${other.slotIndex}`);
                        this.teleportPlayer(other, `crossing-slot${player.slotIndex}`);
                    }
                });
            }
        }

        // Goal check
        if (player.x === this.state.goalX && player.y === this.state.goalY) {
            this.roundOver = true; // Freeze the game immediately
            player.score++;
            // Update scaling-speed slots based on new max score
            if (this.scalingSpeedSlots.size > 0) {
                let maxScore = 0;
                this.state.players.forEach(p => { if (p.score > maxScore) maxScore = p.score; });
                const scaledMs = maxScore >= 2 ? 200 : maxScore >= 1 ? 400 : 600;
                this.scalingSpeedSlots.forEach(idx => { this.state.slots[idx].aiSpeed = scaledMs; });
            }
            const isMatchWon = player.score >= GameRoom.WINS_TO_MATCH;

            // ── Telemetry: round result ────────────────────────────────────────
            this.roundCount++;
            const _winnerAnal = this.clientAnalytics.get(sessionId);
            track('round_won', _winnerAnal?.playerId ?? null, _winnerAnal?.analyticsSessionId ?? 'ai', {
                winner_is_ai:  player.isAI,
                round_time_ms: Date.now() - this.roundStartMs,
                winner_score:  player.score,
                is_match_won:  isMatchWon,
                round_number:  this.roundCount,
                player_count:  this.state.players.size,
                human_count:   [...this.state.players.values()].filter((p: Player) => !p.isAI).length,
            }, _winnerAnal?.env ?? 'none');
            // ──────────────────────────────────────────────────────────────────
            // Persist winner info in synced state so late joiners catch up via onStateChange
            this.state.roundOver = true;
            this.state.matchOver = isMatchWon;
            this.state.lastWinnerId = player.id;
            this.state.lastWinnerColor = player.color;
            this.state.lastWinnerScore = player.score;
            this.lastRoundWon = { winnerId: player.id, winnerColor: player.color, winnerScore: player.score, isMatchWon };
            this.broadcast("round_won", this.lastRoundWon);
            if (isMatchWon) {
                this.matchComplete = true;
                // Stay locked for the entire match-over window. onJoin throws MATCH_OVER
                // while matchComplete is true, so unlocking early would only expose the
                // room to random matchmaking that immediately gets rejected (the same
                // seat-reservation race refreshLock exists to prevent). Friend-code
                // joinById bypasses the lock, so it is unaffected.
                this.lock();
                // At 15 s: reset scores, regenerate maze, broadcast match_reset. This MUST
                // match the client's post-match countdown (MATCH_END_WAIT in index.html) so
                // the "Join now" button (unlocked in the last 5 s) drops clickers straight
                // into the new round when the timer hits 0, instead of stalling on
                // "Joining next game…" until a later server reset.
                this.clock.setTimeout(() => {
                    if (!this.matchComplete) return;
                    this.state.players.forEach(p => { p.score = 0; });
                    this.matchComplete = false;
                    this.resetRound();
                    this.roundStartMs = Date.now();
                    this.broadcast("match_reset");
                    // matchComplete just cleared — re-sync lock to actual slot availability.
                    this.refreshLock();
                }, 15000);
            } else {
                this.clock.setTimeout(() => {
                    this.broadcast("round_reset");
                    this.resetRound();
                }, 3000);
            }
        }
    }

    resetMatch() {
        // Convert all human players back to AI and free their slots, then full reset.
        // This runs synchronously in onJoin before any onLeave callbacks fire, so
        // subsequent onLeave calls for the kicked clients become no-ops.
        const toConvert: Array<{ sessionId: string; player: Player; slotIndex: number }> = [];
        this.state.players.forEach((player, sessionId) => {
            if (!player.isAI) toConvert.push({ sessionId, player, slotIndex: player.slotIndex });
        });
        for (const { sessionId, player, slotIndex } of toConvert) {
            player.score = 0;
            this.convertPlayerToAI(sessionId, player, slotIndex);
            this.friendCodeJoiners.delete(sessionId);
        }
        // Reset AI scores too
        this.state.players.forEach((player) => { player.score = 0; });

        this.roundOver = false;
        this.generateMaze();
        this.distanceMap = this.computeDistanceMap(this.state.goalX, this.state.goalY);
        this.spawnPowerUps(this.spawnOptions);
        this.state.timer = 0;
        this.roundStartMs = Date.now();

        this.moveRejectCounts.clear(); // fresh per-round reconciliation diagnostics
        this.playerPrevPos.clear();    // stale crossing-detection data from previous round
        this.dirStreaks.clear();
        this.state.players.forEach((player, sessionId) => {
            const spawn = this.getSpawnPosition(player.slotIndex);
            player.x = spawn.x;
            player.y = spawn.y;
            player.speedBoostActive = false;
            this.aiCooldowns.set(sessionId, 0);
            if (player.isAI) this.initAIState(sessionId, player);
        });
    }

    logRoundStart() {
        console.log(`\n── Round ${this.roundCount + 1} ──`);
        this.state.players.forEach((player, sessionId) => {
            const slot = this.state.slots[player.slotIndex];
            const configured = slot?.aiBehavior ?? "random";
            const resolved   = this.aiResolvedBehavior.get(sessionId) ?? configured;
            const speedMs    = slot?.aiSpeed ?? 600;
            const label      = player.isAI ? `AI  slot ${player.slotIndex}` : `Human slot ${player.slotIndex}`;
            const color      = player.color ?? '?';
            if (player.isAI) {
                // Show resolved strategy; annotate "(rolled)" if it was randomly chosen
                const behaviorLabel = configured === "random"
                    ? `${resolved} (rolled random)`
                    : resolved;
                console.log(`  ${label} (${color})  behavior=${behaviorLabel}  speed=${speedMs}ms`);
            } else {
                console.log(`  ${label} (${color})  [human]`);
            }
        });
    }

    resetRound() {
        this.roundOver = false;
        this.frozenPlayers.clear();
        this.lastRoundWon = null;
        this.state.roundOver = false;
        this.state.matchOver = false;
        this.state.lastWinnerId = "";
        this.state.lastWinnerColor = "";
        this.state.lastWinnerScore = 0;
        // New maze — generateMaze() resets walls in-place for round 2+ (avoids
        // Colyseus clear()+repopulate delta issues that caused client grid desync).
        this.generateMaze();
        this.distanceMap = this.computeDistanceMap(this.state.goalX, this.state.goalY);

        // Reset all player positions to starting corners
        this.dirStreaks.clear();
        this.state.players.forEach((player, sessionId) => {
            const i = player.slotIndex;
            const spawn = this.getSpawnPosition(i);
            player.x = spawn.x;
            player.y = spawn.y;
            player.speedBoostActive = false;
            this.aiCooldowns.set(sessionId, 0);
            this.aiLoggedState.delete(sessionId);
            this.aiLastPos.delete(sessionId);
            this.aiResolvedBehavior.delete(sessionId);
            // Re-init guesser/explorer state for AI
            if (player.isAI) this.initAIState(sessionId, player);
        });

        // Log round-start AI assignments
        this.logRoundStart();

        // Fresh power-ups using original lobby settings
        this.spawnPowerUps(this.spawnOptions);
        this.state.timer = 0;
        this.roundStartMs = Date.now();

        // Schedule movement unlock broadcast (same as initMatch)
        this.clock.setTimeout(() => {
            this.broadcast("movement_unlock");
        }, GameRoom.MOVE_LOCK_MS);
    }

    getSpawnPosition(slotIndex: number): { x: number; y: number } {
        const midX = Math.floor(this.cols / 2);
        const midY = Math.floor(this.rows / 2);
        const spawns = [
            { x: 0,             y: 0             }, // slot 0: top-left corner
            { x: this.cols - 1, y: 0             }, // slot 1: top-right corner
            { x: 0,             y: this.rows - 1 }, // slot 2: bottom-left corner
            { x: this.cols - 1, y: this.rows - 1 }, // slot 3: bottom-right corner
            { x: midX,          y: 0             }, // slot 4: mid top edge
            { x: midX,          y: this.rows - 1 }, // slot 5: mid bottom edge
            { x: 0,             y: midY          }, // slot 6: mid left edge
            { x: this.cols - 1, y: midY          }, // slot 7: mid right edge
        ];
        return spawns[slotIndex] ?? { x: 0, y: 0 };
    }

    isReservedCell(x: number, y: number): boolean {
        if (x === this.state.goalX && y === this.state.goalY) return true;
        for (let i = 0; i < 8; i++) {
            const s = this.getSpawnPosition(i);
            if (x === s.x && y === s.y) return true;
        }
        return false;
    }

    teleportPlayer(player: Player, reason: string = "unknown") {
        const startX = player.x, startY = player.y;

        // Minimum BFS distance from the teleport source — scales with grid size so larger
        // mazes feel proportionally displaced. 15 on a 15×15 grid, 20 on a 20×20, etc.
        const minDist = Math.max(15, Math.max(this.cols, this.rows));
        // Minimum BFS distance from any other player — keeps landing spots from being
        // immediately adjacent to another player. Smaller than before (5 vs 10) so the
        // player-proximity constraint doesn't dominate on crowded grids.
        const minPlayerDist = 5;

        // BFS from the player's current cell — used to enforce minDist.
        const fromStartDist = this.computeDistanceMap(startX, startY);
        // BFS from every other player — used to enforce minPlayerDist.
        const otherPlayerMaps: number[][] = [];
        this.state.players.forEach((p) => {
            if (p.x === startX && p.y === startY) return; // skip the player being teleported
            otherPlayerMaps.push(this.computeDistanceMap(p.x, p.y));
        });

        // Helper: does a cell pass a given constraint set?
        const onPowerUp = (cx: number, cy: number) =>
            this.state.powerUps.some((pu: PowerUp) => pu.x === cx && pu.y === cy);

        // Build the full candidate list rather than retrying random positions — guarantees
        // no silent fallthrough onto a power-up or invalid cell if the random loop exhausts.
        const candidates: number[] = []; // flat indices for compact iteration
        for (let cx = 0; cx < this.cols; cx++) {
            for (let cy = 0; cy < this.rows; cy++) {
                const i = this.idx(cx, cy);
                if (fromStartDist[i] < minDist) continue;
                if (this.isReservedCell(cx, cy)) continue;              // goal + spawn points
                if (this.getDistance(cx, cy) <= 10) continue;           // too near the goal
                if (onPowerUp(cx, cy)) continue;
                if (otherPlayerMaps.some(m => m[i] < minPlayerDist)) continue;
                candidates.push(i);
            }
        }

        let destIdx = -1;
        if (candidates.length > 0) {
            destIdx = candidates[Math.floor(Math.random() * candidates.length)];
        } else {
            // Fallback: relax start-distance, goal-proximity, and player-proximity —
            // but never land on a power-up or the goal cell itself.
            const fallback: number[] = [];
            for (let cx = 0; cx < this.cols; cx++) {
                for (let cy = 0; cy < this.rows; cy++) {
                    if (cx === this.state.goalX && cy === this.state.goalY) continue;
                    if (onPowerUp(cx, cy)) continue;
                    fallback.push(this.idx(cx, cy));
                }
            }
            if (fallback.length > 0) {
                destIdx = fallback[Math.floor(Math.random() * fallback.length)];
                console.warn(`  TELEPORT fallback used for slot ${player.slotIndex} — full constraint list had no valid cells`);
            }
        }

        if (destIdx >= 0) {
            player.x = Math.floor(destIdx / this.rows);
            player.y = destIdx % this.rows;
        }
        // If destIdx is still -1 (impossible in practice: would need every cell to be a
        // power-up or the goal) the player stays put — better than corrupting state.

        // Teleport breaks any speed streak
        player.speedBoostActive = false;
        this.state.players.forEach((p, sid) => { if (p === player) this.dirStreaks.delete(sid); });

        // Authoritative teleport signal — the client plays the teleport animation when this
        // changes, rather than guessing from position displacement.
        player.teleportSeq = (player.teleportSeq + 1) & 0x7fffffff;
        console.log(`  TELEPORT ${player.isAI ? 'AI' : 'HUMAN'} slot ${player.slotIndex} (${player.color})  (${startX},${startY}) → (${player.x},${player.y})  reason=${reason}  seq=${player.teleportSeq}`);
    }

    getDistance(x: number, y: number) {
        return this.distanceMap[this.idx(x, y)] ?? Infinity;
    }
}
