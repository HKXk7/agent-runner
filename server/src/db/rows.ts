import type {
  Approval,
  AuditEvent,
  DigestItem,
  Job,
  JobStatus,
  Step,
  StepStatus,
  ApprovalStatus,
} from '@agent-runner/shared';
import type { JobRow } from './database.js';

// snake_case DB 行 -> camelCase 领域对象（shared 契约）

export function mapJob(r: JobRow): Job {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    status: r.status as JobStatus,
    priority: r.priority,
    leaseOwner: r.lease_owner,
    leaseExpiresAt: r.lease_expires_at,
    idempotencyNs: r.idempotency_ns,
    budgetTokens: r.budget_tokens,
    budgetCostUsd: r.budget_cost_usd,
    usedTokens: r.used_tokens,
    usedCostUsd: r.used_cost_usd,
    cronExpr: r.cron_expr,
    attempt: r.attempt,
    maxAttempts: r.max_attempts,
    payload: JSON.parse(r.payload_json || '{}'),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface StepRow {
  id: string; job_id: string; step_index: number; name: string;
  idempotency_key: string; status: string; requires_approval: number;
  input_json: string | null; output_json: string | null;
  tokens_in: number; tokens_out: number; cost_usd: number;
  started_at: string | null; finished_at: string | null; error: string | null;
  attempt: number;
}

export function mapStep(r: StepRow): Step {
  return {
    id: r.id,
    jobId: r.job_id,
    stepIndex: r.step_index,
    name: r.name,
    idempotencyKey: r.idempotency_key,
    status: r.status as StepStatus,
    requiresApproval: r.requires_approval === 1,
    inputJson: r.input_json,
    outputJson: r.output_json,
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
    costUsd: r.cost_usd,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    error: r.error,
    attempt: r.attempt,
  };
}

interface AuditRow {
  id: number; job_id: string; ts: string; type: string; actor: string; payload_json: string | null;
}

export function mapAudit(r: AuditRow): AuditEvent {
  return {
    id: r.id,
    jobId: r.job_id,
    ts: r.ts,
    type: r.type as AuditEvent['type'],
    actor: r.actor,
    payloadJson: r.payload_json,
  };
}

interface ApprovalRow {
  id: string; job_id: string; step_id: string | null; reason: string | null;
  status: string; requested_at: string; decided_at: string | null; decided_by: string | null;
}

export function mapApproval(r: ApprovalRow): Approval {
  return {
    id: r.id,
    jobId: r.job_id,
    stepId: r.step_id,
    reason: r.reason,
    status: r.status as ApprovalStatus,
    requestedAt: r.requested_at,
    decidedAt: r.decided_at,
    decidedBy: r.decided_by,
  };
}

interface DigestRow {
  id: string; job_id: string; title: string; body_md: string; created_at: string;
}

export function mapDigest(r: DigestRow): DigestItem {
  return {
    id: r.id,
    jobId: r.job_id,
    title: r.title,
    bodyMd: r.body_md,
    createdAt: r.created_at,
  };
}
