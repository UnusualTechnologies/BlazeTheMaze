# Neon Bug Race - Project Context

## Overview
A high-speed multiplayer maze racing game using Colyseus for networking and Canvas for rendering.

## Versioning System
We use a strict `x.y.z` versioning system tracked in `version.json` and displayed in `index.html`.

### Rules
1. **Patch Increment (`z`):** Every code change or bug fix MUST increment the `patch` version.
   - Run: `.\build.ps1 -Type patch`
2. **Minor Increment (`y`):** Every "Build" or major feature release MUST increment the `minor` version and reset the `patch` to 0.
   - Run: `.\build.ps1 -Type minor`
3. **Display:** The version is shown in the bottom right of the UI via the `<div id="version-number">` in `index.html`.

## Tech Stack
- **Frontend:** Vanilla JavaScript, HTML5 Canvas, CSS.
- **Backend:** Colyseus (Node.js/TypeScript).
- **Communication:** WebSockets via Colyseus SDK.

## Key Files
- `index.html`: Main game logic, rendering, and UI.
- `server/GameRoom.ts`: Server-side game state and logic.
- `build.ps1`: Version management script.
- `version.json`: Current version source of truth.

## File Editing Rules
- **Always edit `D:\Projects\Maze\MazePrototype\index.html` directly** — never edit the worktree copy at `.claude\worktrees\*\index.html`.
- When the user asks to "update the .md" or refers to updating a project context file, always update `AGENTS.md` (this file).

## Development Workflow
- When fixing bugs or adding small features, run the build script with `-Type patch`.
- Before a major push or "build" event, run with `-Type minor`.
- Always verify that `index.html` reflects the updated version string.

## Version Control
- Use the main branch for all commits and pushes unless explicitly asked not to.
- Commit locally after each prompt with a code change.
- Ask before pushing to the main repo. Proactively suggest a commit and push when either of these conditions are met:
1.We have completed a major feature or resolved a major bug.
2.We have changed roughly 150+ lines of code since our last commit.
When suggesting a push, provide a brief bulleted summary of what we've done so I can review it.

## Colyseus Cloud Server Deployment
- The live Colyseus server runs on Colyseus Cloud at `wss://gb-lhr-5b4d543b.colyseus.cloud`.
- **Deploying the server = pushing to GitHub (main branch).** Colyseus Cloud auto-deploys on push.
- Any changes to `server/GameRoom.ts`, `server/GameState.ts`, or other server files are NOT live until pushed.
- When server files are changed, always remind the user to push so the cloud server picks up the changes.
- Server credentials are in `server/.colyseus-cloud.json` (applicationId: `1505-maze`).

## Steam Build Pipeline (IN PROGRESS — pick up here next session)

An automated Steam deploy pipeline has been partially set up. **Do not re-explain what was done — just resume from the next step below.**

### What is already done
- `game-ci/steam-deploy@v3` GitHub Actions workflow created at `.github/workflows/steam-deploy.yml`
- SteamPipe VDF configs created at `scripts/app_build.vdf` and `scripts/depot_build.vdf`
- Steam App ID: `4734010`, Depot ID: `4734011`
- Dedicated Steam build account: `automatedbuild` (added to Steamworks with Edit/Publish permissions)
- SteamCMD installed on dev machine at `C:\steamcmd\`
- WSL (Ubuntu) installed on dev machine — SteamCMD also set up inside WSL at `~/steamcmd/`
- GitHub Secrets already set: `STEAM_USERNAME`, `STEAM_PASSWORD`
- Workflow updated to use `totp:` auth (TOTP shared secret) — `STEAM_CONFIG_VDF` approach was abandoned as it failed cross-platform

### What is NOT done yet (next step)
The pipeline is blocked on Steam auth. The fix is to use **Steam Desktop Authenticator (SDA)** to get a TOTP shared secret:

1. Download SDA: **github.com/Jessecar96/SteamDesktopAuthenticator/releases**
2. Run `Steam Desktop Authenticator.exe` → **Setup New Account** → log in as `automatedbuild`
3. Enter the Steam Guard email code when prompted — this switches the account to TOTP auth
4. Open `maFiles/automatedbuild.maFile` in Notepad, copy the `shared_secret` value
5. Add it as GitHub Secret named `STEAM_TOTP` on the MazePrototype repo
6. Re-trigger the pipeline: delete and re-push the `v1.5.32` tag (or create a new one)

### Pipeline trigger
Tag any commit with `v*` (e.g. `git tag v1.5.33 && git push origin v1.5.33`) to trigger a Steam build and upload. GitHub Pages deploy on push to master is unaffected — it runs independently.