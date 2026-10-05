-- ============================================================
-- Agent Runner schema v1  (SQLite / WAL)
-- 设计要点：
--   * jobs.lease_owner/lease_expires_at —— DB-backed 租约，防双跑
--   * steps.idempotency_key UNIQUE      —— at-least-once 去重
--   * audit_events 触发器禁 UPDATE/DELETE —— append-only 审计
-- ============================================================

CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','running','paused_approval','breached','cancelled','done','failed')),
  priority        INTEGER NOT NULL DEFAULT 0,
  lease_owner     TEXT,
  lease_expires_at TEXT,                -- ISO 8601
  idempotency_ns  TEXT NOT NULL DEFAULT '',
  budget_tokens   INTEGER NOT NULL,
  budget_cost_usd REAL NOT NULL,
  used_tokens     INTEGER NOT NULL DEFAULT 0,
  used_cost_usd   REAL NOT NULL DEFAULT 0,
  cron_expr       TEXT,
  attempt         INTEGER NOT NULL DEFAULT 0,   -- job 级重试计数（第几次执行）
  max_attempts    INTEGER NOT NULL DEFAULT 1,   -- 允许的最大执行次数，超过则终态 failed
  payload_json    TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- 调度器取任务路径：状态可获取 + 优先级 + FIFO
CREATE INDEX IF NOT EXISTS idx_jobs_pickup ON jobs(status, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_lease ON jobs(lease_expires_at) WHERE lease_owner IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_idem ON jobs(idempotency_ns, type) WHERE idempotency_ns != '';

CREATE TABLE IF NOT EXISTS steps (
  id              TEXT PRIMARY KEY,
  job_id          TEXT NOT NULL REFERENCES jobs(id),
  step_index      INTEGER NOT NULL,
  name            TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,   -- `${jobId}:${index}:${name}`
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','running','done','skipped','failed')),
  requires_approval INTEGER NOT NULL DEFAULT 0,
  input_json      TEXT,
  output_json     TEXT,
  tokens_in       INTEGER NOT NULL DEFAULT 0,
  tokens_out      INTEGER NOT NULL DEFAULT 0,
  cost_usd        REAL NOT NULL DEFAULT 0,
  started_at      TEXT,
  finished_at     TEXT,
  error           TEXT,
  attempt         INTEGER NOT NULL DEFAULT 0   -- step 级重试计数（该步已执行次数）
);
CREATE INDEX IF NOT EXISTS idx_steps_job ON steps(job_id, step_index);

CREATE TABLE IF NOT EXISTS audit_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       TEXT NOT NULL,
  ts           TEXT NOT NULL,
  type         TEXT NOT NULL,
  actor        TEXT NOT NULL,             -- 'worker:<id>' | 'scheduler' | 'user' | 'system'
  payload_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_job ON audit_events(job_id, id);

-- ★ append-only 审计：数据库层面禁止篡改与删除（面试考点）
CREATE TRIGGER IF NOT EXISTS trg_audit_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_audit_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

CREATE TABLE IF NOT EXISTS approvals (
  id           TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL REFERENCES jobs(id),
  step_id      TEXT,
  reason       TEXT,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','granted','denied')),
  requested_at TEXT NOT NULL,
  decided_at   TEXT,
  decided_by   TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, requested_at);

CREATE TABLE IF NOT EXISTS digests (
  id         TEXT PRIMARY KEY,
  job_id     TEXT NOT NULL,
  title      TEXT NOT NULL,
  body_md    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_digests_created ON digests(created_at DESC);

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);
