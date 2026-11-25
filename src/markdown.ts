// Small, dependency-free Markdown renderer for agent replies. No VS Code imports.
// Every piece of source text is HTML-escaped before any markup is added, and link targets are limited to safe schemes.
const SAFE_LINK = /^(https?:|mailto:)/i;
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}
/** Inline markup: code spans, bold, italic, strikethrough and links. Operates on escaped text. */
export function renderInline(text: string): string {
  const codes: string[] = [];
  let out = escapeHtml(text).replace(/`([^`\n]+)`/g, (_, code: string) => { codes.push(`<code>${code}</code>`); return `\u0000${codes.length - 1}\u0000`; });
  out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label: string, href: string) => SAFE_LINK.test(href) ? `<a href="${href}" title="${href}">${label}</a>` : match);
  out = out.replace(/(\*\*|__)(?=\S)([\s\S]+?)(?<=\S)\1/g, '<strong>$2</strong>');
  out = out.replace(/(^|[^\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?!\w)/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^\w_])_(?=\S)([^_\n]+?)(?<=\S)_(?!\w)/g, '$1<em>$2</em>');
  out = out.replace(/~~(?=\S)([^~\n]+?)(?<=\S)~~/g, '<del>$1</del>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, index: string) => codes[Number(index)]);
}
type Block = { kind: 'p' | 'ul' | 'ol' | 'quote'; lines: string[] } | { kind: 'code'; lang: string; lines: string[] } | { kind: 'h'; level: number; text: string } | { kind: 'hr' } | { kind: 'table'; rows: string[][] };
function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map(cell => cell.replace(/\\\|/g, '|').trim());
}
const isTableDivider = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');
/** Splits Markdown into blocks: fenced code, headings, lists, quotes, rules, tables and paragraphs. */
export function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  const last = () => blocks[blocks.length - 1];
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*(`{3,}|~{3,})\s*(\S*)/);
    if (fence) {
      const body: string[] = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1].slice(0, 3))) body.push(lines[i++]);
      i++;
      blocks.push({ kind: 'code', lang: fence[2], lines: body }); continue;
    }
    if (!line.trim()) { i++; continue; }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) { blocks.push({ kind: 'h', level: heading[1].length, text: heading[2] }); i++; continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { blocks.push({ kind: 'hr' }); i++; continue; }
    if (line.includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      const rows = [splitRow(line)]; i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
      blocks.push({ kind: 'table', rows }); continue;
    }
    const quote = line.match(/^\s{0,3}>\s?(.*)$/);
    if (quote) { const prev = last(); if (prev?.kind === 'quote') prev.lines.push(quote[1]); else blocks.push({ kind: 'quote', lines: [quote[1]] }); i++; continue; }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const number = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || number) {
      const kind = bullet ? 'ul' : 'ol'; const text = (bullet ?? number)![1];
      const prev = last();
      if (prev?.kind === kind) prev.lines.push(text); else blocks.push({ kind, lines: [text] });
      i++;
      // Continuation lines indented under the item belong to it.
      while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s/.test(lines[i])) { const item = last() as { lines: string[] }; item.lines[item.lines.length - 1] += '\n' + lines[i].trim(); i++; }
      continue;
    }
    const prev = last();
    if (prev?.kind === 'p' && lines[i - 1]?.trim()) prev.lines.push(line.trim()); else blocks.push({ kind: 'p', lines: [line.trim()] });
    i++;
  }
  return blocks;
}
/** Markdown to HTML. Unknown or unsafe constructs degrade to escaped text. */
export function renderMarkdown(markdown: string): string {
  return parseBlocks(markdown).map(block => {
    switch (block.kind) {
      case 'code': return `<pre class="code"${block.lang ? ` data-lang="${escapeHtml(block.lang)}"` : ''}><code>${escapeHtml(block.lines.join('\n'))}</code></pre>`;
      case 'h': return `<h${block.level}>${renderInline(block.text)}</h${block.level}>`;
      case 'hr': return '<hr>';
      case 'quote': return `<blockquote>${renderMarkdown(block.lines.join('\n'))}</blockquote>`;
      case 'ul': case 'ol': return `<${block.kind}>${block.lines.map(item => `<li>${renderInline(item).replace(/\n/g, '<br>')}</li>`).join('')}</${block.kind}>`;
      case 'table': {
        const [head, ...body] = block.rows;
        const row = (cells: string[], tag: 'th' | 'td') => `<tr>${cells.map(cell => `<${tag}>${renderInline(cell)}</${tag}>`).join('')}</tr>`;
        return `<table><thead>${row(head, 'th')}</thead>${body.length ? `<tbody>${body.map(cells => row(cells, 'td')).join('')}</tbody>` : ''}</table>`;
      }
      case 'p': return `<p>${block.lines.map(renderInline).join('<br>')}</p>`;
    }
  }).join('');
}
