import colyseus, { listen } from "@colyseus/tools";
import cors from "cors";
import { GameRoom } from "./GameRoom.js";

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
