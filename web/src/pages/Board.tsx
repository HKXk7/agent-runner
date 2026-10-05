import { useState } from 'react';
import type { Job } from '@agent-runner/shared';
import { useStore } from '../store.js';
import { api } from '../api.js';
import { JobStatusPill, fmtTokens, fmtUsd, timeAgo } from '../ui.jsx';

const FILTERS = [
  { key: '', label: '全部' },
  { key: 'running', label: '运行中' },
  { key: 'pending', label: '排队' },
  { key: 'paused_approval', label: '待审批' },
  { key: 'breached', label: '已熔断' },
  { key: 'done', label: '完成' },
  { key: 'failed', label: '失败' },
];

export function Board() {
  const { jobs, openJob, refreshJobs } = useStore();
  const [filter, setFilter] = useState('');
  const [showNew, setShowNew] = useState(false);

  const list = filter ? jobs.filter((j) => j.status === filter) : jobs;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>任务看板</h1>
          <p className="muted">DB-backed 任务队列 · lease/重试/熔断/审批 · 实时流</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowNew(true)}>
          + 新建任务
        </button>
      </header>

      <div className="chips">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`chip ${filter === f.key ? 'active' : ''}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {list.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">⚙</div>
          <p>暂无任务。点击「新建任务」跑一条 demo_pipeline 看看实时 trace。</p>
        </div>
      ) : (
        <div className="job-grid">
          {list.map((j) => (
            <JobCard key={j.id} job={j} onClick={() => void openJob(j.id)} />
          ))}
        </div>
      )}

      {showNew && (
        <NewJobDialog
          onClose={() => setShowNew(false)}
          onCreated={() => {
            setShowNew(false);
            void refreshJobs();
          }}
        />
      )}
    </div>
  );
}

function JobCard({ job, onClick }: { job: Job; onClick: () => void }) {
  const tokenPct = Math.min(100, (job.usedTokens / Math.max(1, job.budgetTokens)) * 100);
  const costPct = Math.min(100, (job.usedCostUsd / Math.max(0.000001, job.budgetCostUsd)) * 100);
  const pct = Math.max(tokenPct, costPct);
  return (
    <button className="job-card" onClick={onClick}>
      <div className="job-card-top">
        <span className="job-type">{job.type}</span>
        <JobStatusPill status={job.status} />
      </div>
      <div className="job-name">{job.name}</div>
      <div className="job-meta">
        <span>tok {fmtTokens(job.usedTokens)}/{fmtTokens(job.budgetTokens)}</span>
        <span>·</span>
        <span>
          {fmtUsd(job.usedCostUsd)}/{fmtUsd(job.budgetCostUsd)}
        </span>
      </div>
      <div className="budget-bar">
        <div
          className={`budget-fill ${pct > 100 ? 'over' : ''}`}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      <div className="job-meta muted">{timeAgo(job.createdAt)}</div>
    </button>
  );
}

function NewJobDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { meta } = useStore();
  const [type, setType] = useState(meta?.definitions[0]?.type ?? '');
  const [name, setName] = useState('');
  const [payload, setPayload] = useState('{}');
  const [budgetTokens, setBudgetTokens] = useState('');
  const [budgetCost, setBudgetCost] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const def = meta?.definitions.find((d) => d.type === type);

  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      let parsed: unknown = {};
      try {
        parsed = JSON.parse(payload || '{}');
      } catch {
        setErr('payload 不是合法 JSON');
        setBusy(false);
        return;
      }
      await api.createJob({
        type,
        name: name || undefined,
        payload: parsed,
        budgetTokens: budgetTokens ? Number(budgetTokens) : undefined,
        budgetCostUsd: budgetCost ? Number(budgetCost) : undefined,
      });
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>新建任务</h2>
        <label>
          类型
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {(meta?.definitions ?? []).map((d) => (
              <option key={d.type} value={d.type}>
                {d.type}
              </option>
            ))}
          </select>
        </label>
        {def && <p className="muted small">{def.description}</p>}
        <label>
          名称（可选）
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="自动生成" />
        </label>
        <label>
          payload（JSON）
          <textarea
            rows={5}
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            spellCheck={false}
          />
        </label>
        <div className="row">
          <label>
            预算 tokens
            <input
              type="number"
              value={budgetTokens}
              onChange={(e) => setBudgetTokens(e.target.value)}
              placeholder={def ? String(def.defaultBudget.tokens) : ''}
            />
          </label>
          <label>
            预算 $（USD）
            <input
              type="number"
              step="0.001"
              value={budgetCost}
              onChange={(e) => setBudgetCost(e.target.value)}
              placeholder={def ? String(def.defaultBudget.costUsd) : ''}
            />
          </label>
        </div>
        {err && <div className="error">{err}</div>}
        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={submit}>
            {busy ? '提交中…' : '入队'}
          </button>
        </div>
      </div>
    </div>
  );
}
