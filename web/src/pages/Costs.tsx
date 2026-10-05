import { useStore } from '../store.js';
import { fmtTokens, fmtUsd } from '../ui.jsx';

const STATUS_LABEL: Record<string, string> = {
  pending: '排队',
  running: '运行中',
  paused_approval: '待审批',
  breached: '已熔断',
  cancelled: '已取消',
  done: '完成',
  failed: '失败',
};

export function Costs() {
  const { stats } = useStore();

  if (!stats) {
    return (
      <div className="page">
        <h1>成本面板</h1>
        <div className="empty">加载中…</div>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>成本面板</h1>
          <p className="muted">跨任务 token 与成本聚合 · 成本熔断的治理依据</p>
        </div>
      </header>

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">累计任务</div>
          <div className="stat-value">{stats.totalJobs}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">累计 tokens</div>
          <div className="stat-value">{fmtTokens(stats.usedTokens)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">累计成本</div>
          <div className="stat-value accent">{fmtUsd(stats.usedCostUsd)}</div>
        </div>
      </div>

      <div className="two-col">
        <section className="panel">
          <h2 className="panel-title">按类型</h2>
          <table className="table">
            <thead>
              <tr>
                <th>type</th>
                <th>任务数</th>
                <th>tokens</th>
                <th>成本</th>
              </tr>
            </thead>
            <tbody>
              {stats.byType.map((t) => (
                <tr key={t.type}>
                  <td><code>{t.type}</code></td>
                  <td>{t.jobs}</td>
                  <td>{fmtTokens(Number(t.tokens))}</td>
                  <td>{fmtUsd(Number(t.costUsd))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="panel">
          <h2 className="panel-title">按状态</h2>
          <table className="table">
            <thead>
              <tr>
                <th>状态</th>
                <th>数量</th>
              </tr>
            </thead>
            <tbody>
              {stats.byStatus.map((s) => (
                <tr key={s.status}>
                  <td>{STATUS_LABEL[s.status] ?? s.status}</td>
                  <td>{s.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
