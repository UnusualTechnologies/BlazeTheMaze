import { Room } from "colyseus";
import { type Client } from "@colyseus/core";
import { GameState, Player, Cell, PowerUp, Slot } from "./GameState.js";

export class GameRoom extends Room<{ state: GameState }> {
    maxClients = 8;
    cols = 20;
    rows = 20;
    collisions = true;
    spawnOptions: any = {};

    // BFS distance map from goal — flat array indexed by idx(x, y)
    distanceMap: number[] = [];
    // Tracks which connected sessionIds joined via friend code (cannot be kicked)
    friendCodeJoiners = new Set<string>();
    // Per-AI session state (not broadcast)
    aiCooldowns = new Map<string, number>();
    explorerLastPos = new Map<string, { x: number; y: number }>();
    guesserData = new Map<string, { target: { x: number; y: number }; distMap: number[] }>();
    frozenPlayers = new Map<string, number>(); // sessionId → unfreeze timestamp (ms)
    // Freeze simulation while waiting for round reset
    roundOver: boolean = false;
    // True once a match is won; blocks new joins until someone with the code restarts
    matchComplete: boolean = false;
    // Last round_won payload — sent to clients who join during the round-over countdown
    lastRoundWon: { winnerId: string; winnerColor: string; winnerScore: number; isMatchWon: boolean } | null = null;
    // Last input timestamp per human sessionId — used for idle kick
    lastInputTime = new Map<string, number>();
    // Last accepted move timestamp per sessionId — for rate limiting
    lastMoveTime = new Map<string, number>();
    // Session ID of the room creator — only they may drive secondary local slots
    ownerSessionId: string = '';
    // Timestamp (Date.now()) when the current round started — AI and move messages are blocked
    roundStartMs: number = 0;
    orbLeaderOnly: boolean = false;
    // Tracks rocket-hit events already processed to prevent duplicate teleports
    usedRocketHits = new Set<string>();

    // --- Constants ---

    static readonly IDLE_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
    static readonly MOVE_LOCK_MS    = 4000;            // movement blocked at round start
    static readonly RATE_LIMIT_MS   = 50;              // minimum ms between accepted moves (max 20/sec)

    /** Navigation directions with wall indices and their opposites. */
    private static readonly DIRS = [
        { dx:  0, dy: -1, wall: 0, oppWall: 2 },
        { dx:  1, dy:  0, wall: 1, oppWall: 3 },
        { dx:  0, dy:  1, wall: 2, oppWall: 0 },
        { dx: -1, dy:  0, wall: 3, oppWall: 1 },
    ] as const;

    // --- Lifecycle ---

    onCreate(options: any) {
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
        this.cols = Math.max(5, Number(options.cols) || 20);
        this.rows = Math.max(5, Number(options.rows) || 20);
        this.collisions = options.collisions !== false; // default true
        this.orbLeaderOnly = options.orbLeaderOnly === true;

        const state = new GameState();
        state.cols = this.cols;
        state.rows = this.rows;
        state.puOpp = options.puOpp !== undefined ? Math.min(Number(options.puOpp), 100) : 10;
        state.puSelf = options.puSelf !== undefined ? Math.min(Number(options.puSelf), 100) : 10;
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
                slot.id = config.id || `Player ${i + 1}`;
                slot.color = config.color || defaultColors[i];
                slot.aiBehavior = config.aiBehavior || "random";
                slot.controlScheme = config.controlScheme || "WASD";

                const speedKey = config.aiSpeed || "intermediate";
                if (speedKey === "custom") {
                    slot.aiSpeed = Math.max(100, Math.min(1000, Number(config.aiCustomSpeed) || 600));
                } else if (speedKey === "random") {
                    slot.aiSpeed = Math.floor(Math.random() * 900 + 100);
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
        this.setState(state);
        this.roundStartMs = Date.now();
        state.roomCode = this.roomId;
        this.generateMaze();
        this.spawnPowerUps(options);

        // BFS distance map must be computed after maze is generated
        this.distanceMap = this.computeDistanceMap(state.goalX, state.goalY);

        // Pre-compute guesser targets for any guesser AI slots
        state.players.forEach((player, sid) => {
            if (player.isAI) this.initAIState(sid, player);
        });

        if (options.isPrivate) this.setPrivate(true);

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
                    if (cooldown >= slotSpeed) {
                        this.aiCooldowns.set(sessionId, 0);
                        this.moveAI(sessionId, player);
                    }
                }
            });
        }, 100);

        this.onMessage("move", (client, message) => {
            try {
                if (this.roundOver) return;
                const player = this.state.players.get(client.sessionId);
                if (!player || player.isAI) return;
                // Rate limit: max 20 moves/sec per client
                const now = Date.now();
                if (now - this.roundStartMs < GameRoom.MOVE_LOCK_MS) return;
                if (now - (this.lastMoveTime.get(client.sessionId) ?? 0) < GameRoom.RATE_LIMIT_MS) return;
                if (now < (this.frozenPlayers.get(client.sessionId) ?? 0)) return; // frozen
                this.lastMoveTime.set(client.sessionId, now);
                // Validate coordinates
                if (
                    typeof message?.x !== 'number' || typeof message?.y !== 'number' ||
                    !Number.isFinite(message.x) || !Number.isFinite(message.y) ||
                    message.x < 0 || message.x >= this.cols ||
                    message.y < 0 || message.y >= this.rows
                ) {
                    console.warn(`Invalid move from ${client.sessionId}:`, message);
                    return;
                }
                this.lastInputTime.set(client.sessionId, now);
                player.x = message.x;
                player.y = message.y;
                this.checkCollisions(player, client.sessionId);
            } catch (err) {
                console.error(`Move handler error for ${client.sessionId}:`, err);
            }
        });

        // Allows the host to drive unclaimed 'local' slots from the same machine (co-op)
        this.onMessage("move_secondary", (client, message) => {
            try {
                if (this.roundOver) return;
                if (Date.now() - this.roundStartMs < GameRoom.MOVE_LOCK_MS) return;
                if (client.sessionId !== this.ownerSessionId) return;
                const { slotIndex, x, y } = message;
                if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
                    console.warn(`Invalid move_secondary from ${client.sessionId}:`, message);
                    return;
                }
                const slot = this.state.slots[slotIndex];
                if (!slot || slot.mode !== 'local' || slot.sessionId !== '') return;
                const aiId = `ai_${slotIndex}`;
                const player = this.state.players.get(aiId);
                if (!player || !player.isAI) return;
                this.lastInputTime.set(client.sessionId, Date.now()); // host is active
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

        // Rocket hit: client reports that a rocket collided with a player.
        // rocketId+targetSessionId pair is deduped so multiple clients can't double-teleport the same victim.
        this.onMessage("rocket_hit", (client, message) => {
            try {
                const { rocketId, targetSessionId } = message;
                if (typeof rocketId !== 'string' || typeof targetSessionId !== 'string') return;
                if (this.roundOver) return;
                const key = `${rocketId}:${targetSessionId}`;
                if (this.usedRocketHits.has(key)) return;
                this.usedRocketHits.add(key);
                const target = this.state.players.get(targetSessionId);
                if (target) this.teleportPlayer(target);
            } catch (err) {
                console.error(`rocket_hit handler error:`, err);
            }
        });

        console.log(`Room created: ${this.roomId}`);
    }

    onJoin(client: Client, options: any) {
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
            this.explorerLastPos.delete(existingId);
            this.guesserData.delete(existingId);
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
        // Catch up a late joiner who missed the round_won broadcast during the countdown
        if (this.roundOver && this.lastRoundWon) {
            client.send("round_won", this.lastRoundWon);
        }
        console.log(`Client ${client.sessionId} assigned to slot ${assignedSlotIndex}`);
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
            const otherHumans = this.clients.filter(c => c.sessionId !== client.sessionId).length;
            if (otherHumans > 0) {
                try {
                    await this.allowReconnection(client, 8);
                    // Player reconnected — restore activity timestamp and keep playing
                    this.lastInputTime.set(client.sessionId, Date.now());
                    console.log(`Client ${client.sessionId} reconnected.`);
                    return;
                } catch {
                    console.log(`Client ${client.sessionId} reconnection window expired. Cleaning up.`);
                }
            }
        }

        // Player is truly leaving — clean up all tracking state
        this.lastInputTime.delete(client.sessionId);
        this.lastMoveTime.delete(client.sessionId);
        this.friendCodeJoiners.delete(client.sessionId);
        this.explorerLastPos.delete(client.sessionId);
        this.guesserData.delete(client.sessionId);
        this.aiCooldowns.delete(client.sessionId);

        const player = this.state.players.get(client.sessionId);
        if (player) {
            const slotIndex = player.slotIndex;
            const slot = this.state.slots[slotIndex];
            if (slot.mode === "ai_online" || slot.mode === "local" || slot.mode === "ai_friend") {
                this.convertPlayerToAI(client.sessionId, player, slotIndex);
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

        // Shut down if no human players remain (excluding this departing client)
        const remaining = this.clients.filter(c => c.sessionId !== client.sessionId);
        if (remaining.length === 0) {
            console.log(`Room ${this.roomId}: no players remain. Shutting down.`);
            this.disconnect();
        }
    }

    // --- Helpers ---

    /** Flat grid index for cell at (x, y). */
    private idx(x: number, y: number): number {
        return x * this.rows + y;
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

    // --- AI Navigation ---

    /** BFS from (goalX, goalY) through the maze; returns flat distance array indexed by idx(x, y). */
    computeDistanceMap(goalX: number, goalY: number): number[] {
        const map = new Array(this.cols * this.rows).fill(Infinity);
        map[this.idx(goalX, goalY)] = 0;
        const queue: { x: number; y: number }[] = [{ x: goalX, y: goalY }];
        while (queue.length > 0) {
            const curr = queue.shift()!;
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
        const behavior = this.state.slots[player.slotIndex]?.aiBehavior ?? "random";
        if (behavior === "explorer") {
            this.explorerLastPos.set(sessionId, { x: -1, y: -1 });
        } else if (behavior === "guesser") {
            // Pick a random target that isn't the goal
            let rx: number, ry: number;
            do {
                rx = Math.floor(Math.random() * this.cols);
                ry = Math.floor(Math.random() * this.rows);
            } while (rx === this.state.goalX && ry === this.state.goalY);
            this.guesserData.set(sessionId, {
                target: { x: rx, y: ry },
                distMap: this.computeDistanceMap(rx, ry),
            });
        }
    }

    moveAI(sessionId: string, player: Player) {
        if (Date.now() < (this.frozenPlayers.get(sessionId) ?? 0)) return; // frozen
        const slot = this.state.slots[player.slotIndex];
        let behavior = slot?.aiBehavior ?? "random";

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

        if (behavior === "explorer") {
            const last = this.explorerLastPos.get(sessionId) ?? { x: -1, y: -1 };

            // If no one else is closer to the goal, act focused
            const myDist = this.distanceMap[this.idx(player.x, player.y)];
            let minOtherDist = Infinity;
            this.state.players.forEach((other, sid) => {
                if (sid !== sessionId) {
                    const d = this.distanceMap[this.idx(other.x, other.y)];
                    if (d < minOtherDist) minOtherDist = d;
                }
            });

            if (myDist <= minOtherDist) {
                // Act focused
                for (const n of open) {
                    const d = this.distanceMap[this.idx(n.x, n.y)];
                    if (d < myDist && (!move || d < this.distanceMap[this.idx(move.x, move.y)])) move = n;
                }
            }

            if (!move) {
                // Prefer not backtracking
                const forward = open.filter(n => !(n.x === last.x && n.y === last.y));
                move = (forward.length > 0 ? forward : open)[Math.floor(Math.random() * (forward.length > 0 ? forward.length : open.length))];
            }

            this.explorerLastPos.set(sessionId, { x: player.x, y: player.y });

        } else if (behavior === "guesser") {
            const gd = this.guesserData.get(sessionId);
            if (gd && (player.x !== gd.target.x || player.y !== gd.target.y)) {
                // Navigate to guess target
                const currDist = gd.distMap[this.idx(player.x, player.y)];
                for (const n of open) {
                    const d = gd.distMap[this.idx(n.x, n.y)];
                    if (d < currDist && (!move || d < gd.distMap[this.idx(move.x, move.y)])) move = n;
                }
            }
            // If at target or no route, fall through to focused
            if (!move) behavior = "focused";
        }

        if (behavior === "focused" || (!move && behavior !== "explorer")) {
            // Greedy: step to open neighbour with smallest BFS distance to goal
            const currDist = this.distanceMap[this.idx(player.x, player.y)];
            for (const n of open) {
                const d = this.distanceMap[this.idx(n.x, n.y)];
                if (d < currDist && (!move || d < this.distanceMap[this.idx(move.x, move.y)])) move = n;
            }
        }

        if (behavior === "random" && !move) {
            move = open[Math.floor(Math.random() * open.length)];
        }

        // Final fallback: random (handles dead-ends with no improving move)
        if (!move) move = open[Math.floor(Math.random() * open.length)];

        player.x = move.x;
        player.y = move.y;
        this.checkCollisions(player, sessionId);
    }

    // --- Maze & Powerups ---

    generateMaze() {
        for (let x = 0; x < this.cols; x++) {
            for (let y = 0; y < this.rows; y++) {
                const cell = new Cell();
                cell.walls[0] = cell.walls[1] = cell.walls[2] = cell.walls[3] = true;
                this.state.grid.push(cell);
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
    }

    spawnPowerUps(options: any = {}) {
        this.state.powerUps.clear();
        this.usedRocketHits.clear();
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
        // Fisher-Yates shuffle both lists
        const shuffle = (arr: { x: number; y: number }[]) => {
            for (let i = arr.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [arr[i], arr[j]] = [arr[j], arr[i]];
            }
        };
        shuffle(deadEnds);
        shuffle(corridors);

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

        spawnFrom(deadEnds,  puOpp,     "opponents");
        spawnFrom(deadEnds,  puSelf,    "self");
        spawnFrom(deadEnds,  puRocket,  "rocket");
        spawnFrom(corridors, puMirror,  "mirror");  // on the critical path — players run into these naturally
        spawnFrom(corridors, puMystery, "mystery"); // mid-path so players encounter them during the race
        spawnFrom(deadEnds,  puFreeze,  "freeze");  // dead-ends — powerful, should be sought out
        spawnFrom(corridors, puBeacon,  "beacon");  // corridors — encountered naturally on the way to goal
    }

    // --- Collision & Teleport ---

    checkCollisions(player: Player, sessionId: string) {
        // Power-up pickup (always active)
        const puIndex = this.state.powerUps.findIndex(pu => pu.x === player.x && pu.y === player.y);
        if (puIndex !== -1) {
            const pu = this.state.powerUps[puIndex];
            this.state.powerUps.splice(puIndex, 1);
            if (pu.type === "opponents") {
                if (this.orbLeaderOnly) {
                    let leaderSid: string | null = null;
                    let minDist = Infinity;
                    this.state.players.forEach((p, sid) => {
                        if (sid === sessionId) return;
                        const d = this.getDistance(p.x, p.y);
                        if (d < minDist) { minDist = d; leaderSid = sid; }
                    });
                    if (leaderSid) {
                        const leaderPlayer = this.state.players.get(leaderSid);
                        if (leaderPlayer) this.teleportPlayer(leaderPlayer);
                    }
                } else {
                    this.state.players.forEach((p, sid) => {
                        if (sid !== sessionId) this.teleportPlayer(p);
                    });
                }
            } else if (pu.type === "self") {
                this.teleportPlayer(player);
            } else if (pu.type === "rocket") {
                // Rocket pickup: nothing to do server-side on collection.
                // All clients detect the power-up disappearing from state and spawn a local Rocket.
            } else if (pu.type === "mirror") {
                const targetClient = this.clients.find(c => c.sessionId === sessionId);
                if (targetClient) targetClient.send("mirror_controls", { duration: 3000, collectorSessionId: sessionId });
            } else if (pu.type === "freeze") {
                const freezeUntil = Date.now() + 3000;
                this.state.players.forEach((_p, sid) => {
                    if (sid !== sessionId) this.frozenPlayers.set(sid, freezeUntil);
                });
                this.broadcast("freeze", { collectorSessionId: sessionId, duration: 3000 });
            } else if (pu.type === "beacon") {
                this.broadcast("beacon", { collectorSessionId: sessionId, duration: 8000 });
            } else if (pu.type === "mystery") {
                const MYSTERY_TYPES = ["opponents", "self", "rocket", "mirror", "freeze", "beacon"] as const;
                const resolvedType = MYSTERY_TYPES[Math.floor(Date.now() / 200) % MYSTERY_TYPES.length];

                if (resolvedType === "opponents") {
                    if (this.orbLeaderOnly) {
                        let leaderSid: string | null = null, minDist = Infinity;
                        this.state.players.forEach((p, sid) => {
                            if (sid === sessionId) return;
                            const d = this.getDistance(p.x, p.y);
                            if (d < minDist) { minDist = d; leaderSid = sid; }
                        });
                        const lp = leaderSid ? this.state.players.get(leaderSid) : null;
                        if (lp) this.teleportPlayer(lp);
                    } else {
                        this.state.players.forEach((p, sid) => { if (sid !== sessionId) this.teleportPlayer(p); });
                    }
                } else if (resolvedType === "self") {
                    this.teleportPlayer(player);
                } else if (resolvedType === "mirror") {
                    const tc = this.clients.find(c => c.sessionId === sessionId);
                    if (tc) tc.send("mirror_controls", { duration: 3000, collectorSessionId: sessionId });
                } else if (resolvedType === "freeze") {
                    const freezeUntil = Date.now() + 3000;
                    this.state.players.forEach((_p, sid) => {
                        if (sid !== sessionId) this.frozenPlayers.set(sid, freezeUntil);
                    });
                    this.broadcast("freeze", { collectorSessionId: sessionId, duration: 3000 });
                } else if (resolvedType === "beacon") {
                    this.broadcast("beacon", { collectorSessionId: sessionId, duration: 8000 });
                }
                // "rocket" — no server-side action; client handles it via mystery_resolved

                this.broadcast("mystery_resolved", { x: pu.x, y: pu.y, resolvedType, collectorSessionId: sessionId });
            }
        }

        // Player-player collisions (respects lobby setting)
        if (this.collisions) {
            this.state.players.forEach((other, sid) => {
                if (sid !== sessionId && other.x === player.x && other.y === player.y) {
                    this.teleportPlayer(player);
                    this.teleportPlayer(other);
                }
            });
        }

        // Goal check
        if (player.x === this.state.goalX && player.y === this.state.goalY) {
            this.roundOver = true; // Freeze the game immediately
            player.score++;
            const isMatchWon = player.score >= 3;
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
                this.lock();
                // At 25 s: unlock so new players can join for the final 5-second window.
                this.clock.setTimeout(() => {
                    if (!this.matchComplete) return;
                    this.unlock();
                }, 25000);
                // At 30 s: reset scores, regenerate maze, broadcast match_reset.
                this.clock.setTimeout(() => {
                    if (!this.matchComplete) return;
                    this.state.players.forEach(p => { p.score = 0; });
                    this.matchComplete = false;
                    this.resetRound();
                    this.roundStartMs = Date.now();
                    this.broadcast("match_reset");
                }, 30000);
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
        this.state.grid.clear();
        this.generateMaze();
        this.distanceMap = this.computeDistanceMap(this.state.goalX, this.state.goalY);
        this.spawnPowerUps(this.spawnOptions);
        this.state.timer = 0;
        this.roundStartMs = Date.now();

        this.state.players.forEach((player, sessionId) => {
            const spawn = this.getSpawnPosition(player.slotIndex);
            player.x = spawn.x;
            player.y = spawn.y;
            this.aiCooldowns.set(sessionId, 0);
            if (player.isAI) this.initAIState(sessionId, player);
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
        // New maze
        this.state.grid.clear();
        this.generateMaze();
        this.distanceMap = this.computeDistanceMap(this.state.goalX, this.state.goalY);

        // Reset all player positions to starting corners
        this.state.players.forEach((player, sessionId) => {
            const i = player.slotIndex;
            const spawn = this.getSpawnPosition(i);
            player.x = spawn.x;
            player.y = spawn.y;
            this.aiCooldowns.set(sessionId, 0);
            // Re-init guesser/explorer state for AI
            if (player.isAI) this.initAIState(sessionId, player);
        });

        // Fresh power-ups using original lobby settings
        this.spawnPowerUps(this.spawnOptions);
        this.state.timer = 0;
        this.roundStartMs = Date.now();
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

    teleportPlayer(player: Player) {
        const startX = player.x, startY = player.y;
        let x = startX, y = startY;
        const maxAttempts = this.cols * this.rows * 4;
        let attempts = 0;
        do {
            x = Math.floor(Math.random() * this.cols);
            y = Math.floor(Math.random() * this.rows);
            attempts++;
        } while (
            attempts < maxAttempts &&
            (
                (x === startX && y === startY) ||
                this.isReservedCell(x, y) ||
                this.getDistance(x, y) <= 10 ||   // keep players away from the goal area
                this.state.powerUps.some((pu: PowerUp) => pu.x === x && pu.y === y) ||
                [...this.state.players.values()].some((p: Player) => p.x === x && p.y === y)
            )
        );
        player.x = x;
        player.y = y;
    }

    getDistance(x: number, y: number) {
        return this.distanceMap[this.idx(x, y)] ?? Infinity;
    }
}
