import { Schema, ArraySchema, MapSchema, type } from "@colyseus/schema";

export class Cell extends Schema {
    @type([ "boolean" ]) walls = new ArraySchema<boolean>(true, true, true, true);
}

export class Player extends Schema {
    @type("string") id: string = "";
    @type("number") x: number = 0;
    @type("number") y: number = 0;
    @type("number") score: number = 0;
    @type("string") color: string = "#ffffff";
    @type("boolean") isAI: boolean = false;
    @type("number") slotIndex: number = -1;
    // Increments every time the server teleports this player (collision, power-up, rocket).
    // The client watches this to decide when to play the teleport animation, instead of
    // guessing from position displacement (which false-fires on prediction/patch lag).
    @type("number") teleportSeq: number = 0;
}

export class Slot extends Schema {
    @type("string") mode: string = "inactive"; // "inactive", "local", "ai_online", "ai_only", "ai_friend", "friend_only"
    @type("string") sessionId: string = "";
    @type("string") id: string = "";
    @type("string") color: string = "#ffffff";
    @type("number") aiSpeed: number = 600;     // ms between AI moves
    @type("string") aiBehavior: string = "random"; // "focused", "random", "guesser", "explorer"
    @type("string") controlScheme: string = "WASD"; // for local slots
}

export class PowerUp extends Schema {
    @type("number") x: number = 0;
    @type("number") y: number = 0;
    @type("string") type: string = ""; // "opponents", "self", "rocket", "mirror", "mystery", "freeze", "beacon"
}

export class GameState extends Schema {
    @type({ map: Player }) players = new MapSchema<Player>();
    @type([ Slot ]) slots = new ArraySchema<Slot>();
    @type("number") timer: number = 0;
    @type([ Cell ]) grid = new ArraySchema<Cell>();
    @type("number") cols: number = 20;
    @type("number") rows: number = 20;
    @type("number") goalX: number = 10;
    @type("number") goalY: number = 10;
    @type([ PowerUp ]) powerUps = new ArraySchema<PowerUp>();
    @type("string") steamLobbyId: string = "";
    @type("string") roomCode: string = "";
    // Round-over state — lets late joiners sync to the correct screen via onStateChange
    @type("boolean") roundOver: boolean = false;
    @type("boolean") matchOver: boolean = false;
    @type("string") lastWinnerId: string = "";
    @type("string") lastWinnerColor: string = "";
    @type("number") lastWinnerScore: number = 0;
    // Increments every time the maze is regenerated (new round / match reset).
    // The authoritative grid is delivered to clients via the reliable "grid_sync"
    // message (see GameRoom.broadcastGridSync); this counter is the fallback signal
    // the client's onStateChange uses to rebuild from schema state if a grid_sync was
    // ever missed (e.g. reconnection), so the two paths don't double-rebuild.
    @type("number") gridGeneration: number = 0;
}
