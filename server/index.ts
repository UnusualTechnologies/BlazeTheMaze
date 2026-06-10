import colyseus, { listen } from "@colyseus/tools";
import cors from "cors";
import { GameRoom } from "./GameRoom.js";
import { Encoder } from "@colyseus/schema";
// Default 8 KB is too small for a full maze grid patch (can be 30+ KB for 20×20).
// Colyseus auto-resizes but spams a console warning every game start — silence it.
(Encoder as any).BUFFER_SIZE = 64 * 1024; // 64 KB

listen(colyseus({
    options: {
        devMode: false,
        gracefullyShutdown: false,
    },
    initializeGameServer: (gameServer) => {
        gameServer.define("game", GameRoom);
    },
    initializeExpress: (app) => {
        app.use(cors());
    }
}));
