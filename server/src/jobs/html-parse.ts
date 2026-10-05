/**
 * 高校通知列表页的鲁棒 HTML 解析。
 *
 * 真实页面结构千差万别，这里按优先级尝试多种模式（东华理工实测为 sudy 系统）：
 *   模式 A（sudy 新闻列表）：<span class="news_title"><a title='标题'>…</a></span>
 *                           <span class="news_meta">日期</span>
 *   模式 B（date+a）：<span class="date">日期</span><a href title="标题">…
 *   模式 C（通用兜底）：任何 <a title="非空">，日期就近抓取。
 * 相对链接自动补全为绝对地址。
 */

export interface NoticeItem {
  source: string;
  title: string;
  date: string;
  link: string | null;
}

/** 从来源 URL 解析 origin（如 https://jwc.ecut.edu.cn），用于相对链接补全 */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function absolute(href: string | undefined, base: string): string | null {
  if (!href) return null;
  const h = href.trim();
  if (/^https?:\/\//i.test(h)) return h;
  if (h.startsWith('/')) return base + h;
  return `${base}/${h}`;
}

function normalizeTitle(t: string): string {
  return t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

/** 主入口：从一个 HTML 页面提取通知条目 */
export function extractNotices(html: string, source: string, baseUrl?: string): NoticeItem[] {
  const base = baseUrl ?? '';

  // ---- 模式 A：sudy 系统 news_title + news_meta ----
  const titles: { title: string; href: string }[] = [];
  const titleRe =
    /<span[^>]*class=["']news_title["'][^>]*>\s*<a[^>]*href=["']([^"']+)["'][^>]*title=["']([^"']*)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = titleRe.exec(html))) titles.push({ href: m[1]!, title: normalizeTitle(m[2]!) });

  const dates: string[] = [];
  const dateRe = /<span[^>]*class=["']news_meta["'][^>]*>([^<]+)<\/span>/gi;
  while ((m = dateRe.exec(html))) dates.push(m[1]!.trim());

  if (titles.length > 0) {
    return titles.map((t, i) => ({
      source,
      title: t.title,
      date: dates[i] ?? '',
      link: absolute(t.href, base),
    }));
  }

  // ---- 模式 B：date span + a[title]（双引号或单引号） ----
  const itemsB: NoticeItem[] = [];
  const reB =
    /<span[^>]*class=["']date["'][^>]*>([^<]+)<\/span>\s*<a[^>]*href=["']([^"']+)["'][^>]*title=["']([^"']+)["']/gi;
  while ((m = reB.exec(html))) {
    itemsB.push({ source, date: m[1]!.trim(), link: absolute(m[2]!, base), title: normalizeTitle(m[3]!) });
  }
  if (itemsB.length > 0) return itemsB;

  // ---- 模式 C：通用兜底 —— 所有带 title 的 <a>，日期就近 ----
  const itemsC: NoticeItem[] = [];
  const reC = /<a[^>]*href=["']([^"']+)["'][^>]*title=["']([^"']{2,})["'][^>]*>/gi;
  const allDates = [...html.matchAll(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/g)].map((x) => x[0]);
  let idx = 0;
  while ((m = reC.exec(html))) {
    const title = normalizeTitle(m[2]!);
    if (!title || title.includes('返回') || title.includes('首页')) continue;
    itemsC.push({ source, title, date: allDates[idx++] ?? '', link: absolute(m[1]!, base) });
  }
  return itemsC;
}
