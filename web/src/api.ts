import type {
  Approval,
  AuditEvent,
  DigestItem,
  Job,
  JobDetail,
  NewJobRequest,
  Step,
  SSEEvent,
} from '@agent-runner/shared';

const BASE = '/api';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listJobs: (status?: string) =>
    req<Job[]>(`/jobs${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  jobDetail: (id: string) => req<JobDetail>(`/jobs/${id}`),
  createJob: (body: NewJobRequest) => req<{ job: Job; deduped: boolean }>(`/jobs`, { method: 'POST', body: JSON.stringify(body) }),
  cancelJob: (id: string) => req<{ job: Job }>(`/jobs/${id}/cancel`, { method: 'POST' }),
  setBudget: (id: string, body: { budgetTokens?: number; budgetCostUsd?: number }) =>
    req<{ job: Job; resumed: boolean }>(`/jobs/${id}/budget`, { method: 'POST', body: JSON.stringify(body) }),
  listApprovals: (status?: string) =>
    req<Approval[]>(`/approvals${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  decide: (id: string, decision: 'grant' | 'deny') =>
    req<{ approval: Approval }>(`/approvals/${id}/decide`, { method: 'POST', body: JSON.stringify({ decision }) }),
  listDigests: () => req<DigestItem[]>(`/digests`),
  listAudit: (jobId: string) => req<AuditEvent[]>(`/audit?jobId=${encodeURIComponent(jobId)}&limit=500`),
  stats: () =>
    req<{
      totalJobs: number;
      usedTokens: number;
      usedCostUsd: number;
      byStatus: { status: string; n: number }[];
      byType: { type: string; jobs: number; tokens: number; costUsd: number }[];
    }>(`/stats`),
  meta: () =>
    req<{
      provider: string;
      definitions: {
        type: string;
        description: string;
        defaultBudget: { tokens: number; costUsd: number };
        steps: { name: string; requiresApproval: boolean | string }[];
      }[];
    }>(`/meta`),
};

export type { Job, Step, AuditEvent, Approval, DigestItem, JobDetail, SSEEvent };
