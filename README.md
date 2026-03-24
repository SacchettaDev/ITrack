# ITrack

Full-stack tech market dashboard for Ottawa/Gatineau/Kanata.

This repository contains:
- `frontend`: React + Vite dashboard UI
- `backend`: C# ASP.NET Core API (`ITrack.api`)
- `data-pipeline`: Python pipeline to ingest curated/scraped jobs into PostgreSQL (`job_snapshot`)

Live: https://itrack.sacchetta.dev
*Home Made Linux Server*
## Architecture

```text
ITrack/
├── frontend/        # React app (map, filters, KPIs, charts)
├── backend/         # .NET API (summary, jobs, region filters)
└── data-pipeline/   # ETL/import scripts for snapshot data
```

## Tech Stack

- **Frontend:** React 19, Vite 7, Leaflet, React Leaflet, CSS
- **Backend:** C# + ASP.NET Core (.NET 10), Npgsql, Swashbuckle
- **Data:** PostgreSQL + Python ingestion pipeline

## Quick Start (Local)

### 1) Start backend API

```bash
cd backend/ITrack.api
dotnet run
```



### 2) Start frontend

```bash
cd frontend
npm install
npm run dev
```

Open:
- http://localhost:5173

The frontend uses `/api/market` and Vite proxy routes `/api/*` to `http://localhost:5106`.

## Data Pipeline (Snapshot DB)

From `data-pipeline`:

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
```

Run snapshot pipeline:

```bash
python run_pipeline.py
```

For curated import reset (replace all `job_snapshot` rows):

```powershell
python import_curated_sets.py --replace-all
```

Detailed pipeline instructions:
- `data-pipeline/README.md`

## Production Build

Frontend:

```bash
cd frontend
npm run build
```

Output:
- `frontend/dist`

## Notes

- The dashboard is map-driven (center + radius filtering).
- Region presets and area/technology filters are applied via API query params.
- If deployed without Vite proxy, set `VITE_API_BASE_URL` in `frontend/.env.local`.
