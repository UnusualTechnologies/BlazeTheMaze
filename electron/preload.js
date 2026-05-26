const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  createSteamLobby:  (roomCode) => ipcRenderer.invoke('steam:create-lobby', roomCode),
  joinSteamLobby:    (lobbyId)  => ipcRenderer.invoke('steam:join-lobby', lobbyId),
  closeSteamLobby:   ()         => ipcRenderer.invoke('steam:close-lobby'),
  setRichPresence:    (status)   => ipcRenderer.invoke('steam:set-rich-presence', status),
  unlockAchievement:  (apiName)  => ipcRenderer.invoke('steam:unlock-achievement', apiName),
  // cb(roomCode) is called when a friend accepts an invite or clicks Join Game
  onSteamJoinRequest: (cb)      => ipcRenderer.on('steam:join-requested', (_event, roomCode) => cb(roomCode))
})
