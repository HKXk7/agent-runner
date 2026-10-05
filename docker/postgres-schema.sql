-- ============================================================
-- Agent Runner — Postgres schema（多 worker 水平扩展升级路径）
--
-- 何时切换：单机 SQLite WAL 已满足 MVP；需要多进程多 worker 水平扩展时
-- 用 docker/postgres.yml 起 PG，把 lease 抢占换成 SKIP LOCKED（见文末）。
-- 队列读写经 jobs-repo / lease 抽象隔离，业务层（worker/scheduler/jobs）零改动。
--
-- 与 SQLite 版的差异：
--   * better-sqlite3 单写者 -> PG MVCC + SKIP LOCKED 真并发
--   * REAL -> DOUBLE PRECISION；AUTOINCREMENT -> BIGSERIAL
--   * append-only 触发器从 SQLite 语法 -> PL/pgSQL
-- ============================================================

CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','running','paused_approval','breached','cancelled','done','failed')),
  priority        INTEGER NOT NULL DEFAULT 0,
  lease_owner     TEXT,
  lease_expires_at TIMESTAMPTZ,
  idempotency_ns  TEXT NOT NULL DEFAULT '',
  budget_tokens   BIGINT NOT NULL,
  budget_cost_usd DOUBLE PRECISION NOT NULL,
  used_tokens     BIGINT NOT NULL DEFAULT 0,
  used_cost_usd   DOUBLE PRECISION NOT NULL DEFAULT 0,
  cron_expr       TEXT,
  attempt         INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 1,
  payload_json    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jobs_pickup ON jobs(status, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_lease ON jobs(lease_expires_at) WHERE lease_owner IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_idem ON jobs(idempotency_ns, type) WHERE idempotency_ns != '';

CREATE TABLE IF NOT EXISTS steps (
  id              TEXT PRIMARY KEY,
  job_id          TEXT NOT NULL REFERENCES jobs(id),
  step_index      INTEGER NOT NULL,
  name            TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','running','done','skipped','failed')),
  requires_approval BOOLEAN NOT NULL DEFAULT false,
  input_json      JSONB,
  output_json     JSONB,
  tokens_in       BIGINT NOT NULL DEFAULT 0,
  tokens_out      BIGINT NOT NULL DEFAULT 0,
  cost_usd        DOUBLE PRECISION NOT NULL DEFAULT 0,
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  error           TEXT,
  attempt         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_steps_job ON steps(job_id, step_index);

CREATE TABLE IF NOT EXISTS audit_events (
  id           BIGSERIAL PRIMARY KEY,
  job_id       TEXT NOT NULL,
  ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
  type         TEXT NOT NULL,
  actor        TEXT NOT NULL,
  payload_json JSONB
);
CREATE INDEX IF NOT EXISTS idx_audit_job ON audit_events(job_id, id);

-- append-only 审计（PL/pgSQL 触发器，与 SQLite 版语义一致）
CREATE OR REPLACE FUNCTION audit_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_no_update ON audit_events;
CREATE TRIGGER trg_audit_no_update
BEFORE UPDATE ON audit_events
FOR EACH ROW EXECUTE FUNCTION audit_append_only();

DROP TRIGGER IF EXISTS trg_audit_no_delete ON audit_events;
CREATE TRIGGER trg_audit_no_delete
BEFORE DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION audit_append_only();

CREATE TABLE IF NOT EXISTS approvals (
  id           TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL REFERENCES jobs(id),
  step_id      TEXT,
  reason       TEXT,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','granted','denied')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at   TIMESTAMPTZ,
  decided_by   TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, requested_at);

CREATE TABLE IF NOT EXISTS digests (
  id         TEXT PRIMARY KEY,
  job_id     TEXT NOT NULL,
  title      TEXT NOT NULL,
  body_md    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_digests_created ON digests(created_at DESC);

-- ============================================================
-- 关键 SQL：lease 抢占的 SKIP LOCKED 版本（替代 SQLite 的 UPDATE...RETURNING）
--
-- SQLite 版（现实现）：单写者 + WAL 下天然串行，UPDATE...RETURNING 已原子；
-- PG 版：并发下必须 SKIP LOCKED 跳过已被别的事务锁定的行，等价语义、真并发：
--
-- UPDATE jobs
--    SET lease_owner = :worker, lease_expires_at = now() + interval '30 seconds',
--        status = 'running', updated_at = now()
--  WHERE id IN (
--    SELECT id FROM jobs
--     WHERE status = 'pending'
--        OR (status = 'running' AND (lease_owner IS NULL OR lease_expires_at < now()))
--     ORDER BY priority DESC, created_at ASC
--     LIMIT 1
--     FOR UPDATE SKIP LOCKED
--  )
--  RETURNING *;
--
-- 续约（原子，仅持有者可续）：
-- UPDATE jobs SET lease_expires_at = now() + interval '30 seconds', updated_at = now()
--  WHERE id = :jobId AND lease_owner = :worker AND status = 'running';
-- ============================================================
