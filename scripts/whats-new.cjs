#!/usr/bin/env node
// Release notes → the website's "What's new" page, the GitHub Release text,
// and a check that a version has notes before it ships. Modelled on Kube Console's.
//
// Notes live in release-notes/<version>/notes.json, with screenshots next to
// them as <image>-light.png and <image>-dark.png. A highlight with
// "size": "compact" shows a smaller picture with the text beside it.
// Regenerate screenshots with scripts/screenshots.cjs.
//
//   node scripts/whats-new.cjs check <version>
//   node scripts/whats-new.cjs markdown <version>
//   node scripts/whats-new.cjs site <site folder> [--upto <version>]
//
// "site" writes whats-new/index.html and its screenshots, keeps sitemap.xml
// current, and refreshes the "New in …" pill on the homepage (between the
// <!-- whats-new:pill --> markers). --upto leaves out versions newer than the
// last released one, so notes written ahead of a release stay off the site.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NOTES = path.join(ROOT, 'release-notes');
const SITE_URL = 'https://sibinms.github.io/turnhuddle';
const MARKETPLACE = 'https://marketplace.visualstudio.com/items?itemName=Turnhuddle.turnhuddle';
const RELEASES = 'https://github.com/sibinms/turnhuddle/releases';

const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
const cmp = (a, b) => { const pa = a.split('.').map(Number), pb = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]; return 0; };

// ---------- reading and checking notes ----------
function load(version) {
  const file = path.join(NOTES, version, 'notes.json');
  if (!fs.existsSync(file)) return null;
  let n;
  try { n = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { fail(`${path.relative(ROOT, file)} isn't valid JSON: ${e.message}`); }
  return { highlights: [], improvements: [], fixes: [], ...n, dir: path.dirname(file) };
}
function problems(n, version) {
  const out = [];
  if (n.version !== version) out.push(`"version" says ${n.version}, but the folder is ${version}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(n.date || '')) out.push('"date" must look like 2026-11-25');
  if (!n.headline) out.push('"headline" is missing');
  if (!n.summary) out.push('"summary" is missing');
  for (const [i, h] of n.highlights.entries()) {
    if (!h.title || !h.text) out.push(`highlight ${i + 1} needs a "title" and "text"`);
    if (h.image) {
      for (const t of ['light', 'dark']) if (!fs.existsSync(path.join(n.dir, `${h.image}-${t}.png`))) out.push(`highlight ${i + 1}: ${h.image}-${t}.png is missing`);
      if (!h.alt) out.push(`highlight ${i + 1}: "alt" (a description of the screenshot) is missing`);
    }
  }
  return out;
}
function all(upto) {
  const versions = fs.readdirSync(NOTES).filter((v) => /^\d+\.\d+\.\d+$/.test(v) && (!upto || cmp(v, upto) <= 0));
  return versions.map(load).filter(Boolean).sort((a, b) => cmp(b.version, a.version));
}

// ---------- text helpers ----------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// **bold** and `code`, nothing else.
const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
const longDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const anchor = (v) => `v${v}`;

// ---------- GitHub Release text ----------
function markdown(n) {
  const img = (h, t) => `${SITE_URL}/whats-new/${n.version}/${h.image}-${t}.png`;
  const lines = [`## ${n.headline}`, '', n.summary, ''];
  for (const h of n.highlights) {
    lines.push(`### ${h.title}`, '', h.text, '');
    if (h.image) lines.push(`![${h.alt}](${img(h, 'light')})`, '');
  }
  if (n.improvements.length) lines.push('### Improvements', '', ...n.improvements.map((x) => `- ${x}`), '');
  if (n.fixes.length) lines.push('### Fixes', '', ...n.fixes.map((x) => `- ${x}`), '');
  lines.push(`Install from the [Visual Studio Marketplace](${MARKETPLACE}), or download the VSIX below and use **Extensions: Install from VSIX…**.`, '');
  lines.push(`[See every release, with screenshots →](${SITE_URL}/whats-new/#${anchor(n.version)})`);
  return lines.join('\n');
}

// ---------- the page ----------
const ICON = {
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L3 17.8V21h3.2l6.3-6.3a4 4 0 0 0 5.2-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>'
};
const svg = (name, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

function picture(n, h, eager) {
  const base = `${n.version}/${h.image}`;
  return `<figure class="shot">
            <div class="chrome"><i></i><i></i><i></i><span>Turnhuddle ${esc(n.version)} · VS Code</span></div>
            <picture>
              <source srcset="${base}-dark.png" media="(prefers-color-scheme: dark)" />
              <img src="${base}-light.png" width="1800" height="1200" alt="${esc(h.alt)}" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} />
            </picture>
          </figure>`;
}

function release(n, i) {
  const latest = i === 0;
  const highlights = n.highlights.map((h, j) => `
        <div class="hl${h.size === 'compact' ? ' compact' : ''}">
          ${h.image ? picture(n, h, latest && j === 0) : ''}
          <div class="hl-text">
            ${h.tag ? `<span class="tag">${esc(h.tag)}</span>` : ''}
            <h3>${inline(h.title)}</h3>
            <p>${inline(h.text)}</p>
          </div>
        </div>`).join('');
  const list = (items, icon, title) => (items.length ? `
          <div class="list">
            <h4>${svg(icon, 16)}${title}</h4>
            <ul>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>
          </div>` : '');
  const lists = list(n.improvements, 'spark', 'Improvements') + list(n.fixes, 'wrench', 'Fixes');
  return `
      <article class="release${n.highlights.some((h) => h.image) ? '' : ' quiet'}" id="${anchor(n.version)}">
        <header>
          <div class="meta">
            <span class="ver">${esc(n.version)}</span>
            ${latest ? '<span class="latest">Latest</span>' : ''}
            <time datetime="${n.date}">${longDate(n.date)}</time>
            <a class="permalink" href="#${anchor(n.version)}" title="Link to ${esc(n.version)}" aria-label="Link to version ${esc(n.version)}">${svg('link', 15)}</a>
          </div>
          <h2>${inline(n.headline)}</h2>
          <p class="summary">${inline(n.summary)}</p>
        </header>${highlights}${lists ? `
        <div class="lists">${lists}
        </div>` : ''}
      </article>`;
}

function page(notes) {
  const latest = notes[0];
  const ogImage = latest.highlights.find((h) => h.image);
  const desc = `What's new in Turnhuddle, the VS Code extension where Claude Code and Codex work a task together until they agree: every release explained with screenshots. Latest: ${latest.version}, ${latest.headline}.`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>What's new in Turnhuddle · Release notes</title>
  <meta name="description" content="${esc(desc)}" />
  <link rel="canonical" href="${SITE_URL}/whats-new/" />
  <meta name="theme-color" content="#d97757" />
  <link rel="icon" type="image/png" href="../icon.png" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Turnhuddle" />
  <meta property="og:title" content="What's new in Turnhuddle ${esc(latest.version)}" />
  <meta property="og:description" content="${esc(latest.headline)}. ${esc(latest.summary)}" />
  <meta property="og:url" content="${SITE_URL}/whats-new/" />
  <meta property="og:image" content="${ogImage ? `${SITE_URL}/whats-new/${latest.version}/${ogImage.image}-light.png` : `${SITE_URL}/screenshots/og-poster.png`}" />
  <meta name="twitter:card" content="summary_large_image" />
  <!-- Built by scripts/whats-new.cjs; edit release-notes/, not this file. -->
  <link rel="stylesheet" href="../site.css" />
  <style>
    html { scroll-padding-top: 84px; }
    .hero { padding: 72px 0 40px; text-align: left; position: relative; overflow: hidden; }
    .hero::before { content: ''; position: absolute; inset: -40% -10% auto; height: 520px; background: radial-gradient(closest-side, color-mix(in srgb, var(--claude) 14%, transparent), transparent), radial-gradient(closest-side at 70% 40%, color-mix(in srgb, var(--codex) 12%, transparent), transparent); pointer-events: none; }
    .hero .wrap { position: relative; }
    .hero h1 { font-size: clamp(38px, 6vw, 64px); margin: 0 0 16px; max-width: 820px; }
    .hero .lead { margin: 0 0 26px; max-width: 660px; }
    .auto { display: inline-flex; align-items: center; gap: 10px; font-size: 14.5px; color: var(--muted); background: var(--card); border: 1px solid var(--line); border-radius: 999px; padding: 7px 14px 7px 8px; }
    .auto b { color: var(--ok); background: var(--ok-soft); border-radius: 999px; padding: 2px 9px; font-size: 12.5px; }
    .layout { display: grid; grid-template-columns: 210px minmax(0, 1fr); gap: 56px; padding-top: 24px; padding-bottom: 96px; }
    .toc { position: sticky; top: 92px; align-self: start; }
    .toc h4 { font-size: 12.5px; text-transform: uppercase; letter-spacing: .08em; color: var(--faint); margin: 0 0 12px; }
    .toc ol { list-style: none; margin: 0; padding: 0 0 0 14px; border-left: 2px solid var(--line); display: grid; gap: 4px; }
    .toc a { display: block; position: relative; padding: 6px 10px; border-radius: 8px; color: var(--muted); font-size: 15px; }
    .toc a::before { content: ''; position: absolute; left: -21px; top: 13px; width: 10px; height: 10px; border-radius: 50%; background: var(--bg); border: 2px solid var(--line); }
    .toc a:hover { background: var(--card); color: var(--text); text-decoration: none; }
    .toc a.on { color: var(--text); font-weight: 600; background: var(--card); }
    .toc a.on::before { border-color: var(--claude); background: var(--claude); }
    .toc small { display: block; color: var(--faint); font-size: 12.5px; font-weight: 400; }
    .release { padding: 0 0 72px; margin: 0 0 72px; border-bottom: 1px solid var(--line); }
    .release:last-child { border-bottom: 0; margin-bottom: 0; }
    .meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
    .ver { font: 700 14px/1 ui-monospace, "SF Mono", Menlo, monospace; color: #fff; background: linear-gradient(100deg, var(--claude), var(--codex)); padding: 7px 11px; border-radius: 9px; letter-spacing: .02em; }
    .latest { font-size: 12.5px; font-weight: 700; color: var(--ok); background: var(--ok-soft); padding: 4px 10px; border-radius: 999px; }
    time { color: var(--faint); font-size: 15px; }
    .permalink { color: var(--faint); opacity: 0; transition: opacity .15s; display: inline-flex; }
    .release:hover .permalink, .permalink:focus { opacity: 1; }
    .release h2 { font-size: clamp(27px, 3.6vw, 38px); line-height: 1.12; letter-spacing: -0.025em; margin: 0 0 12px; }
    .summary { color: var(--muted); font-size: 19px; margin: 0 0 36px; max-width: 720px; }
    .release.quiet h2 { font-size: 24px; }
    .release.quiet .summary { font-size: 17px; margin-bottom: 24px; }
    .hl { margin: 0 0 40px; }
    .release .shot { margin: 0 0 22px; }
    .hl-text { max-width: 720px; }
    .hl.compact { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 32px; align-items: center; }
    .hl.compact .shot { margin: 0; }
    .hl .tag { display: inline-block; font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--accent); background: var(--accent-soft); padding: 3px 9px; border-radius: 6px; margin-bottom: 10px; }
    .hl h3 { font-size: 22px; letter-spacing: -0.015em; margin: 0 0 8px; }
    .hl p { margin: 0; color: var(--muted); }
    .hl p strong { color: var(--text); }
    .lists { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 18px; }
    .list { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 20px 22px; }
    .list h4 { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; font-size: 15px; color: var(--accent); }
    .list ul { margin: 0; padding: 0 0 0 18px; color: var(--muted); font-size: 16px; display: grid; gap: 8px; }
    .list strong { color: var(--text); }
    .cta { text-align: center; padding: 72px 24px; background: var(--bg-2); }
    .cta h2 { font-size: clamp(26px, 3.4vw, 36px); letter-spacing: -0.02em; margin: 0 0 10px; }
    .cta p { color: var(--muted); margin: 0 0 24px; }
    @media (max-width: 900px) {
      .layout { grid-template-columns: 1fr; gap: 8px; }
      .toc { position: static; }
      .toc ol { display: flex; flex-wrap: wrap; border-left: 0; padding: 0; gap: 8px; }
      .toc a { border: 1px solid var(--line); background: var(--card); }
      .toc a::before { display: none; }
      .toc small { display: none; }
      .release { padding-bottom: 48px; margin-bottom: 48px; }
      .hl.compact { grid-template-columns: 1fr; gap: 18px; }
    }
    @media (max-width: 520px) { .hero { padding-top: 48px; } }
  </style>
</head>
<body>
  <nav>
    <div class="wrap">
      <a class="brand" href="../"><img src="../icon.png" alt="" width="30" height="30" />Turnhuddle</a>
      <div class="navlinks">
        <a href="../#how">How it works</a>
        <a href="../#features">Features</a>
        <a class="on" href="./" aria-current="page">What's new</a>
        <a class="btn primary small" href="${MARKETPLACE}">Install</a>
      </div>
    </div>
  </nav>

  <main>
    <header class="hero">
      <div class="wrap">
        <div class="kicker">Release notes</div>
        <h1>What's new in <span class="grad">Turnhuddle</span></h1>
        <p class="lead">Every release, explained with pictures. The latest is <a href="#${anchor(latest.version)}">${esc(latest.version)}</a>, out ${longDate(latest.date)}.</p>
        <div class="auto"><b>Automatic</b> VS Code updates extensions from the Marketplace for you, so new versions arrive on their own.</div>
      </div>
    </header>

    <div class="wrap layout">
      <aside class="toc" aria-label="Versions">
        <h4>Versions</h4>
        <ol>${notes.map((n, i) => `
          <li><a href="#${anchor(n.version)}"${i === 0 ? ' class="on"' : ''}>${esc(n.version)}<small>${longDate(n.date)}</small></a></li>`).join('')}
        </ol>
      </aside>
      <div>${notes.map(release).join('\n')}
      </div>
    </div>

    <section class="cta">
      <h2>Try the latest version</h2>
      <p>Free and open source. Uses the Claude Code and Codex command-line tools you already have.</p>
      <a class="btn primary" href="${MARKETPLACE}">Install Turnhuddle ${esc(latest.version)}</a>
    </section>
  </main>

  <footer>
    <div class="wrap">
      <span>© ${new Date().getFullYear()} Turnhuddle · MIT licence</span>
      <span class="sp"></span>
      <a href="../">Home</a>
      <a href="../privacy.html">Privacy</a>
      <a href="${RELEASES}">All downloads</a>
      <a href="https://github.com/sibinms/turnhuddle">GitHub</a>
    </div>
  </footer>

  <script>
    // Highlight the version you're reading in the side list.
    const links = [...document.querySelectorAll('.toc a')];
    const seen = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) links.forEach((a) => a.classList.toggle('on', a.hash === '#' + e.target.id));
    }, { rootMargin: '-30% 0px -60% 0px' });
    document.querySelectorAll('.release').forEach((r) => seen.observe(r));
  </script>
</body>
</html>
`;
}

// ---------- writing the site ----------
function writeSite(site, notes) {
  if (!fs.existsSync(site)) fail(`${site} doesn't exist`);
  const out = path.join(site, 'whats-new');
  fs.mkdirSync(out, { recursive: true });
  for (const n of notes) {
    const dir = path.join(out, n.version);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(n.dir)) if (f.endsWith('.png')) fs.copyFileSync(path.join(n.dir, f), path.join(dir, f));
  }
  fs.writeFileSync(path.join(out, 'index.html'), page(notes));
  console.log(`  wrote whats-new/index.html (${notes.map((n) => n.version).join(', ')})`);

  const latest = notes[0];
  const sitemap = path.join(site, 'sitemap.xml');
  if (fs.existsSync(sitemap)) {
    let xml = fs.readFileSync(sitemap, 'utf8');
    const entry = `  <url><loc>${SITE_URL}/whats-new/</loc><lastmod>${latest.date}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`;
    xml = xml.includes('/whats-new/</loc>') ? xml.replace(/ *<url><loc>[^<]*\/whats-new\/<\/loc>.*<\/url>/, entry) : xml.replace('</urlset>', `${entry}\n</urlset>`);
    fs.writeFileSync(sitemap, xml);
    console.log('  updated sitemap.xml');
  }

  const home = path.join(site, 'index.html');
  if (fs.existsSync(home)) {
    const html = fs.readFileSync(home, 'utf8');
    const re = /(<!-- whats-new:pill -->)[\s\S]*?(<!-- \/whats-new:pill -->)/;
    if (re.test(html)) {
      const pill = `<a class="pill" href="whats-new/#${anchor(latest.version)}"><b>New in ${esc(latest.version)}</b> · ${inline(latest.pill || latest.headline)} →</a>`;
      fs.writeFileSync(home, html.replace(re, `$1${pill}$2`));
      console.log('  updated the homepage pill');
    }
  }
}

// ---------- command line ----------
const [cmd, arg, ...rest] = process.argv.slice(2);
if (cmd === 'check') {
  if (!arg) fail('Usage: whats-new.cjs check <version>');
  const n = load(arg);
  if (!n) fail(`No release notes for ${arg}. Add release-notes/${arg}/notes.json (see "Publication" in README.md).`);
  const p = problems(n, arg);
  if (p.length) fail(`Release notes for ${arg} need fixing:\n  - ${p.join('\n  - ')}`);
  console.log(`✓ Release notes for ${arg}: ${n.highlights.length} highlights, ${n.improvements.length} improvements, ${n.fixes.length} fixes`);
} else if (cmd === 'markdown') {
  const n = load(arg || '');
  if (!n) fail(`No release notes for ${arg}`);
  process.stdout.write(markdown(n));
} else if (cmd === 'site') {
  if (!arg) fail('Usage: whats-new.cjs site <site folder> [--upto <version>]');
  const i = rest.indexOf('--upto');
  const upto = i > -1 && rest[i + 1] ? rest[i + 1].replace(/^v/, '') : null;
  const notes = all(upto);
  if (!notes.length) fail('No released versions have release notes yet.');
  for (const n of notes) { const p = problems(n, n.version); if (p.length) fail(`Release notes for ${n.version} need fixing:\n  - ${p.join('\n  - ')}`); }
  writeSite(path.resolve(arg), notes);
} else {
  fail('Usage: whats-new.cjs check <version> | markdown <version> | site <site folder> [--upto <version>]');
}
