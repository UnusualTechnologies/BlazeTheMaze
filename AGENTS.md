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
- Commit locally after each prompt with a code change.
- Ask before pushing to the main repo. Proactively suggest a commit and push when either of these conditions are met:
1.We have completed a major feature or resolved a major bug.
2.We have changed roughly 150+ lines of code since our last commit.
When suggesting a push, provide a brief bulleted summary of what we've done so I can review it.