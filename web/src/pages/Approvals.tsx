import { useState } from 'react';
import { useStore } from '../store.js';
import { api } from '../api.js';
import { fmtTime } from '../ui.jsx';
import type { Approval } from '@agent-runner/shared';

export function Approvals() {
  const { approvals, refreshApprovals, refreshJobs, openJob } = useStore();
  const [busy, setBusy] = useState<string | null>(null);

  const pending = approvals.filter((a) => a.status === 'pending');
  const decided = approvals.filter((a) => a.status !== 'pending');

  const decide = async (id: string, d: 'grant' | 'deny') => {
    setBusy(id);
    try {
      await api.decide(id, d);
      await Promise.all([refreshApprovals(), refreshJobs()]);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>审批队列</h1>
          <p className="muted">人工审批节点：等待状态持久化，批准后续跑，驳回即取消</p>
        </div>
      </header>

      {pending.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">◈</div>
          <p>无待审批项。入队一条带审批门的任务（如 school_notice）即可在这里看到。</p>
        </div>
      ) : (
        <div className="approval-grid">
          {pending.map((a) => (
            <ApprovalCard
              key={a.id}
              a={a}
              busy={busy === a.id}
              onGrant={() => void decide(a.id, 'grant')}
              onDeny={() => void decide(a.id, 'deny')}
              onOpen={() => void openJob(a.jobId)}
            />
          ))}
        </div>
      )}

      {decided.length > 0 && (
        <section className="panel" style={{ marginTop: 24 }}>
          <h2 className="panel-title">已处理</h2>
          <div className="audit-list">
            {decided.map((a) => (
              <div key={a.id} className="audit-row">
                <span className="audit-time">{fmtTime(a.decidedAt)}</span>
                <span className={`pill ${a.status === 'granted' ? 's-done' : 's-failed'}`}>
                  {a.status === 'granted' ? '已批准' : '已驳回'}
                </span>
                <span className="audit-actor">{a.decidedBy}</span>
                <button className="btn small" onClick={() => void openJob(a.jobId)}>
                  查看任务
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function ApprovalCard({
  a,
  busy,
  onGrant,
  onDeny,
  onOpen,
}: {
  a: Approval;
  busy: boolean;
  onGrant: () => void;
  onDeny: () => void;
  onOpen: () => void;
}) {
  return (
    <div className="approval-card">
      <div className="approval-reason">{a.reason ?? '（无说明）'}</div>
      <div className="job-meta muted">
        请求于 {fmtTime(a.requestedAt)} · job <code>{a.jobId}</code>
      </div>
      <div className="approval-actions">
        <button className="btn btn-success" disabled={busy} onClick={onGrant}>
          ✓ 批准继续
        </button>
        <button className="btn btn-danger" disabled={busy} onClick={onDeny}>
          ✕ 驳回取消
        </button>
        <button className="btn" disabled={busy} onClick={onOpen}>
          查看任务
        </button>
      </div>
    </div>
  );
}
