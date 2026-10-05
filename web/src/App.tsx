import { useEffect } from 'react';
import { useStore, type Tab } from './store.js';
import { Board } from './pages/Board.js';
import { Approvals } from './pages/Approvals.js';
import { Inbox } from './pages/Inbox.js';
import { Costs } from './pages/Costs.js';
import { JobDetail } from './pages/JobDetail.js';

const NAV: { tab: Tab; label: string; icon: string }[] = [
  { tab: 'board', label: '任务看板', icon: '▤' },
  { tab: 'approvals', label: '审批队列', icon: '◈' },
  { tab: 'inbox', label: '收件箱', icon: '✉' },
  { tab: 'costs', label: '成本面板', icon: '◎' },
];

export function App() {
  const { tab, selectedJobId, meta, approvals, refreshAll, setTab } = useStore();
  const pendingApprovals = approvals.filter((a) => a.status === 'pending').length;

  useEffect(() => {
    void refreshAll();
    const h = setInterval(() => void refreshAll(), 30_000);
    return () => clearInterval(h);
  }, [refreshAll]);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">⚙</span>
          <div>
            <div className="brand-title">Agent Runner</div>
            <div className="brand-sub">长任务运行台</div>
          </div>
        </div>
        <nav>
          {NAV.map((n) => (
            <button
              key={n.tab}
              className={`nav-item ${tab === n.tab ? 'active' : ''}`}
              onClick={() => setTab(n.tab)}
            >
              <span className="nav-icon">{n.icon}</span>
              <span>{n.label}</span>
              {n.tab === 'approvals' && pendingApprovals > 0 && (
                <span className="badge">{pendingApprovals}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className={`dot ${meta?.provider?.includes('mock') ? 'dot-amber' : 'dot-green'}`} />
          <span className="provider">provider: {meta?.provider ?? '…'}</span>
        </div>
      </aside>

      <main className="main">
        {selectedJobId ? (
          <JobDetail />
        ) : tab === 'board' ? (
          <Board />
        ) : tab === 'approvals' ? (
          <Approvals />
        ) : tab === 'inbox' ? (
          <Inbox />
        ) : (
          <Costs />
        )}
      </main>
    </div>
  );
}
