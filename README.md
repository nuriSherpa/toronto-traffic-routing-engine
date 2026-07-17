# Toronto Transit Bunching Detector — Server Setup

This is the foundational stack: a Node.js/Express server, PostgreSQL (with
PostGIS for geospatial queries), and Redis, all containerized with Docker
Compose.

## Prerequisites
- Docker Desktop (or Docker Engine + Compose plugin) installed and running.
- That's it — Node/Postgres/Redis all run inside containers, nothing else
  needs to be installed on your machine.

## Project layout
```
toronto-transit-bunching/
├── docker-compose.yml      # wires up postgres, redis, and the node server
├── .env                    # local env vars (already filled with working defaults)
├── .env.example            # template if you need to recreate .env
└── server/
    ├── Dockerfile
    ├── package.json
    ├── sql/init.sql        # schema, auto-run on first Postgres startup
    └── src/
        ├── index.js        # express entrypoint
        ├── db/pool.js      # postgres connection pool
        ├── db/redis.js     # redis client + simple cache-aside helper
        └── routes/
            ├── health.js   # GET /health -> checks postgres + redis
            ├── static.js   # GET /routes, /routes/:id/stops
            └── live.js     # GET /routes/:id/vehicles, /bunching-events
```

## Run it

From the `toronto-transit-bunching/` directory:

```bash
docker compose up --build
```

This will:
1. Start Postgres with the PostGIS extension, and automatically run
   `server/sql/init.sql` to create all tables (only happens the first time —
   Postgres skips init scripts on subsequent restarts if the data volume
   already exists).
2. Start Redis.
3. Build and start the Node server, waiting for both Postgres and Redis to
   report healthy before it starts (see `depends_on` + `healthcheck` in
   `docker-compose.yml`).

The server auto-reloads on file changes (`node --watch`) since `server/src`
is mounted as a volume — edit code locally and it picks it up without
rebuilding the image.

## Verify everything is connected

Once containers are up, in another terminal:

```bash
curl http://localhost:3000/health
```

Expected response:
```json
{"server":"ok","postgres":"ok","redis":"ok"}
```

If `postgres` or `redis` show `"error"`, check `docker compose logs postgres`
or `docker compose logs redis` — most common cause is the containers still
starting up (the healthchecks should handle this, but first boot can take a
few seconds longer while Postgres initializes the volume).

You can also confirm the schema was created:
```bash
docker compose exec postgres psql -U transit -d transit_bunching -c "\dt"
```
You should see `agencies`, `routes`, `stops`, `route_stops`, `shapes`,
`vehicle_snapshots`, and `bunching_events`.

## Stopping / resetting
```bash
docker compose down          # stop containers, keep data
docker compose down -v       # stop containers AND wipe the Postgres/Redis volumes
```

## What's next
Once you confirm `/health` returns all-ok, the next pieces to build are:
1. A static-data import script (populate `routes`/`stops`/`route_stops` from
   the Transit API — a one-time/occasional job, not something to poll
   repeatedly).
2. The live vehicle-position poller (respecting the 5 req/min, 3k/month
   budget) writing into `vehicle_snapshots`.
3. The headway/bunching computation job that reads `vehicle_snapshots` and
   writes `bunching_events`.
