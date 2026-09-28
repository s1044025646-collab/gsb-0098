export interface Migration {
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    name: "0001_init",
    sql: `
CREATE TABLE IF NOT EXISTS agencies(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact TEXT
);
CREATE TABLE IF NOT EXISTS applicants(
  id TEXT PRIMARY KEY,
  alias TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requests(
  id TEXT PRIMARY KEY,
  applicant_id TEXT NOT NULL REFERENCES applicants(id),
  agency_id TEXT NOT NULL REFERENCES agencies(id),
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  received_at TEXT NOT NULL,
  due_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS request_versions(
  request_id TEXT NOT NULL REFERENCES requests(id),
  version INTEGER NOT NULL,
  scope_text TEXT NOT NULL,
  channel TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(request_id, version)
);
CREATE TABLE IF NOT EXISTS request_events(
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  payload TEXT
);
CREATE TABLE IF NOT EXISTS documents(
  id TEXT PRIMARY KEY,
  agency_id TEXT NOT NULL REFERENCES agencies(id),
  catalog_no TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS document_segments(
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  seq INTEGER NOT NULL,
  content TEXT NOT NULL,
  UNIQUE(document_id, seq)
);
CREATE TABLE IF NOT EXISTS search_tasks(
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  assignee TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS reviews(
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  document_id TEXT NOT NULL REFERENCES documents(id),
  reviewer TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS extensions(
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  days INTEGER NOT NULL,
  reason TEXT NOT NULL,
  approver TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS responses(
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  summary TEXT,
  created_at TEXT NOT NULL,
  superseded_by TEXT
);
CREATE TABLE IF NOT EXISTS response_items(
  id TEXT PRIMARY KEY,
  response_id TEXT NOT NULL REFERENCES responses(id),
  document_id TEXT NOT NULL REFERENCES documents(id),
  disposition TEXT NOT NULL,
  basis TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS segment_decisions(
  id TEXT PRIMARY KEY,
  response_id TEXT NOT NULL REFERENCES responses(id),
  segment_id TEXT NOT NULL REFERENCES document_segments(id),
  disposition TEXT NOT NULL,
  basis TEXT NOT NULL,
  redactions TEXT
);
CREATE TABLE IF NOT EXISTS deliveries(
  id TEXT PRIMARY KEY,
  response_id TEXT NOT NULL REFERENCES responses(id),
  channel TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  delivered_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reconsiderations(
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  response_id TEXT NOT NULL REFERENCES responses(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  decision TEXT,
  decision_text TEXT,
  new_response_id TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE TABLE IF NOT EXISTS holidays(
  day TEXT PRIMARY KEY
);
CREATE INDEX IF NOT EXISTS idx_events_request ON request_events(request_id);
CREATE INDEX IF NOT EXISTS idx_segments_doc ON document_segments(document_id);
`,
  },
];
