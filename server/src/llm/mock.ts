import type { LLMProvider, LLMRequest, LLMResponse } from '@agent-runner/shared';

/**
 * MockProvider —— 零 key、零网络、确定性。
 *
 * 关键设计：不是返回 "Hello mock"，而是对 prompt 做确定性"摘要"：
 *   1. 抽取 prompt 中形如 "- [来源] 标题 | 日期" 的条目行
 *   2. 生成结构化 markdown 汇总（分组、编号）
 *   3. 模拟 token 用量（CJK ~2 字符/token）并按公开牌价计费
 * 这样整条 school-notice 流水线在无任何 API key 时也能产出
 * 真实形态的日报，且成本熔断可被小预算真实触发。
 */
// gpt-4o-mini 牌价（$/1M tokens）：输入 0.15 / 输出 0.60
const PRICE_IN = 0.15 / 1_000_000;
const PRICE_OUT = 0.6 / 1_000_000;

export class MockProvider implements LLMProvider {
  readonly name = 'mock';

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const text = this.summarize(req.prompt);
    // 轻微延迟，模拟网络往返，让 SSE 时间轴有真实感
    await sleep(150 + (hash(req.prompt) % 250));
    const tokensIn = Math.ceil((req.system?.length ?? 0 + req.prompt.length) / 2);
    const tokensOut = Math.ceil(text.length / 2);
    return {
      text,
      tokensIn,
      tokensOut,
      costUsd: tokensIn * PRICE_IN + tokensOut * PRICE_OUT,
    };
  }

  private summarize(prompt: string): string {
    const lines = prompt.split('\n');
    // 条目行格式: "- [来源] 标题 | 日期"
    const items = lines
      .filter((l) => l.trim().startsWith('- ['))
      .map((l) => {
        const m = l.trim().match(/^-\s+\[([^\]]+)\]\s+(.+?)(?:\s*\|\s*(.+))?$/);
        return m ? { source: m[1]!, title: m[2]!, date: m[3] ?? '' } : null;
      })
      .filter((x): x is { source: string; title: string; date: string } => x !== null);

    if (items.length === 0) {
      // 通用确定性输出：取 prompt 前 400 字符做"分析"
      const head = prompt.replace(/\s+/g, ' ').slice(0, 400);
      return [
        '## 分析结果（mock provider）',
        '',
        `输入共 ${prompt.length} 字符，要点提取如下：`,
        '',
        `- 摘要：${head}...`,
        `- 确定性输出：seed=${hash(prompt)}`,
      ].join('\n');
    }

    const bySource = new Map<string, { title: string; date: string }[]>();
    for (const it of items) {
      const arr = bySource.get(it.source) ?? [];
      arr.push({ title: it.title, date: it.date });
      bySource.set(it.source, arr);
    }

    const out: string[] = ['## 今日通知汇总（mock provider）', ''];
    for (const [source, list] of bySource) {
      out.push(`### ${source}（${list.length} 条）`, '');
      list.forEach((it, i) => {
        out.push(`${i + 1}. ${it.title}${it.date ? `（${it.date}）` : ''}`);
      });
      out.push('');
    }
    out.push(`> 共 ${items.length} 条通知，由 mock 确定性摘要生成。`);
    return out.join('\n');
  }
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
