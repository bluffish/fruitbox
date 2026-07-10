# Fruitbox

A two-minute, server-verified Fruit Box-style number puzzle with an all-time leaderboard across all generated boards.

## Run locally

In one terminal, start the API and persistent SQLite database:

```bash
npm run dev:api
```

In a second terminal, start the Vite client:

```bash
npm run dev
```

The Vite server proxies `/api` requests to the local API service.

## Run on the server

Build the site, then start the application server:

```bash
npm run build
npm start
```

It listens on `127.0.0.1:3000` by default. Set `PORT` or `HOST` if needed. The SQLite database is kept at `data/fruitbox.sqlite`; back up that file to retain the leaderboard. A signing secret is created and retained in the same ignored directory on the first run; `LEADERBOARD_SECRET` may be set to manage it explicitly.

## Verification

Each run receives a unique server-generated board seed. The client submits its selected rectangles at the end of the run. The server rebuilds the board, validates every rectangle and total, calculates the score, then stores verified runs only. The leaderboard contains every verified run: players may hold multiple positions; ties sort by faster clear time, then earlier submission time.
