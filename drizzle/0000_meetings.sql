CREATE TABLE meetings (
  id TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('manual', 'cloud')),
  filename TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'ready', 'error', 'duplicate')),
  stage TEXT CHECK (stage IN ('download', 'transcription', 'analysis')),
  cloud_url TEXT,
  checksum TEXT,
  transcript TEXT,
  summary TEXT,
  error TEXT,
  duplicate_of TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT
);
--> statement-breakpoint
CREATE UNIQUE INDEX meetings_one_processing ON meetings(owner) WHERE status = 'processing';
--> statement-breakpoint
CREATE INDEX meetings_owner_created ON meetings(owner, created_at DESC);
--> statement-breakpoint
CREATE INDEX meetings_cloud_checksum ON meetings(owner, checksum) WHERE status = 'ready' AND source = 'cloud';
