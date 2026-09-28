-- 初始结构：所有对象使用 IF NOT EXISTS，可重复执行。
-- 时间统一存 ISO-8601 UTC 文本（YYYY-MM-DDTHH:mm:ss.sssZ），业务日期存 YYYY-MM-DD。

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agency (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  code        TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS applicant (
  id          TEXT PRIMARY KEY,
  pseudonym   TEXT NOT NULL UNIQUE,
  contact    TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel (
  id     TEXT PRIMARY KEY,
  name   TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS catalog_item (
  id                  TEXT PRIMARY KEY,
  agency_id           TEXT NOT NULL REFERENCES agency(id),
  title               TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  default_sensitivity TEXT NOT NULL DEFAULT 'normal'
                      CHECK (default_sensitivity IN ('normal','partial','secret')),
  created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS foi_request (
  id                 TEXT PRIMARY KEY,
  agency_id          TEXT NOT NULL REFERENCES agency(id),
  applicant_id       TEXT NOT NULL REFERENCES applicant(id),
  channel_id         TEXT NOT NULL REFERENCES channel(id),
  idempotency_key    TEXT UNIQUE,
  content            TEXT NOT NULL,
  content_hash       TEXT NOT NULL,
  scope_summary      TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'received'
                     CHECK (status IN (
                       'received','clarification_needed','under_review',
                       'answered','closed','reconsideration_open','changed'
                     )),
  received_at        TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  version            INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_request_applicant ON foi_request(applicant_id);
CREATE INDEX IF NOT EXISTS idx_request_status ON foi_request(status);
CREATE INDEX IF NOT EXISTS idx_request_received ON foi_request(received_at);

-- 范围补正请求与申请人回复
CREATE TABLE IF NOT EXISTS clarification (
  id            TEXT PRIMARY KEY,
  request_id    TEXT NOT NULL REFERENCES foi_request(id),
  issued_at     TEXT NOT NULL,
  due_on        TEXT NOT NULL,
  question      TEXT NOT NULL,
  response_at   TEXT,
  response_text TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','responded','lapsed'))
);
CREATE INDEX IF NOT EXISTS idx_clar_request ON clarification(request_id);

-- 申请期限暂停/恢复（显式事件，禁止把逾期自动归咎申请人）
CREATE TABLE IF NOT EXISTS timeline_event (
  id           TEXT PRIMARY KEY,
  request_id   TEXT NOT NULL REFERENCES foi_request(id),
  seq          INTEGER NOT NULL,
  type         TEXT NOT NULL
               CHECK (type IN (
                 'received','pause','resume','clarification_issued','clarification_responded',
                 'search_assigned','review_started','extension_requested','extension_approved',
                 'extension_rejected','answer_issued','redelivery','reconsideration_filed',
                 'reconsideration_accepted','reconsideration_decision','note'
               )),
  occurred_at  TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  actor        TEXT NOT NULL DEFAULT 'system',
  UNIQUE (request_id, seq)
);

CREATE TABLE IF NOT EXISTS search_task (
  id          TEXT PRIMARY KEY,
  request_id  TEXT NOT NULL REFERENCES foi_request(id),
  assignee    TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'assigned'
              CHECK (status IN ('assigned','completed','cancelled')),
  assigned_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS search_hit (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES search_task(id),
  request_id     TEXT NOT NULL REFERENCES foi_request(id),
  catalog_item_id TEXT NOT NULL REFERENCES catalog_item(id),
  found_at       TEXT NOT NULL
);

-- 资料片段：一份资料可拆为多个公开/不公开片段，删隐按字符位置标注
CREATE TABLE IF NOT EXISTS item_segment (
  id              TEXT PRIMARY KEY,
  catalog_item_id TEXT NOT NULL REFERENCES catalog_item(id),
  label           TEXT NOT NULL,
  start_offset    INTEGER NOT NULL,
  end_offset      INTEGER NOT NULL,
  full_text       TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  CHECK (end_offset > start_offset),
  CHECK (start_offset >= 0)
);

-- 保密审查（逐片段）
CREATE TABLE IF NOT EXISTS review_decision (
  id                TEXT PRIMARY KEY,
  request_id        TEXT NOT NULL REFERENCES foi_request(id),
  catalog_item_id   TEXT NOT NULL REFERENCES catalog_item(id),
  segment_id        TEXT REFERENCES item_segment(id),
  disposition       TEXT NOT NULL
                    CHECK (disposition IN ('public','redacted','withheld')),
  legal_basis       TEXT NOT NULL,
  reason            TEXT NOT NULL,
  redaction_start   INTEGER,
  redaction_end     INTEGER,
  reviewer          TEXT NOT NULL,
  decided_at        TEXT NOT NULL,
  CHECK ((disposition = 'redacted'
          AND redaction_start IS NOT NULL AND redaction_end IS NOT NULL
          AND redaction_end > redaction_start)
         OR disposition IN ('public','withheld'))
);
CREATE INDEX IF NOT EXISTS idx_review_request ON review_decision(request_id);

-- 延期：必须有审批与理由
CREATE TABLE IF NOT EXISTS extension (
  id                 TEXT PRIMARY KEY,
  request_id         TEXT NOT NULL REFERENCES foi_request(id),
  requested_at       TEXT NOT NULL,
  reason             TEXT NOT NULL,
  extra_workdays     INTEGER NOT NULL CHECK (extra_workdays > 0 AND extra_workdays <= 20),
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','approved','rejected')),
  decided_at         TEXT,
  approver           TEXT,
  decision_note      TEXT
);

-- 正式答复（不可变版本留痕；复议改判生成新版本，不覆盖旧答复）
CREATE TABLE IF NOT EXISTS answer (
  id                TEXT PRIMARY KEY,
  request_id        TEXT NOT NULL REFERENCES foi_request(id),
  version           INTEGER NOT NULL,
  supersedes_id     TEXT REFERENCES answer(id),
  kind              TEXT NOT NULL DEFAULT 'final'
                    CHECK (kind IN ('final','reconsideration')),
  outcome           TEXT NOT NULL
                    CHECK (outcome IN ('granted','partial','denied','no_record')),
  body              TEXT NOT NULL,
  issued_at         TEXT NOT NULL,
  issued_by         TEXT NOT NULL,
  UNIQUE (request_id, version)
);

CREATE TABLE IF NOT EXISTS answer_item (
  id                TEXT PRIMARY KEY,
  answer_id         TEXT NOT NULL REFERENCES answer(id),
  catalog_item_id   TEXT NOT NULL REFERENCES catalog_item(id),
  disposition       TEXT NOT NULL
                    CHECK (disposition IN ('public','redacted','withheld','no_record')),
  legal_basis       TEXT NOT NULL,
  reason            TEXT NOT NULL,
  redaction_start   INTEGER,
  redaction_end     INTEGER,
  public_text       TEXT NOT NULL DEFAULT ''
);

-- 送达：重复送达幂等记录
CREATE TABLE IF NOT EXISTS delivery (
  id              TEXT PRIMARY KEY,
  answer_id       TEXT NOT NULL REFERENCES answer(id),
  request_id      TEXT NOT NULL REFERENCES foi_request(id),
  idempotency_key TEXT,
  channel_id      TEXT NOT NULL REFERENCES channel(id),
  attempt_no      INTEGER NOT NULL,
  sent_at         TEXT NOT NULL,
  duplicate_of    TEXT REFERENCES delivery(id),
  status          TEXT NOT NULL DEFAULT 'delivered'
                  CHECK (status IN ('delivered','duplicate','failed'))
);

-- 复议：受理后保留原答复，以新决定说明维持或变更
CREATE TABLE IF NOT EXISTS reconsideration (
  id               TEXT PRIMARY KEY,
  request_id       TEXT NOT NULL REFERENCES foi_request(id),
  original_answer_id TEXT NOT NULL REFERENCES answer(id),
  new_answer_id    TEXT REFERENCES answer(id),
  idempotency_key  TEXT UNIQUE,
  reason           TEXT NOT NULL,
  filed_at         TEXT NOT NULL,
  accepted_at      TEXT,
  decided_at       TEXT,
  result           TEXT
                   CHECK (result IS NULL OR result IN ('upheld','changed')),
  status           TEXT NOT NULL DEFAULT 'filed'
                   CHECK (status IN ('filed','accepted','decided','rejected'))
);
