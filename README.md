# FSD Sightings Logger

Mobile-first web app to log Tesla FSD roadside sightings (Central Florida).

Built for Atlas local use — rough draft for Samuel Dickinson.

## Start

```bash
cd /workspace/fsd-logger
npm install
npm start
```

Server listens on **port 8787** (override with `PORT=...`).

Open on this machine: [http://127.0.0.1:8787](http://127.0.0.1:8787)

On a phone on the same LAN: `http://<Atlas-LAN-IP>:8787`  
(Atlas/host networking must allow inbound on 8787.)

## UX

1. **Log** tab — today’s date in `America/New_York` (auto-flips after midnight ET).
2. Large **Saw a Tesla** → **FSD active** / **FSD not active**.
3. Confirmation toast + running today totals; **Undo last** for mis-taps.
4. **Stats** tab — daily table + week chart (Bolt `single_combined_bars` style).

## Data paths

| File | Path |
|------|------|
| Event log (JSONL) | `/workspace/fsd-logger/data/events.jsonl` |
| Daily rollup CSV | `/workspace/fsd-logger/data/tesla_fsd_observations.csv` |

### Event schema (append)

```json
{ "id": "uuid", "timestamp": "ISO-8601", "date": "YYYY-MM-DD", "fsd_active": true }
```

`date` is the America/New_York calendar day of the sighting.

### CSV schema (upsert by date)

```
date,teslas_seen,fsd_count,fsd_rate_pct
```

- Each event: `+1` teslas_seen; if `fsd_active`, `+1` fsd_count  
- `fsd_rate_pct = round(100 * fsd_count / teslas_seen, 1)`

Seeded when empty:

```
2026-09-10,7,3,42.9
2026-09-11,10,3,30.0
```

## API

| Method | Path | Body / notes |
|--------|------|----------------|
| POST | `/api/sighting` | `{ "fsd_active": boolean }` |
| POST | `/api/undo` | undo last event |
| GET | `/api/daily` | daily rollup rows |
| GET | `/api/events` | full event log |
| GET | `/api/export.csv` | download CSV |
| GET | `/api/stats` | week + all-time summary |
| GET | `/api/today` | ET date + today’s totals |

### Sample curl

```bash
curl -s -X POST http://127.0.0.1:8787/api/sighting \
  -H 'Content-Type: application/json' \
  -d '{"fsd_active":true}'

curl -s http://127.0.0.1:8787/api/export.csv

curl -s -X POST http://127.0.0.1:8787/api/undo
```

## Stack

- Node.js + Express (single dependency)
- Static mobile UI + Chart.js (CDN)
- No database — JSONL + CSV on disk
