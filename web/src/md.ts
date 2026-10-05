// 极简 markdown -> HTML（收件箱渲染）。转义 HTML 后处理标题/列表/引用。
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function mdToHtml(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let inList = false;

  const closeList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };

  for (const raw of lines) {
    const line = raw;
    if (/^###\s+/.test(line)) {
      closeList();
      out.push(`<h3>${esc(line.replace(/^###\s+/, ''))}</h3>`);
    } else if (/^##\s+/.test(line)) {
      closeList();
      out.push(`<h2>${esc(line.replace(/^##\s+/, ''))}</h2>`);
    } else if (/^#\s+/.test(line)) {
      closeList();
      out.push(`<h1>${esc(line.replace(/^#\s+/, ''))}</h1>`);
    } else if (/^>\s?/.test(line)) {
      closeList();
      out.push(`<blockquote>${esc(line.replace(/^>\s?/, ''))}</blockquote>`);
    } else if (/^[-*]\s+/.test(line)) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${esc(line.replace(/^[-*]\s+/, ''))}</li>`);
    } else if (/^\d+\.\s+/.test(line)) {
      closeList();
      out.push(`<p>${esc(line)}</p>`);
    } else if (line.trim() === '') {
      closeList();
    } else {
      closeList();
      out.push(`<p>${esc(line)}</p>`);
    }
  }
  closeList();
  return out.join('\n');
}
