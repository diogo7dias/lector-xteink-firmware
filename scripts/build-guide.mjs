// Renders the firmware guide page from USER_GUIDE.md in the lector repository.
//
// The guide text has exactly one home: USER_GUIDE.md, edited in the same commit
// as the firmware change it describes. This site never keeps a second copy of
// it. The Pages workflow fetches that file and runs this script; guide.html is
// generated on every deploy and is not committed.
//
// Two rules are enforced here rather than left to review:
//   * markdown this renderer has not been taught throws instead of leaking
//     literal syntax onto the page,
//   * a guide whose `<!-- lector-version: X.Y.Z -->` stamp does not match
//     flash/version.txt fails the build, so a firmware release with an
//     un-updated guide goes red instead of publishing stale instructions.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const escapeHtml = (text) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** "2. Power & Startup" -> "2-power-startup" (matches GitHub's anchors) */
export const slugify = (heading) =>
  heading
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[^a-z0-9 -]/g, "")
    .trim()
    .replace(/ +/g, "-");

/** Inline spans: code first, so nothing rewrites what is inside it. */
const renderInline = (text) => {
  const codeSpans = [];
  let out = text.replace(/`([^`]+)`/g, (_match, code) => {
    codeSpans.push(code);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });

  out = escapeHtml(out);
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, src) => `<img src="${src}" alt="${alt}" />`);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, href) => `<a href="${href}">${label}</a>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");

  // Markdown escapes such as `\&` survive escapeHtml as a backslash before the
  // entity, so both shapes are unescaped here.
  out = out.replace(/\\([\\`*_{}[\]()#+\-.!|])|\\(&amp;|&lt;|&gt;|&quot;)/g, (_m, punctuation, entity) => punctuation ?? entity);

  return out.replace(/\u0000(\d+)\u0000/g, (_m, index) => `<code>${escapeHtml(codeSpans[Number(index)])}</code>`);
};

const isTableSeparator = (line) => /^\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes("-");

const splitRow = (line) =>
  line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

const unsupported = (line, lineNumber) => {
  throw new Error(
    `unsupported markdown on line ${lineNumber}: ${line.trim()}\n` +
      "Teach scripts/build-guide.mjs this syntax, or rewrite the line in USER_GUIDE.md.",
  );
};

/** Renders one list, consuming as many lines as belong to it. Returns [html, nextIndex]. */
const renderList = (lines, start, indent) => {
  const marker = /^( *)([-*]|\d+\.) +(.*)$/;
  const ordered = /^\d+\./.test(lines[start].trim());
  const items = [];
  let index = start;

  while (index < lines.length) {
    const match = lines[index].match(marker);
    if (!match) break;

    const itemIndent = match[1].length;
    if (itemIndent < indent) break;

    if (itemIndent > indent) {
      const [nested, next] = renderList(lines, index, itemIndent);
      items[items.length - 1] += `\n${nested}\n`;
      index = next;
      continue;
    }

    items.push(renderInline(match[3]));
    index += 1;
  }

  const tag = ordered ? "ol" : "ul";
  const body = items.map((item) => `<li>${item}</li>`).join("\n");
  return [`<${tag}>\n${body}\n</${tag}>`, index];
};

/** Turns the markdown subset USER_GUIDE.md uses into the site's markup. */
export const renderMarkdown = (markdown) => {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const lineNumber = index + 1;

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    if (line.startsWith("<!--")) {
      while (index < lines.length && !lines[index].includes("-->")) index += 1;
      index += 1;
      continue;
    }

    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index >= lines.length) throw new Error(`unterminated code fence opened on line ${lineNumber}`);
      index += 1;
      const language = fence[1] ? ` class="lang-${fence[1]}"` : "";
      blocks.push(`<pre><code${language}>${escapeHtml(code.join("\n"))}\n</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,6}) +(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].trim().replace(/ +#+$/, "");
      blocks.push(`<h${level} id="${slugify(text)}">${renderInline(text)}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push("<hr />");
      index += 1;
      continue;
    }

    if (/^ *([-*]|\d+\.) +/.test(line)) {
      const indent = line.match(/^ */)[0].length;
      const [html, next] = renderList(lines, index, indent);
      blocks.push(html);
      index = next;
      continue;
    }

    if (line.includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const header = splitRow(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].includes("|") && lines[index].trim() !== "") {
        rows.push(splitRow(lines[index]));
        index += 1;
      }
      const head = header.map((cell) => `<th>${renderInline(cell)}</th>`).join("");
      const body = rows
        .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`)
        .join("\n");
      blocks.push(`<table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table>`);
      continue;
    }

    if (line.trim().startsWith(">")) {
      const quoted = [];
      while (index < lines.length && lines[index].trim().startsWith(">")) {
        quoted.push(lines[index].trim().replace(/^> ?/, ""));
        index += 1;
      }
      // GitHub alerts (`> [!NOTE]`) carry their kind on the first line.
      const alert = quoted[0].match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/);
      const body = renderMarkdown((alert ? quoted.slice(1) : quoted).join("\n"));
      if (alert) {
        const kind = alert[1].toLowerCase();
        const label = kind[0].toUpperCase() + kind.slice(1);
        blocks.push(
          `<aside class="callout callout-${kind}">\n<p class="callout-label">${label}</p>\n${body}\n</aside>`,
        );
      } else {
        blocks.push(`<blockquote>\n${body}\n</blockquote>`);
      }
      continue;
    }

    // Screenshots in the guide are written as raw <img> tags so GitHub can size
    // them. That one tag is allowed through; every other raw tag is not.
    if (/^<img\b[^>]*\/?>$/.test(line.trim())) {
      blocks.push(`<p>${line.trim()}</p>`);
      index += 1;
      continue;
    }

    if (/^[+<=]/.test(line.trim()) || /^#{7,}/.test(line)) unsupported(line, lineNumber);

    const paragraph = [];
    while (index < lines.length && lines[index].trim() !== "" && !/^(#{1,6} |```|>| *([-*]|\d+\.) |<!--)/.test(lines[index])) {
      if (/^[+<=]/.test(lines[index].trim())) unsupported(lines[index], index + 1);
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
  }

  return blocks.join("\n");
};

/** "<!-- lector-version: 0.24.0 -->" -> "0.24.0" */
const stampOf = (markdown) => {
  const match = markdown.match(/<!--\s*lector-version:\s*([\d.]+(?:-[\w.]+)?)\s*-->/);
  if (!match) {
    throw new Error(
      "USER_GUIDE.md carries no `<!-- lector-version: X.Y.Z -->` stamp, so nothing can tell " +
        "whether it describes the build this site serves.",
    );
  }
  return match[1];
};

const page = (body, version) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Lector — Firmware Guide</title>
<script>
  (()=>{
    let saved=null;
    try{saved=localStorage.getItem("lector-theme");}catch(_e){}
    const theme=saved==="light"||saved==="dark"
      ? saved
      : (matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");
    document.documentElement.dataset.theme=theme;
    document.documentElement.style.colorScheme=theme;
  })();
</script>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800&family=Archivo+Black&family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet" />
<style>
  :root{
    --paper:#ffffff; --panel:#ffffff; --ink:#111111; --text:#1a1a1a;
    --sub:#666666; --soft:#e5e5e5; --dash:#cfcfcf; --code:#f2f2f2;
    --red:#8a1c1c; --yellow:#ededed; --on-ink:#ffffff; --accent-ink:#111111;
    --sans:'Archivo','Helvetica Neue',system-ui,sans-serif;
    --serif:'Newsreader',Georgia,'Times New Roman',serif;
    --mono:'JetBrains Mono',ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  }
  :root[data-theme="dark"]{
    --paper:#0a0a0a; --panel:#111111; --ink:#f2f2f2; --text:#f2f2f2;
    --sub:#a6a6a6; --soft:#2a2a2a; --dash:#3a3a3a; --code:#1a1a1a;
    --red:#b83427; --yellow:#2a2a2a; --on-ink:#0a0a0a; --accent-ink:#f2f2f2;
  }
  *{box-sizing:border-box}
  html,body{margin:0}
  body{background:var(--paper);color:var(--text);font-family:var(--sans);line-height:1.55;
    -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;}
  ::selection{background:var(--yellow);color:var(--accent-ink);}
  .wrap{max-width:820px;margin:0 auto;padding:26px 24px 90px;}
  .topline{display:flex;justify-content:space-between;align-items:center;font-family:var(--mono);
    font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--sub);font-weight:500;
    padding-bottom:8px;}
  .topline a{color:var(--sub);}
  .rule{border-top:3px solid var(--ink);}
  .guide{margin-top:28px;}
  .guide h1{font-family:var(--serif);font-weight:600;font-size:40px;line-height:1.1;
    letter-spacing:-.02em;color:var(--ink);margin:0 0 18px;}
  .guide h2{font-family:var(--serif);font-weight:600;font-size:28px;color:var(--ink);
    margin:44px 0 12px;padding-top:14px;border-top:3px solid var(--ink);}
  .guide h3{font-size:19px;font-weight:800;color:var(--ink);margin:28px 0 8px;}
  .guide h4,.guide h5,.guide h6{font-size:15px;font-weight:800;color:var(--ink);margin:22px 0 6px;
    font-family:var(--mono);letter-spacing:.04em;text-transform:uppercase;}
  .guide p{margin:0 0 14px;max-width:72ch;}
  .guide a{color:var(--ink);}
  .guide li{margin:4px 0;}
  .guide code{font-family:var(--mono);font-size:13px;background:var(--code);
    border:1px solid var(--ink);border-radius:2px;padding:1px 5px;}
  .guide pre{background:var(--code);border:3px solid var(--ink);border-radius:6px;
    box-shadow:4px 4px 0 0 var(--ink);padding:14px 16px;overflow-x:auto;}
  .guide pre code{border:0;background:none;padding:0;font-size:13px;line-height:1.5;}
  .guide table{border-collapse:collapse;width:100%;margin:0 0 18px;font-size:14.5px;}
  .guide th,.guide td{border:2px solid var(--ink);padding:7px 10px;text-align:left;vertical-align:top;}
  .guide th{background:var(--ink);color:var(--on-ink);font-size:12px;font-family:var(--mono);
    letter-spacing:.1em;text-transform:uppercase;}
  .guide img{max-width:100%;border:3px solid var(--ink);border-radius:6px;}
  .guide hr{border:0;border-top:3px solid var(--ink);margin:34px 0;}
  /* A section rule followed by its heading would otherwise draw two lines. */
  .guide hr + h2{border-top:0;padding-top:0;margin-top:0;}
  .guide blockquote{margin:0 0 18px;padding:2px 0 2px 16px;border-left:4px solid var(--dash);color:var(--sub);}
  .guide .callout{margin:0 0 18px;padding:14px 16px 2px;border:3px solid var(--ink);border-radius:6px;
    background:var(--panel);box-shadow:4px 4px 0 0 var(--ink);}
  .guide .callout-label{font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;
    color:var(--sub);margin:0 0 8px;}
  .guide .callout-warning,.guide .callout-caution{border-color:var(--red);box-shadow:4px 4px 0 0 var(--red);}
  .guide .callout-warning .callout-label,.guide .callout-caution .callout-label{color:var(--red);}
  .stamp{font-family:var(--mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;
    color:var(--sub);margin-top:40px;}
</style>
</head>
<body>
<div class="wrap">
  <div class="topline">
    <span>Lector · Firmware guide</span>
    <a href="./index.html">Back to the tools</a>
  </div>
  <div class="rule"></div>
  <article class="guide">
${body}
  </article>
  <p class="stamp">This guide describes ${escapeHtml(version)}.</p>
</div>
</body>
</html>
`;

/** Renders the whole page, refusing a guide stamped for a different build. */
export const renderGuide = (markdown, { publishedVersion }) => {
  const stamped = stampOf(markdown);
  const published = publishedVersion.replace(/^lector\s+/, "").trim();
  if (stamped !== published) {
    throw new Error(
      `USER_GUIDE.md is stamped for ${stamped}, but this site serves ${published}. ` +
        "Update the guide for the new build, then move the stamp.",
    );
  }
  return page(renderMarkdown(markdown), `lector ${published}`);
};

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const [source = "USER_GUIDE.md", destination = "guide.html"] = process.argv.slice(2);
  const publishedVersion = readFileSync(new URL("../flash/version.txt", import.meta.url), "utf8").trim();
  writeFileSync(destination, renderGuide(readFileSync(source, "utf8"), { publishedVersion }));
  process.stdout.write(`${destination} written from ${source} (${publishedVersion})\n`);
}
