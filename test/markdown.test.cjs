const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderMarkdown, renderInline, parseBlocks } = require('../dist/markdown');
test('inline markup: code, bold, italic, strikethrough, links', () => {
  assert.equal(renderInline('Use `Set` and **keep** order'), 'Use <code>Set</code> and <strong>keep</strong> order');
  assert.equal(renderInline('*italic* and _also_ but snake_case_name and 2*3*4'), '<em>italic</em> and <em>also</em> but snake_case_name and 2*3*4');
  assert.equal(renderInline('__strong__ ~~gone~~'), '<strong>strong</strong> <del>gone</del>');
  assert.equal(renderInline('see [docs](https://example.com/a?b=1)'), 'see <a href="https://example.com/a?b=1" title="https://example.com/a?b=1">docs</a>');
  assert.equal(renderInline('[x](javascript:alert(1))'), '[x](javascript:alert(1))', 'unsafe schemes stay literal');
  assert.equal(renderInline('`**not bold**`'), '<code>**not bold**</code>', 'code spans are protected from other inline rules');
});
test('everything is escaped before markup is added', () => {
  assert.equal(renderMarkdown('<script>alert(1)</script> & "quotes"'), '<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;</p>');
  assert.equal(renderMarkdown('```html\n<b>x</b>\n```'), '<pre class="code" data-lang="html"><code>&lt;b&gt;x&lt;/b&gt;</code></pre>');
  const link = renderMarkdown('[a](https://x.y/"onclick="1)');
  assert.doesNotMatch(link, /[^;]"onclick/, 'quotes inside a URL cannot close the attribute');
  assert.match(link, /href="https:\/\/x\.y\/&quot;onclick=&quot;1"/);
});
test('fenced code keeps content verbatim and does not interpret markdown inside', () => {
  const md = 'Before\n\n```ts\nfunction dedupe(items: readonly string[]): string[] {\n  return [...new Set(items)]; // **not bold**\n}\n```\nAfter';
  assert.equal(renderMarkdown(md), '<p>Before</p><pre class="code" data-lang="ts"><code>function dedupe(items: readonly string[]): string[] {\n  return [...new Set(items)]; // **not bold**\n}</code></pre><p>After</p>');
  assert.equal(renderMarkdown('~~~\nx\n~~~'), '<pre class="code"><code>x</code></pre>');
  assert.equal(renderMarkdown('```\nunterminated'), '<pre class="code"><code>unterminated</code></pre>');
});
test('headings, rules, quotes, lists and paragraphs', () => {
  assert.equal(renderMarkdown('## Edge cases\n\n- empty array\n- **all** duplicates\n  continued\n\n1. first\n2) second\n\n---\n> quoted *text*\n> more'),
    '<h2>Edge cases</h2><ul><li>empty array</li><li><strong>all</strong> duplicates<br>continued</li></ul><ol><li>first</li><li>second</li></ol><hr><blockquote><p>quoted <em>text</em><br>more</p></blockquote>');
  assert.equal(renderMarkdown('line one\nline two\n\nnext para'), '<p>line one<br>line two</p><p>next para</p>');
  assert.equal(renderMarkdown('\n\n'), '');
});
test('simple GFM tables', () => {
  assert.equal(renderMarkdown('| Case | Result |\n|---|:---:|\n| empty | `[]` |\n| a \\| b | ok |'),
    '<table><thead><tr><th>Case</th><th>Result</th></tr></thead><tbody><tr><td>empty</td><td><code>[]</code></td></tr><tr><td>a | b</td><td>ok</td></tr></tbody></table>');
  assert.equal(renderMarkdown('not | a table'), '<p>not | a table</p>');
});
test('parseBlocks tolerates CRLF and mixed content', () => {
  const blocks = parseBlocks('# T\r\n\r\ntext\r\n- a\r\n```\r\nc\r\n```');
  assert.deepEqual(blocks.map(b => b.kind), ['h', 'p', 'ul', 'code']);
});
