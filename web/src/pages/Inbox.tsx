import { useState } from 'react';
import { useStore } from '../store.js';
import { mdToHtml } from '../md.js';
import { fmtTime } from '../ui.jsx';
import type { DigestItem } from '@agent-runner/shared';

export function Inbox() {
  const { digests } = useStore();
  const [expanded, setExpanded] = useState<string | null>(null);

  if (digests.length === 0) {
    return (
      <div className="page">
        <header className="page-head">
          <div>
            <h1>收件箱</h1>
            <p className="muted">任务产出的摘要推送（DB 行 + 本地 markdown 归档）</p>
          </div>
        </header>
        <div className="empty">
          <div className="empty-icon">✉</div>
          <p>暂无摘要。跑一条 demo_pipeline 或 school_notice 后，产物会出现在这里。</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>收件箱</h1>
          <p className="muted">任务产出的摘要推送 · 点击展开阅读</p>
        </div>
      </header>

      <div className="digest-list">
        {digests.map((d) => (
          <DigestCard
            key={d.id}
            d={d}
            open={expanded === d.id}
            onToggle={() => setExpanded(expanded === d.id ? null : d.id)}
          />
        ))}
      </div>
    </div>
  );
}

function DigestCard({ d, open, onToggle }: { d: DigestItem; open: boolean; onToggle: () => void }) {
  return (
    <div className="digest-card">
      <button className="digest-head" onClick={onToggle}>
        <span className="digest-title">{d.title}</span>
        <span className="digest-meta">{fmtTime(d.createdAt)}</span>
        <span className="step-toggle">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="digest-body" dangerouslySetInnerHTML={{ __html: mdToHtml(d.bodyMd) }} />
      )}
    </div>
  );
}
