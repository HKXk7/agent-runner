import { useEffect, useState } from 'react';
import { useStore } from '../store.js';
import { api } from '../api.js';
import {
  JobStatusPill,
  StepStatusPill,
  fmtTokens,
  fmtUsd,
  fmtTime,
  fmtDuration,
} from '../ui.jsx';
import type { Step, AuditEvent } from '@agent-runner/shared';

export function JobDetail() {
  const { selectedJobId, detail, loadingDetail, closeJob, refreshJobs, approvals } = useStore();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (selectedJobId) {
      const h = setInterval(async () => {
        // 周期性刷新审计（SSE 已覆盖实时，但保险起见兜底）
        if (useStore.getState().detail?.job.id === selectedJobId) {
          const audits = await api.listAudit(selectedJobId);
          useStore.setState((s) => ({ detail: s.detail ? { ...s.detail, audits } : s.detail }));
        }
      }, 5000);
      return () => clearInterval(h);
    }
  }, [selectedJobId]);

  if (!selectedJobId) return null;

  if (loadingDetail || !detail) {
    return (
      <div className="page">
        <button className="btn back" onClick={closeJob}>← 返回</button>
        <div className="empty">加载中…</div>
      </div>
    );
  }

  const { job, steps, audits } = detail;
  const pendingApproval = approvals.find((a) => a.jobId === job.id && a.status === 'pending');

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr('');
    try {
      await fn();
      await refreshJobs();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const grant = () =>
    pendingApproval && act(() => api.decide(pendingApproval.id, 'grant'));
  const deny = () =>
    pendingApproval && act(() => api.decide(pendingApproval.id, 'deny'));

  const raiseBudget = () => {
    const t = window.prompt('新 token 预算（当前已用 ' + job.usedTokens + '）', String(job.usedTokens * 2));
    if (t === null) return;
    const c = window.prompt('新 $ 预算（当前已用 $' + job.usedCostUsd.toFixed(5) + '）', String(job.usedCostUsd * 2));
    void act(() => api.setBudget(job.id, { budgetTokens: Number(t) || undefined, budgetCostUsd: c ? Number(c) : undefined }));
  };

  const tokenPct = Math.min(100, (job.usedTokens / Math.max(1, job.budgetTokens)) * 100);
  const costPct = Math.min(100, (job.usedCostUsd / Math.max(0.000001, job.budgetCostUsd)) * 100);
  const over = job.usedTokens > job.budgetTokens || job.usedCostUsd > job.budgetCostUsd;

  return (
    <div className="page">
      <button className="btn back" onClick={closeJob}>← 返回</button>

      <header className="detail-head">
        <div>
          <div className="detail-title">
            <h1>{job.name}</h1>
            <JobStatusPill status={job.status} />
          </div>
          <p className="muted">
            {job.type} · id <code>{job.id}</code> · 创建于 {fmtTime(job.createdAt)}
          </p>
        </div>
        <div className="detail-actions">
          {job.status === 'paused_approval' && (
            <>
              <button className="btn btn-success" disabled={busy} onClick={grant}>✓ 批准</button>
              <button className="btn btn-danger" disabled={busy} onClick={deny}>✕ 驳回</button>
            </>
          )}
          {job.status === 'breached' && (
            <button className="btn btn-primary" disabled={busy} onClick={raiseBudget}>提升预算续跑</button>
          )}
          {!['done', 'failed', 'cancelled'].includes(job.status) && (
            <button
              className="btn btn-danger"
              disabled={busy}
              onClick={() => act(() => api.cancelJob(job.id))}
            >
              取消任务
            </button>
          )}
        </div>
      </header>

      {err && <div className="error">{err}</div>}

      <div className="budget-card">
        <div className="budget-card-title">成本预算</div>
        <div className="budget-metrics">
          <Metric label="tokens" value={`${fmtTokens(job.usedTokens)} / ${fmtTokens(job.budgetTokens)}`} pct={tokenPct} over={over} />
          <Metric label="cost" value={`${fmtUsd(job.usedCostUsd)} / ${fmtUsd(job.budgetCostUsd)}`} pct={costPct} over={over} />
        </div>
      </div>

      <section className="panel">
        <h2 className="panel-title">步骤 trace 时间轴</h2>
        {steps.length === 0 ? (
          <p className="muted">尚未产生步骤记录。</p>
        ) : (
          <Timeline steps={steps} />
        )}
      </section>

      <section className="panel">
        <h2 className="panel-title">审计事件流（append-only）</h2>
        <div className="audit-list">
          {audits.length === 0 ? (
            <p className="muted">暂无审计事件。</p>
          ) : (
            [...audits].reverse().map((a) => <AuditRow key={a.id} a={a} />)
          )}
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value, pct, over }: { label: string; value: string; pct: number; over: boolean }) {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      <div className="budget-bar">
        <div className={`budget-fill ${over ? 'over' : ''}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </div>
  );
}

function Timeline({ steps }: { steps: Step[] }) {
  const maxMs = Math.max(
    1,
    ...steps.map((s) => (s.startedAt && s.finishedAt ? new Date(s.finishedAt).getTime() - new Date(s.startedAt).getTime() : 0)),
  );

  return (
    <div className="timeline">
      {steps.map((s) => {
        const dur = s.startedAt && s.finishedAt ? new Date(s.finishedAt).getTime() - new Date(s.startedAt).getTime() : 0;
        const [open, setOpen] = useState(false);
        return (
          <StepRow key={s.id} s={s} dur={dur} maxMs={maxMs} open={open} setOpen={setOpen} />
        );
      })}
    </div>
  );
}

function StepRow({
  s,
  dur,
  maxMs,
  open,
  setOpen,
}: {
  s: Step;
  dur: number;
  maxMs: number;
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  const width = dur > 0 ? Math.max(2, (dur / maxMs) * 100) : 0;
  return (
    <div className="step">
      <div className="step-head">
        <span className="step-index">{String(s.stepIndex).padStart(2, '0')}</span>
        <span className="step-name">{s.name}</span>
        <StepStatusPill status={s.status} />
        <span className="step-spacer" />
        <span className="step-cost">tok {fmtTokens(s.tokensIn + s.tokensOut)}</span>
        <span className="step-cost">{fmtUsd(s.costUsd)}</span>
        <span className="step-dur">{fmtDuration(dur)}</span>
        <button className="step-toggle" onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'}
        </button>
      </div>
      {dur > 0 && (
        <div className="step-bar">
          <div className="step-bar-fill" style={{ width: `${width}%` }} />
        </div>
      )}
      {s.error && <div className="step-error">⚠ {s.error}</div>}
      {open && (
        <div className="step-detail">
          {s.inputJson && (
            <div>
              <div className="step-detail-label">input</div>
              <pre>{pretty(s.inputJson)}</pre>
            </div>
          )}
          {s.outputJson && (
            <div>
              <div className="step-detail-label">output</div>
              <pre>{pretty(s.outputJson)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function pretty(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

const AUDIT_LABEL: Record<string, string> = {
  job_created: '任务创建',
  lease_acquired: '租约获取',
  lease_released: '租约释放',
  lease_recovered: '租约回收',
  step_start: '步骤开始',
  step_done: '步骤完成',
  step_skipped: '步骤跳过（幂等）',
  step_failed: '步骤失败',
  approval_requested: '请求审批',
  approval_granted: '审批通过',
  approval_denied: '审批驳回',
  budget_breach: '成本熔断',
  budget_updated: '预算调整',
  job_cancelled: '任务取消',
  job_done: '任务完成',
  job_failed: '任务失败',
  digest_created: '收件箱写入',
};

function AuditRow({ a }: { a: AuditEvent }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="audit-row">
      <span className="audit-time">{fmtTime(a.ts)}</span>
      <span className="audit-type">{AUDIT_LABEL[a.type] ?? a.type}</span>
      <span className="audit-actor">{a.actor}</span>
      <button className="step-toggle" onClick={() => setOpen(!open)}>{open ? '▾' : '▸'}</button>
      {open && a.payloadJson && (
        <pre className="audit-payload">{pretty(a.payloadJson)}</pre>
      )}
    </div>
  );
}
