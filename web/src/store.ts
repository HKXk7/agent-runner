import { create } from 'zustand';
import { api, type Approval, type AuditEvent, type DigestItem, type Job, type Step } from './api.js';

export type Tab = 'board' | 'approvals' | 'inbox' | 'costs';

interface Meta {
  provider: string;
  definitions: {
    type: string;
    description: string;
    defaultBudget: { tokens: number; costUsd: number };
    steps: { name: string; requiresApproval: boolean | string }[];
  }[];
}

interface Stats {
  totalJobs: number;
  usedTokens: number;
  usedCostUsd: number;
  byStatus: { status: string; n: number }[];
  byType: { type: string; jobs: number; tokens: number; costUsd: number }[];
}

interface AppState {
  tab: Tab;
  selectedJobId: string | null;

  jobs: Job[];
  approvals: Approval[];
  digests: DigestItem[];
  meta: Meta | null;
  stats: Stats | null;

  detail: { job: Job; steps: Step[]; audits: AuditEvent[] } | null;
  loadingDetail: boolean;

  setTab: (t: Tab) => void;
  openJob: (id: string) => Promise<void>;
  closeJob: () => void;

  refreshJobs: () => Promise<void>;
  refreshApprovals: () => Promise<void>;
  refreshDigests: () => Promise<void>;
  refreshMeta: () => Promise<void>;
  refreshStats: () => Promise<void>;
  refreshAll: () => Promise<void>;

  applyEvent: (ev: { jobId: string; ev: import('@agent-runner/shared').SSEEvent }) => void;
}

export const useStore = create<AppState>((set, get) => ({
  tab: 'board',
  selectedJobId: null,
  jobs: [],
  approvals: [],
  digests: [],
  meta: null,
  stats: null,
  detail: null,
  loadingDetail: false,

  setTab: (t) => set({ tab: t }),

  openJob: async (id) => {
    set({ selectedJobId: id, loadingDetail: true, detail: null });
    try {
      const d = await api.jobDetail(id);
      const audits = await api.listAudit(id);
      set({ detail: { job: d.job, steps: d.steps, audits }, loadingDetail: false });
    } catch {
      set({ loadingDetail: false });
    }
  },
  closeJob: () => set({ selectedJobId: null, detail: null }),

  refreshJobs: async () => set({ jobs: await api.listJobs() }),
  refreshApprovals: async () => set({ approvals: await api.listApprovals() }),
  refreshDigests: async () => set({ digests: await api.listDigests() }),
  refreshMeta: async () => set({ meta: await api.meta() }),
  refreshStats: async () => set({ stats: await api.stats() }),
  refreshAll: async () => {
    await Promise.all([
      get().refreshJobs(),
      get().refreshApprovals(),
      get().refreshDigests(),
      get().refreshMeta(),
      get().refreshStats(),
    ]);
  },

  applyEvent: ({ jobId, ev }) => {
    const s = get();
    switch (ev.kind) {
      case 'job_update':
        set((st) => ({
          jobs: upsertJob(st.jobs, ev.job),
          detail:
            st.detail && st.detail.job.id === ev.job.id
              ? { ...st.detail, job: ev.job }
              : st.detail,
        }));
        void s.refreshStats();
        break;
      case 'step_update':
        if (s.detail && s.detail.job.id === jobId) {
          set((st) => ({
            detail: st.detail ? { ...st.detail, steps: upsertStep(st.detail.steps, ev.step) } : st.detail,
          }));
        }
        break;
      case 'audit':
        if (s.detail && s.detail.job.id === jobId) {
          set((st) => ({
            detail: st.detail ? { ...st.detail, audits: [...st.detail.audits, ev.event] } : st.detail,
          }));
        }
        break;
      case 'approval_update':
        set((st) => ({ approvals: upsertApproval(st.approvals, ev.approval) }));
        break;
      case 'digest_created':
        set((st) => ({ digests: [ev.digest, ...st.digests.filter((d) => d.id !== ev.digest.id)] }));
        break;
      case 'heartbeat':
        break;
    }
  },
}));

function upsertJob(list: Job[], job: Job): Job[] {
  const i = list.findIndex((j) => j.id === job.id);
  if (i === -1) return [job, ...list];
  const next = [...list];
  next[i] = job;
  return next;
}

function upsertStep(list: Step[], step: Step): Step[] {
  const i = list.findIndex((s) => s.id === step.id);
  const next = i === -1 ? [...list, step] : list.map((s) => (s.id === step.id ? step : s));
  return next.sort((a, b) => a.stepIndex - b.stepIndex);
}

function upsertApproval(list: Approval[], a: Approval): Approval[] {
  const i = list.findIndex((x) => x.id === a.id);
  if (i === -1) return [a, ...list];
  const next = [...list];
  next[i] = a;
  return next;
}

// ---- 全局 SSE：单连接承载看板/详情/审批/收件箱的所有实时事件 ----
export function connectSSE(): void {
  const es = new EventSource('/api/stream');
  es.onmessage = (msg) => {
    try {
      const payload = JSON.parse(msg.data) as { jobId: string; ev: import('@agent-runner/shared').SSEEvent };
      useStore.getState().applyEvent(payload);
    } catch {
      /* ignore malformed */
    }
  };
}
