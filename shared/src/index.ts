// ============================================================
// Agent Runner — shared types (server & web)
// 状态机与数据契约的唯一真源
// ============================================================

// ---------- Job 状态机 ----------
// pending -> running (leased) -> done | failed
// running -> paused_approval -> running        (人工审批)
// running -> breached -> running               (预算上调后恢复)
// any non-terminal -> cancelled
export const JOB_STATUSES = [
  'pending',
  'running',
  'paused_approval',
  'breached',
  'cancelled',
  'done',
  'failed',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_TERMINAL_STATUSES: readonly JobStatus[] = ['done', 'failed', 'cancelled'];

export const STEP_STATUSES = ['pending', 'running', 'done', 'skipped', 'failed'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const APPROVAL_STATUSES = ['pending', 'granted', 'denied'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

// ---------- 审计事件类型（append-only） ----------
export const AUDIT_EVENT_TYPES = [
  'job_created',
  'lease_acquired',
  'lease_renewed',
  'lease_released',
  'lease_recovered',
  'step_start',
  'step_done',
  'step_skipped',
  'step_failed',
  'approval_requested',
  'approval_granted',
  'approval_denied',
  'budget_breach',
  'budget_updated',
  'step_retry',
  'job_retry',
  'push_sent',
  'push_failed',
  'job_cancelled',
  'job_done',
  'job_failed',
  'digest_created',
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

// ---------- 领域模型 ----------
export interface Job {
  id: string;
  name: string;
  type: string;
  status: JobStatus;
  priority: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null; // ISO
  idempotencyNs: string; // 同 ns 内同 type+payload 幂等去重
  budgetTokens: number;
  budgetCostUsd: number;
  usedTokens: number;
  usedCostUsd: number;
  cronExpr: string | null;
  attempt: number; // 已失败次数（job 级重试计数，失败后 +1；与 maxAttempts 比较）
  maxAttempts: number; // 允许的最大执行次数，超过则终态 failed
  payload: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface Step {
  id: string;
  jobId: string;
  stepIndex: number;
  name: string;
  idempotencyKey: string; // jobId + stepIndex + name 的内容哈希
  status: StepStatus;
  requiresApproval: boolean;
  inputJson: string | null;
  outputJson: string | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  attempt: number; // 该步第几次尝试（1-based，步级重试计数）
}

export interface AuditEvent {
  id: number;
  jobId: string;
  ts: string;
  type: AuditEventType;
  actor: string; // 'worker:<id>' | 'scheduler' | 'user' | 'system'
  payloadJson: string | null;
}

export interface Approval {
  id: string;
  jobId: string;
  stepId: string | null;
  reason: string | null;
  status: ApprovalStatus;
  requestedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

export interface DigestItem {
  id: string;
  jobId: string;
  title: string;
  bodyMd: string;
  createdAt: string;
}

// ---------- LLM Provider 契约 ----------
export interface LLMRequest {
  system?: string;
  prompt: string;
  maxTokens?: number;
}

export interface LLMResponse {
  text: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface LLMProvider {
  readonly name: string;
  complete(req: LLMRequest): Promise<LLMResponse>;
}

// ---------- 任务定义契约 ----------
export interface StepSpec<Ctx = unknown> {
  name: string;
  // 审批门：true 恒开；函数按 payload 动态决定（如 demo 里 payload.approve）
  requiresApproval?: boolean | ((payload: unknown) => boolean);
  // 步级重试：失败后按指数退避重试的次数（默认 0 = 失败即终态）
  maxRetries?: number;
  // 退避基数 ms：第 n 次重试前等待 retryDelayMs * 2^n（+ 抖动）
  retryDelayMs?: number;
  // 返回 output（会被 JSON 序列化）与 LLM 用量（非 LLM 步为 0）
  run: (ctx: JobRunContext) => Promise<StepResult>;
}

export function stepRequiresApproval(spec: StepSpec, payload: unknown): boolean {
  if (typeof spec.requiresApproval === 'function') return spec.requiresApproval(payload);
  return spec.requiresApproval === true;
}

export interface StepResult {
  output: unknown;
  usage?: { tokensIn: number; tokensOut: number; costUsd: number };
}

export interface JobRunContext {
  jobId: string;
  payload: unknown;
  // 上一步的 output（已反序列化），第一步为 null
  prev: unknown;
  // 步进共享的可变状态袋（同一次 worker 运行内有效，重启后丢失——持久化请写 output）
  bag: Map<string, unknown>;
  llm: LLMProvider;
  log: (msg: string) => void;
}

export interface JobDefinition {
  type: string;
  description: string;
  defaultBudget: { tokens: number; costUsd: number };
  steps: StepSpec[];
}

// ---------- SSE 事件 ----------
export type SSEEvent =
  | { kind: 'job_update'; job: Job }
  | { kind: 'step_update'; step: Step }
  | { kind: 'audit'; event: AuditEvent }
  | { kind: 'approval_update'; approval: Approval }
  | { kind: 'digest_created'; digest: DigestItem }
  | { kind: 'heartbeat'; ts: number };

// ---------- API DTO ----------
export interface JobDetail {
  job: Job;
  steps: Step[];
  approvals: Approval[];
}

export interface NewJobRequest {
  type: string;
  name?: string;
  payload?: unknown;
  priority?: number;
  budgetTokens?: number;
  budgetCostUsd?: number;
  cronExpr?: string;
  idempotencyNs?: string;
  maxAttempts?: number;
}
