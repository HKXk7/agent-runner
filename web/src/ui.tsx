import type { JobStatus, StepStatus } from '@agent-runner/shared';

const JOB_STATUS_META: Record<JobStatus, { label: string; cls: string }> = {
  pending: { label: '排队中', cls: 's-pending' },
  running: { label: '运行中', cls: 's-running' },
  paused_approval: { label: '待审批', cls: 's-approval' },
  breached: { label: '已熔断', cls: 's-breached' },
  cancelled: { label: '已取消', cls: 's-cancelled' },
  done: { label: '完成', cls: 's-done' },
  failed: { label: '失败', cls: 's-failed' },
};

export function JobStatusPill({ status }: { status: JobStatus }) {
  const m = JOB_STATUS_META[status];
  return <span className={`pill ${m.cls}`}>{m.label}</span>;
}

const STEP_STATUS_META: Record<StepStatus, { label: string; cls: string }> = {
  pending: { label: '待执行', cls: 's-pending' },
  running: { label: '执行中', cls: 's-running' },
  done: { label: '完成', cls: 's-done' },
  skipped: { label: '已跳过', cls: 's-cancelled' },
  failed: { label: '失败', cls: 's-failed' },
};

export function StepStatusPill({ status }: { status: StepStatus }) {
  const m = STEP_STATUS_META[status];
  return <span className={`pill ${m.cls}`}>{m.label}</span>;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function fmtUsd(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.0001) return `$${n.toExponential(2)}`;
  return `$${n.toFixed(n < 0.01 ? 5 : 4)}`;
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function timeAgo(iso: string): string {
  const d = Date.now() - new Date(iso).getTime();
  const s = Math.floor(d / 1000);
  if (s < 60) return `${s}s 前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m 前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h 前`;
  return `${Math.floor(h / 24)}d 前`;
}
