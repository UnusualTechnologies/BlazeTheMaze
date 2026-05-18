import { Room } from "colyseus";
import { type Client } from "@colyseus/core";
import { GameState, Player, Cell, PowerUp, Slot } from "./GameState.js";

export class GameRoom extends Room<{ state: GameState }> {
    maxClients = 8;
    cols = 20;
    rows = 20;
    collisions = true;
    spawnOptions: any = {};

    // BFS distance map from goal — flat array indexed [x * rows + y]
    distanceMap: number[] = [];
    // Tracks which connected sessionIds joined via friend code (cannot be kicked)
    friendCodeJoiners = new Set<string>();
    // Per-AI session state (not broadcast)
    aiCooldowns = new Map<string, number>();
    explorerLastPos = new Map<string, { x: number; y: number }>();
    guesserData = new Map<string, { target: { x: number; y: number }; distMap: number[] }>();
    // Freeze simulation while waiting for round reset
    roundOver: boolean = false;
    // True once a match is won; blocks new joins until someone with the code restarts
    matchComplete: boolean = false;
    // Last input timestamp per human sessionId — used for idle kick
    lastInputTime = new Map<string, number>();
    static readonly IDLE_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

    // --- Lifecycle ---

    onCreate(options: any) {
        // Use an unambiguous uppercase-only room ID
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let customId = '';
        for (let i = 0; i < 9; i++) customId += chars.charAt(Math.floor(Math.random() * chars.length));
        this.roomId = customId;

        this.cols = Math.max(5, Number(options.cols) || 20);
        this.rows = Math.max(5, Number(options.rows) || 20);
        this.collisions = options.collisions !== false; // default true

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

        this.spawnOptions = options;
        this.setState(state);
        this.generateMaze();
        this.spawnPowerUps(options);

        // BFS distance map must be computed after maze is generated
        this.distanceMap = this.computeDistanceMap(state.goalX, state.goalY);

        // Pre-compute guesser targets for any guesser AI slots
        state.players.forEach((player, sid) => {
            if (player.isAI) this.initAIState(sid, player);
        });

        if (options.isPrivate) this.setPrivate(true);

        this.setSimulationInterval((dt) => {
            if (this.roundOver) return; // Freeze everything during round-over countdown
            this.state.timer += dt / 1000;

            // Idle kick: disconnect human players with no input for 3 minutes
            const now = Date.now();
            for (const client of [...this.clients]) {
                const last = this.lastInputTime.get(client.sessionId);
                if (last !== undefined && now - last > GameRoom.IDLE_TIMEOUT_MS) {
                    this.lastInputTime.delete(client.sessionId);
                    client.leave(4003);
                }
            }

            this.state.players.forEach((player, sessionId) => {
                if (player.isAI) {
                    // 'local' slots are meant for human co-op on the host machine — skip AI
                    if (this.state.slots[player.slotIndex]?.mode === 'local') return;
                    const cooldown = (this.aiCooldowns.get(sessionId) ?? 0) + dt;
                    this.aiCooldowns.set(sessionId, cooldown);
                    const slotSpeed = this.state.slots[player.slotIndex]?.aiSpeed ?? 600;
                    if (cooldown >= slotSpeed) {
                        this.aiCooldowns.set(sessionId, 0);
                        this.moveAI(sessionId, player);
                    }
                }
            });
        });

        this.onMessage("move", (client, message) => {
            if (this.roundOver) return; // Reject moves during round-over countdown
            const player = this.state.players.get(client.sessionId);
            if (!player || player.isAI) return;
            this.lastInputTime.set(client.sessionId, Date.now());
            player.x = message.x;
            player.y = message.y;
            this.checkCollisions(player, client.sessionId);
        });

        // Allows the host to drive unclaimed 'local' slots from the same machine (co-op)
        this.onMessage("move_secondary", (client, message) => {
            if (this.roundOver) return;
            const { slotIndex, x, y } = message;
            const slot = this.state.slots[slotIndex];
            if (!slot || slot.mode !== 'local' || slot.sessionId !== '') return;
            const aiId = `ai_${slotIndex}`;
            const player = this.state.players.get(aiId);
            if (!player || !player.isAI) return;
            this.lastInputTime.set(client.sessionId, Date.now()); // host is active
            player.x = x;
            player.y = y;
            this.checkCollisions(player, aiId);
        });

        console.log(`Room created: ${this.roomId}`);
    }

    onJoin(client: Client, options: any) {
        console.log(`Client ${client.sessionId} joining...`);

        const joinedViaCode = !!options.joinedViaCode;
        const isHost = this.clients.length === 1;

        if (this.matchComplete) {
            if (!joinedViaCode) throw new Error("MATCH_OVER");
            // First friend-code joiner after match end restarts the game for everyone
            for (const c of [...this.clients]) {
                if (c.sessionId !== client.sessionId) c.leave(4002);
            }
            this.resetMatch();
            this.matchComplete = false;
            this.unlock();
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
        console.log(`Client ${client.sessionId} assigned to slot ${assignedSlotIndex}`);
    }

    onLeave(client: Client, _code?: number) {
        this.lastInputTime.delete(client.sessionId);
        this.friendCodeJoiners.delete(client.sessionId);
        const player = this.state.players.get(client.sessionId);
        if (player) {
            const slotIndex = player.slotIndex;
            const slot = this.state.slots[slotIndex];
            if (slot.mode === "ai_online" || slot.mode === "local") {
                const aiId = `ai_${slotIndex}`;
                player.isAI = true;
                slot.sessionId = "";
                this.state.players.delete(client.sessionId);
                this.state.players.set(aiId, player);
                this.initAIState(aiId, player);
                console.log(`Player ${client.sessionId} left. AI taking over slot ${slotIndex}.`);
            } else if (slot.mode === "ai_friend") {
                const aiId = `ai_${slotIndex}`;
                player.isAI = true;
                slot.sessionId = "";
                this.state.players.delete(client.sessionId);
                this.state.players.set(aiId, player);
                this.initAIState(aiId, player);
                console.log(`Friend left slot ${slotIndex}. AI resuming.`);
            } else if (slot.mode === "friend_only") {
                slot.sessionId = "";
                this.state.players.delete(client.sessionId);
            }
        }

        // Shut down if no human players remain (excluding this departing client)
        const remaining = this.clients.filter(c => c.sessionId !== client.sessionId);
        if (remaining.length === 0) {
            console.log(`Room ${this.roomId}: no players remain. Shutting down.`);
            this.disconnect();
        }
    }

    // --- AI Navigation ---

    /** BFS from (goalX, goalY) through the maze; returns flat [x*rows+y] distance array. */
    computeDistanceMap(goalX: number, goalY: number): number[] {
        const map = new Array(this.cols * this.rows).fill(Infinity);
        map[goalX * this.rows + goalY] = 0;
        const queue: { x: number; y: number }[] = [{ x: goalX, y: goalY }];
        const dirs = [
            { dx: 0, dy: -1, wall: 0 },
            { dx: 1,  dy: 0, wall: 1 },
            { dx: 0,  dy: 1, wall: 2 },
            { dx: -1, dy: 0, wall: 3 },
        ];
        while (queue.length > 0) {
            const curr = queue.shift()!;
            const cell = this.state.grid[curr.x * this.rows + curr.y];
            const currDist = map[curr.x * this.rows + curr.y];
            for (const d of dirs) {
                const nx = curr.x + d.dx, ny = curr.y + d.dy;
                if (nx >= 0 && nx < this.cols && ny >= 0 && ny < this.rows && !cell.walls[d.wall]) {
                    const ni = nx * this.rows + ny;
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
        const slot = this.state.slots[player.slotIndex];
        let behavior = slot?.aiBehavior ?? "random";

        const cell = this.state.grid[player.x * this.rows + player.y];
        const dirs = [
            { dx: 0, dy: -1, wall: 0 },
            { dx: 1,  dy: 0, wall: 1 },
            { dx: 0,  dy: 1, wall: 2 },
            { dx: -1, dy: 0, wall: 3 },
        ];

        // Collect open neighbours
        const open = dirs
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
            const myDist = this.distanceMap[player.x * this.rows + player.y];
            let minOtherDist = Infinity;
            this.state.players.forEach((other, sid) => {
                if (sid !== sessionId) {
                    const d = this.distanceMap[other.x * this.rows + other.y];
                    if (d < minOtherDist) minOtherDist = d;
                }
            });

            if (myDist <= minOtherDist) {
                // Act focused
                for (const n of open) {
                    const d = this.distanceMap[n.x * this.rows + n.y];
                    if (d < myDist && (!move || d < this.distanceMap[move.x * this.rows + move.y])) move = n;
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
                const currDist = gd.distMap[player.x * this.rows + player.y];
                for (const n of open) {
                    const d = gd.distMap[n.x * this.rows + n.y];
                    if (d < currDist && (!move || d < gd.distMap[move.x * this.rows + move.y])) move = n;
                }
            }
            // If at target or no route, fall through to focused
            if (!move) behavior = "focused";
        }

        if (behavior === "focused" || (!move && behavior !== "explorer")) {
            // Greedy: step to open neighbour with smallest BFS distance to goal
            const currDist = this.distanceMap[player.x * this.rows + player.y];
            for (const n of open) {
                const d = this.distanceMap[n.x * this.rows + n.y];
                if (d < currDist && (!move || d < this.distanceMap[move.x * this.rows + move.y])) move = n;
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
            const dirs = [
                { x: 0, y: -1, wall: 0, oppWall: 2 },
                { x: 1,  y: 0, wall: 1, oppWall: 3 },
                { x: 0,  y: 1, wall: 2, oppWall: 0 },
                { x: -1, y: 0, wall: 3, oppWall: 1 },
            ];
            for (const d of dirs) {
                const nx = curr.x + d.x, ny = curr.y + d.y;
                if (nx >= 0 && nx < this.cols && ny >= 0 && ny < this.rows && !visited.has(`${nx},${ny}`)) {
                    neighbors.push({ x: nx, y: ny, wall: d.wall, oppWall: d.oppWall });
                }
            }
            if (neighbors.length > 0) {
                const next = neighbors[Math.floor(Math.random() * neighbors.length)];
                this.state.grid[curr.x * this.rows + curr.y].walls[next.wall] = false;
                this.state.grid[next.x * this.rows + next.y].walls[next.oppWall] = false;
                visited.add(`${next.x},${next.y}`);
                stack.push({ x: next.x, y: next.y });
            } else {
                stack.pop();
            }
        }
    }

    spawnPowerUps(options: any = {}) {
        this.state.powerUps.clear();
        const puOpp    = options.puOpp    !== undefined ? Number(options.puOpp)    : 10;
        const puSelf   = options.puSelf   !== undefined ? Number(options.puSelf)   : 10;
        const puRocket = options.puRocket !== undefined ? Number(options.puRocket) : 0;

        const spawn = (count: number, type: string) => {
            if (isNaN(count) || count <= 0) return;
            for (let i = 0; i < count; i++) {
                const pu = new PowerUp();
                let x: number, y: number;
                do {
                    x = Math.floor(Math.random() * this.cols);
                    y = Math.floor(Math.random() * this.rows);
                } while (
                    this.isReservedCell(x, y) ||
                    this.state.powerUps.some((pu: PowerUp) => pu.x === x && pu.y === y)
                );
                pu.x = x;
                pu.y = y;
                pu.type = type;
                this.state.powerUps.push(pu);
            }
        };

        spawn(puOpp, "opponents");
        spawn(puSelf, "self");
        spawn(puRocket, "rocket");
    }

    // --- Collision & Teleport ---

    checkCollisions(player: Player, sessionId: string) {
        // Power-up pickup (always active)
        const puIndex = this.state.powerUps.findIndex(pu => pu.x === player.x && pu.y === player.y);
        if (puIndex !== -1) {
            const pu = this.state.powerUps[puIndex];
            this.state.powerUps.splice(puIndex, 1);
            if (pu.type === "opponents") {
                this.state.players.forEach((p, sid) => {
                    if (sid !== sessionId) this.teleportPlayer(p);
                });
            } else if (pu.type === "self") {
                this.teleportPlayer(player);
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
            this.broadcast("round_won", {
                winnerId: player.id,
                winnerColor: player.color,
                winnerScore: player.score,
                isMatchWon,
            });
            if (isMatchWon) {
                this.matchComplete = true;
                this.lock();
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
            const slot = this.state.slots[slotIndex];
            const aiId = `ai_${slotIndex}`;
            player.isAI = true;
            player.score = 0;
            slot.sessionId = "";
            this.state.players.delete(sessionId);
            this.state.players.set(aiId, player);
            this.initAIState(aiId, player);
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

        this.state.players.forEach((player, sessionId) => {
            const spawn = this.getSpawnPosition(player.slotIndex);
            player.x = spawn.x;
            player.y = spawn.y;
            this.aiCooldowns.set(sessionId, 0);
            if (player.isAI) this.initAIState(sessionId, player);
        });
    }

    resetRound() {
        this.roundOver = false; // Unfreeze before applying new state
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
        let x: number, y: number;
        do {
            x = Math.floor(Math.random() * this.cols);
            y = Math.floor(Math.random() * this.rows);
        } while (
            (x === startX && y === startY) ||
            this.isReservedCell(x, y) ||
            this.state.powerUps.some((pu: PowerUp) => pu.x === x && pu.y === y) ||
            [...this.state.players.values()].some((p: Player) => p.x === x && p.y === y)
        );
        player.x = x;
        player.y = y;
    }

    getDistance(x: number, y: number) {
        return this.distanceMap[x * this.rows + y] ?? Infinity;
    }
}
