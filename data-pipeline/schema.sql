CREATE TABLE IF NOT EXISTS job_snapshot (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    company TEXT NOT NULL,
    location_text TEXT NOT NULL,
    source TEXT NOT NULL,
    url TEXT NOT NULL,
    posted_date DATE,
    area TEXT NOT NULL,
    technologies TEXT[] NOT NULL DEFAULT '{}',
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    geo_precision TEXT NOT NULL DEFAULT 'none',
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_snapshot_posted_date ON job_snapshot (posted_date DESC);
CREATE INDEX IF NOT EXISTS idx_job_snapshot_area ON job_snapshot (area);
CREATE INDEX IF NOT EXISTS idx_job_snapshot_source ON job_snapshot (source);
CREATE INDEX IF NOT EXISTS idx_job_snapshot_technologies ON job_snapshot USING GIN (technologies);
