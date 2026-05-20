const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')

let mainWindow
let steamworks = null
let steamClient = null
let currentLobbyId = null

try {
  steamworks = require('steamworks.js')
} catch (e) {
  console.warn('steamworks.js not available:', e.message)
}

// Try to init Steam; silently degrade if Steam isn't running
if (steamworks) {
  try {
    // Use 480 (Valve's Spacewar test app) during development.
    // Replace with your real Steam App ID before shipping.
    steamClient = steamworks.init(480)
    console.log('Steam initialised. SteamID:', steamClient.localplayer.getSteamId().steamId64)

    // Steamworks requires manual callback polling
    setInterval(() => steamClient.runCallbacks(), 100)
  } catch (e) {
    console.warn('Steam not available — running without Steam features:', e.message)
  }
}

// Register the lobby-join callback separately so a failure here doesn't kill Steam entirely.
// Fires when the user accepts a Steam invite or clicks "Join Game" on a friend's profile.
if (steamClient) {
  try {
    steamClient.callback.register(steamworks.SteamCallback.GameLobbyJoinRequested, (data) => {
      const roomCode = steamClient.matchmaking.getLobbyData(data.steamIDLobby, 'roomCode')
      if (roomCode && mainWindow) {
        mainWindow.webContents.send('steam:join-requested', roomCode)
      }
    })
  } catch (e) {
    console.warn('Could not register lobby-join callback:', e.message)
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Blaze The Maze',
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'))
  mainWindow.setMenuBarVisibility(false)

  mainWindow.on('closed', () => { mainWindow = null })
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (currentLobbyId && steamClient) {
    steamClient.matchmaking.leaveLobby(currentLobbyId)
  }
  app.quit()
})

// ── IPC handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('steam:create-lobby', async (_event, roomCode) => {
  if (!steamClient) return null
  try {
    // 1 = FriendsOnly lobby type
    const lobby = await steamClient.matchmaking.createLobby(1, 8)
    steamClient.matchmaking.setLobbyData(lobby, 'roomCode', roomCode)
    currentLobbyId = lobby
    const lobbyIdStr = String(lobby)
    console.log('Steam lobby created:', lobbyIdStr, 'roomCode:', roomCode)
    return lobbyIdStr
  } catch (e) {
    console.warn('Failed to create Steam lobby:', e.message)
    return null
  }
})

ipcMain.handle('steam:join-lobby', async (_event, lobbyId) => {
  if (!steamClient) return
  try {
    await steamClient.matchmaking.joinLobby(lobbyId)
    currentLobbyId = lobbyId
    console.log('Joined Steam lobby:', lobbyId)
  } catch (e) {
    console.warn('Failed to join Steam lobby:', e.message)
  }
})

ipcMain.handle('steam:close-lobby', () => {
  if (!steamClient || !currentLobbyId) return
  try {
    steamClient.matchmaking.leaveLobby(currentLobbyId)
    console.log('Steam lobby closed:', currentLobbyId)
  } catch (e) {
    console.warn('Failed to close Steam lobby:', e.message)
  }
  currentLobbyId = null
})

ipcMain.handle('steam:set-rich-presence', (_event, status) => {
  if (!steamClient) return
  try {
    steamClient.friends.setRichPresence('steam_display', status)
    steamClient.friends.setRichPresence('status', status)
  } catch (e) {
    console.warn('Failed to set rich presence:', e.message)
  }
})
