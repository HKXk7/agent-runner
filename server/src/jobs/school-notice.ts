import type { JobDefinition, StepResult } from '@agent-runner/shared';
import { readFileSync } from 'node:fs';
import { writeDigest } from './digest.js';
import { extractNotices, originOf, type NoticeItem } from './html-parse.js';

export interface SchoolNoticePayload {
  sources?: { name: string; url: string }[];
  approve?: boolean; // 摘要写收件箱前是否需要人工审批（默认 true）
  mock?: boolean;    // 强制使用 fixture（默认：无 OPENAI_API_KEY 或 AGENT_RUNNER_MOCK=1 时）
}

/**
 * 真实通知源（东华理工教务处「通知公告」栏目，sudy 系统，实测可访问）。
 * 有 OPENAI_API_KEY 时抓真实页；无 key 时走 fixture 零网络演示。
 * 多源可扩展：payload.sources 追加即可（如竞赛栏目）。
 */
const DEFAULT_SOURCES = [
  { name: '通知公告', url: 'https://jwc.ecut.edu.cn/1048/list.htm' },
];

const FIXTURES: Record<string, string> = {
  通知公告: 'jwc-notices.html',
  学科竞赛: 'contest-notices.html',
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

function useMock(p: SchoolNoticePayload): boolean {
  // 零 key 演示模式：无真实 LLM key 时整条流水线自动走 fixture（LLM 也是 mock）。
  // 有 key 且想强制离线演示可设 payload.mock=true；有 key 且确要抓真实页可设 mock=false。
  const hasKey = !!process.env.OPENAI_API_KEY;
  return p.mock !== false && (!hasKey || p.mock === true || process.env.AGENT_RUNNER_MOCK === '1');
}

/** 带指数退避的抓取（网络抖动/瞬时 5xx 重试，不把瞬时故障变成 job 失败） */
async function fetchWithRetry(url: string, attempts = 3): Promise<string> {
  let lastErr: unknown = new Error('fetch failed');
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
        headers: { 'user-agent': UA },
        redirect: 'follow',
      });
      if (res.ok) return await res.text();
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * 2 ** i));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * school_notice —— 真实任务：每日教务/竞赛通知抓取 -> LLM 摘要 -> 收件箱推送。
 * 四步：fetch -> extract -> summarize(LLM) -> publish(审批门 + 写收件箱 + markdown 归档)
 * Mock 路径：fixture HTML + MockProvider，零 key 零网络全链路可演示。
 * 真实路径：抓真实列表页 -> 鲁棒解析（sudy/date+title 多结构）-> LLM 摘要。
 */
export const schoolNotice: JobDefinition = {
  type: 'school_notice',
  description: '每日教务/竞赛通知抓取 -> LLM 摘要 -> 收件箱 + markdown 归档',
  defaultBudget: { tokens: 30_000, costUsd: 0.05 },
  steps: [
    {
      name: 'fetch_notices',
      // 抓取是网络操作，瞬时故障常见：重试 2 次（指数退避）
      maxRetries: 2,
      retryDelayMs: 1000,
      async run(ctx): Promise<StepResult> {
        const p = (ctx.payload ?? {}) as SchoolNoticePayload;
        const sources = p.sources?.length ? p.sources : DEFAULT_SOURCES;
        const pages: { source: string; html: string; via: 'fixture' | 'network' }[] = [];

        for (const s of sources) {
          if (useMock(p)) {
            const file = FIXTURES[s.name];
            if (!file) throw new Error(`no fixture for source "${s.name}"`);
            pages.push({
              source: s.name,
              html: readFileSync(new URL(`../../fixtures/${file}`, import.meta.url), 'utf-8'),
              via: 'fixture',
            });
          } else {
            const html = await fetchWithRetry(s.url);
            pages.push({ source: s.name, html, via: 'network' });
          }
        }
        return { output: { pages } };
      },
    },
    {
      name: 'extract_items',
      async run(ctx): Promise<StepResult> {
        const prev = ctx.prev as {
          pages: { source: string; html: string }[];
        };
        // 需要 origin 做相对链接补全：从原始 payload 拿 URL（fixture 无 origin 则留空）
        const p = (ctx.payload ?? {}) as SchoolNoticePayload;
        const srcMap = new Map((p.sources?.length ? p.sources : DEFAULT_SOURCES).map((s) => [s.name, s.url]));

        const items: NoticeItem[] = [];
        for (const page of prev.pages) {
          const base = srcMap.get(page.source) ? originOf(srcMap.get(page.source)!) : '';
          items.push(...extractNotices(page.html, page.source, base));
        }
        if (items.length === 0) {
          throw new Error('extracted 0 items — page structure may have changed');
        }
        return { output: { items } };
      },
    },
    {
      name: 'summarize',
      maxRetries: 1, // LLM 瞬时失败重试一次
      retryDelayMs: 2000,
      async run(ctx): Promise<StepResult> {
        const prev = ctx.prev as { items: { source: string; title: string; date: string }[] };
        const prompt = [
          '请把以下学校通知整理成一份给学生看的 markdown 日报：按来源分组、标注日期、合并同类提醒。',
          ...prev.items.map((it) => `- [${it.source}] ${it.title} | ${it.date}`),
        ].join('\n');
        const res = await ctx.llm.complete({
          system: '你是校园信息助手，把通知整理为清晰的 markdown 日报。',
          prompt,
        });
        return {
          output: { digestMd: res.text },
          usage: { tokensIn: res.tokensIn, tokensOut: res.tokensOut, costUsd: res.costUsd },
        };
      },
    },
    {
      name: 'publish_digest',
      // 默认开审批：推给学生看的内容先过人工一眼（payload.approve=false 可关）
      requiresApproval: (payload) => ((payload ?? {}) as SchoolNoticePayload).approve !== false,
      async run(ctx): Promise<StepResult> {
        const prev = ctx.prev as { digestMd: string };
        const day = new Date().toLocaleDateString('zh-CN');
        const digest = writeDigest(ctx.jobId, `📚 校园通知日报 - ${day}`, prev.digestMd);
        return { output: { digestId: digest.id } };
      },
    },
  ],
};
