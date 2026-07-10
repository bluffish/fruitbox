# Multiplayer blueprint

## First mode: private group room

One to eight players join a private room, receive the same generated 10×17 board, and race for 120 seconds. A room may start with one player for practice or testing. Each player has an independent board and score. The higher verified score wins; a full-board clear wins ties by the faster server-recorded completion time. If no one clears and the top scores tie, the room result is a draw.

This is deliberately not co-op. A shared board introduces simultaneous-move conflicts, turn rules, and a different scoring model, so it should be a later mode rather than a compromise in the first release.

## Player flow

```text
Create room → share room link → friends join → arm room → everyone ready → 5-second countdown → play → result
```

- **Create room:** creates an open room with a six-character join code and a maximum of eight seats.
- **Discover or share:** friends can click the host's name in the open-room list, copy a URL such as `/room/AB12CD`, or enter the code manually.
- **Open lobby:** friends can join, leave, and choose a ready state. The host sees the roster and can set the room to *start when ready*.
- **Armed lobby:** no additional players may join. When every seated player is ready, the server begins a five-second countdown.
- **Countdown:** server chooses a start timestamp ahead of time, so every browser begins on the same clock.
- **Play:** each player sees their own identical board plus a compact, live-sorted score list for the room.
- **Result:** winner, room standings, persistent room-series win counts, and a rematch button that remains accessible during missed-move review. Each completed player result also enters the normal global leaderboard as a verified run.

The host must arm the room before readiness can trigger a countdown. This prevents a room from unexpectedly starting while a friend is still opening the invite link.

## Server authority

The server owns the room seed, start time, player seats, move validation, and final result. The browser may render optimistically, but every move is sent to the server and validated against that player's current board before its score is broadcast.

Move messages contain a monotonic move ID and the selected rectangle's cells. The shared game engine should expose a single `applyMove(board, cells)` function used by both solo replay verification and multiplayer validation.

```text
browser selection
  → WebSocket move message
  → server validates rectangle + sum + board state
  → server broadcasts updated room standings
```

## Room state

```text
open → armed → countdown → live → finished → archived
```

| State | Server behavior |
| --- | --- |
| open | Accept 1–8 players, allow roster changes and ready toggles. |
| armed | Lock the roster; begin a countdown automatically when every seat is ready. |
| countdown | Announce the server start time; a player becoming unready returns the room to armed. |
| live | Validate moves, broadcast room standings, reject late/duplicate moves. |
| finished | Finalize every verified run and publish standings. |
| archived | Keep match history briefly; then retain only normal leaderboard runs. |

## Data model

The existing `players` and `runs` tables stay in place. Add:

```text
matches
  id, join_code, host_player_id, max_players, seed, status, created_at, starts_at, finished_at

match_players
  match_id, player_id, seat, ready, reconnect_token, score, completion_ms

match_moves
  match_id, player_id, move_id, moved_at, cells_json
```

The database is the durable match record. Active room state may live in process memory initially, provided a server restart marks active rooms as cancelled instead of inventing a result.

## Reconnection and fairness

- Each seat gets a private reconnect token stored in local storage.
- A reconnecting player can resume during a live match; the server sends their current board and room standings.
- The server accepts moves only after `starts_at` and before the shared deadline.
- Score updates use server validation, not a client-provided score.
- Private rooms come first. Public matchmaking, ratings, spectators, team play, and chat are intentionally out of scope.

## Implementation order

1. Refactor the shared game engine to validate and apply one move.
2. Add match tables and private-room HTTP endpoints.
3. Add a WebSocket server and the open/armed waiting-room state machine.
4. Build the group lobby, live standings, and reconnect flow.
5. Finalize room results into the existing global leaderboard.

## UI direction

Keep the current solo board untouched. Multiplayer adds a small `Room` entry point, a sparse ready-room roster, and a compact live standings list during play. The board remains the visual focus.
