const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

// ✅ Increase body size limit to handle large text
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ limit: '10mb', type: 'text/*' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

const PORT = 3000;
const DEFAULT_CLIPBOARD_ID = process.env.DEFAULT_CLIPBOARD_ID || 'aconite';
const DEFAULT_PATH = `/clipboard/${DEFAULT_CLIPBOARD_ID}`;

// Simple in-memory storage (use DB later)
const clipboardStore = {};

// 👉 Save clipboard
app.post('/api/clipboard/:id', (req, res) => {
  const { id } = req.params;
  const existing = clipboardStore[id];
  let content;
  let content_type;

  if (typeof req.body === 'string') {
    content = req.body;
    content_type = req.get('content-type') || 'text/plain';
  } else if (req.body && typeof req.body === 'object') {
    if (Object.prototype.hasOwnProperty.call(req.body, 'content')) {
      content = req.body.content;
      content_type = req.body.content_type || 'text/plain';
    } else {
      content = req.body;
      content_type = req.get('content-type') || 'application/json';
    }
  }

  const isEmptyString = typeof content === 'string' && content.trim() === '';
  if (content === undefined || content === null || isEmptyString) {
    if (existing) return res.json({ id, updated: false, cached: true });
    return res.status(400).json({ error: 'Content required' });
  }

  let signature;
  if (typeof content === 'string') {
    signature = content;
  } else {
    try {
      signature = JSON.stringify(content);
    } catch (_) {
      signature = String(content);
    }
  }

  if (existing && existing.signature === signature && (existing.content_type || 'text/plain') === (content_type || 'text/plain')) {
    return res.json({ id, updated: false, cached: true });
  }

  clipboardStore[id] = {
    content,
    content_type: content_type || 'text/plain',
    signature,
    createdAt: existing && existing.createdAt ? existing.createdAt : new Date(),
    updatedAt: new Date(),
  };

  res.json({ id, updated: true });
});

// parse safely
function parseJSONLoose(text) {
  if (typeof text !== 'string') return text;

  const trimmed = text.trim();
  if (!trimmed) return text;

  try {
    return JSON.parse(trimmed);
  } catch (_) {}

  const firstBrace = trimmed.indexOf('{');
  const firstBracket = trimmed.indexOf('[');
  const starts = [firstBrace, firstBracket].filter((i) => i !== -1);
  if (starts.length) {
    const start = Math.min(...starts);
    const lastBrace = trimmed.lastIndexOf('}');
    const lastBracket = trimmed.lastIndexOf(']');
    const end = Math.max(lastBrace, lastBracket);
    if (end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch (_) {}
    }
  }

  return text;
}

function extractBlocks(content) {
  if (typeof content !== 'string') return null;

  const blocks = [];
  const re = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match;
  while ((match = re.exec(content))) {
    const startIndex = match.index;
    const before = content.slice(Math.max(0, startIndex - 400), startIndex);
    const lines = before.split('\n').map((l) => l.trim()).filter(Boolean);
    const lastLine = lines.length ? lines[lines.length - 1] : '';
    const labelMatch = lastLine.match(/^(request body|request header|response data)\s*:?\s*$/i);
    const label = labelMatch ? labelMatch[1].toLowerCase() : null;

    blocks.push({
      label,
      raw: match[1],
      parsed: parseJSONLoose(match[1]),
    });
  }

  if (!blocks.length) return null;
  return blocks;
}

function parseClipboardContent(content) {
  if (typeof content !== 'string') return content;

  const blocks = extractBlocks(content);
  if (blocks) {
    const structured = {};

    const apiMatch = content.match(/API\s*\*\*\[([A-Z]+)\]\*\*[\s\S]*?`(https?:\/\/[^`]+)`/i);
    if (apiMatch) {
      structured.api = { method: apiMatch[1].toUpperCase(), url: apiMatch[2] };
    }

    const byLabel = new Map();
    blocks.forEach((b) => {
      if (!b.label) return;
      if (!byLabel.has(b.label)) byLabel.set(b.label, []);
      byLabel.get(b.label).push(b.parsed);
    });

    if (byLabel.has('request body')) structured.requestBody = byLabel.get('request body')[0];
    if (byLabel.has('request header')) structured.requestHeader = byLabel.get('request header')[0];
    if (byLabel.has('response data')) structured.responseData = byLabel.get('response data')[0];

    if (!structured.requestBody && blocks.length >= 1) structured.requestBody = blocks[0].parsed;
    if (!structured.requestHeader && blocks.length >= 2) structured.requestHeader = blocks[1].parsed;
    if (!structured.responseData && blocks.length >= 3) structured.responseData = blocks[2].parsed;

    return structured;
  }

  return parseJSONLoose(content);
}

app.get('/clipboard/:id', (req, res) => {
  const { id } = req.params;
  const data = clipboardStore[id];

  if (!data) return res.status(404).send('Not found');

  const json = parseClipboardContent(data.content);

  res.send(`
    <html>
      <head>
        <title>Clipboard Viewer</title>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.8.0/styles/atom-one-dark.min.css">
        <style>
          body {
            background-color: #1e1e1e;
            color: #fff;
            font-family: monospace;
            margin: 0;
            padding: 24px 0;
          }
          #page {
            width: 70%;
            // min-width: 360px;
            // max-width: 1100px;
            margin: 0 auto;
          }
          h2 {
            margin: 0 0 14px;
            text-align: center;
          }
          #root {
            background-color: #2d2d2d;
            padding: 15px;
            border-radius: 8px;
            overflow: auto;
            white-space: pre;
            line-height: 1.6;
            font-size: 13.5px;
            max-height: calc(100vh - 140px);
            box-sizing: border-box;
          }
          .node { display: block; }
          .line { display: block; }
          .toggle-btn {
            display: inline-block;
            cursor: pointer;
            background: #3a3a3a;
            color: #cba6f7;
            font-size: 11px;
            font-weight: bold;
            border: 1px solid #555;
            border-radius: 3px;
            padding: 0px 4px;
            margin-right: 6px;
            user-select: none;
            min-width: 18px;
            text-align: center;
            vertical-align: middle;
            line-height: 16px;
            transition: transform 160ms ease, background 160ms ease, border-color 160ms ease;
          }
          .toggle-btn:hover { background: #4a4a4a; }
          .node.collapsed .toggle-btn { transform: rotate(-90deg); }
          .spacer {
            display: inline-block;
            width: 28px;
          }
          .key { color: #89b4fa; }
          .colon { color: #a0a0a0; margin: 0 3px; }
          .brace { color: #cba6f7; font-weight: bold; }
          .bracket { color: #fab387; font-weight: bold; }
          .comma { color: #a0a0a0; }
          .summary {
            color: #a0a0a0;
            font-style: italic;
            margin-left: 6px;
          }
          .children {
            padding-left: 22px;
            border-left: 1px dashed #444;
            margin-left: 10px;
          }
          .anim {
            overflow: hidden;
            will-change: height, opacity;
          }
          .section {
            padding: 10px 0;
            border-top: 1px solid #3a3a3a;
          }
          .section:first-child {
            border-top: none;
            padding-top: 0;
          }
          .section-title {
            color: #cdd6f4;
            font-weight: 700;
            margin: 0 0 8px;
          }
          .api-line {
            margin: 0 0 8px;
            word-break: break-word;
          }
          .api-line a {
            color: #89b4fa;
            text-decoration: none;
          }
          .api-line a:hover {
            text-decoration: underline;
          }
          .val-string { color: #a6e3a1; }
          .val-number { color: #fab387; }
          .val-boolean { color: #f38ba8; }
          .val-null { color: #a0a0a0; font-style: italic; }
        </style>
      </head>
      <body>
        <div id="page">
          <h2>Clipboard: ${id}</h2>
          <div id="root"></div>
        </div>

        <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.8.0/highlight.min.js"></script>
        <script type="application/json" id="__data__">${
          JSON.stringify(json)
            .replace(/</g, '\\u003c')
            .replace(/>/g, '\\u003e')
            .replace(/&/g, '\\u0026')
        }</script>
        <script>
          const RAW = JSON.parse(document.getElementById('__data__').textContent);

          function span(cls, text) {
            const s = document.createElement('span');
            if (cls) s.className = cls;
            s.textContent = text;
            return s;
          }

          function valueSpan(value) {
            if (value === null) return span('val-null', 'null');
            if (typeof value === 'string') return span('val-string', JSON.stringify(value));
            if (typeof value === 'number') return span('val-number', String(value));
            if (typeof value === 'boolean') return span('val-boolean', String(value));
            return span('', JSON.stringify(value));
          }

          function isObject(value) {
            return value !== null && typeof value === 'object' && !Array.isArray(value);
          }

          function animateHeightFade(el, show, duration) {
            const ms = typeof duration === 'number' ? duration : 180;
            const easing = 'cubic-bezier(0.2, 0, 0, 1)';
            el.getAnimations().forEach((a) => a.cancel());

            if (show) {
              el.style.display = '';
              const target = el.scrollHeight;
              const a = el.animate(
                [
                  { height: '0px', opacity: 0 },
                  { height: target + 'px', opacity: 1 },
                ],
                { duration: ms, easing }
              );
              a.onfinish = () => {
                el.style.height = '';
                el.style.opacity = '';
              };
              return;
            }

            const start = el.scrollHeight;
            const a = el.animate(
              [
                { height: start + 'px', opacity: 1 },
                { height: '0px', opacity: 0 },
              ],
              { duration: ms, easing }
            );
            a.onfinish = () => {
              el.style.display = 'none';
              el.style.height = '';
              el.style.opacity = '';
            };
          }

          function animateFade(el, show, duration) {
            const ms = typeof duration === 'number' ? duration : 140;
            const easing = 'cubic-bezier(0.2, 0, 0, 1)';
            el.getAnimations().forEach((a) => a.cancel());

            if (show) {
              el.style.display = '';
              const a = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing });
              a.onfinish = () => {
                el.style.opacity = '';
              };
              return;
            }

            const a = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing });
            a.onfinish = () => {
              el.style.display = 'none';
              el.style.opacity = '';
            };
          }

          function buildNode(key, value, isLast) {
            const wrapper = document.createElement('div');
            wrapper.className = 'node';

            const isObj = isObject(value);
            const isArr = Array.isArray(value);
            const isComplex = isObj || isArr;

            if (!isComplex) {
              const line = document.createElement('div');
              line.className = 'line';

              line.appendChild(span('spacer', ''));

              if (key !== null) {
                line.appendChild(span('key', JSON.stringify(key)));
                line.appendChild(span('colon', ':'));
              }

              line.appendChild(valueSpan(value));
              if (!isLast) line.appendChild(span('comma', ','));

              wrapper.appendChild(line);
              return wrapper;
            }

            const open = isArr ? '[' : '{';
            const close = isArr ? ']' : '}';
            const bracketCls = isArr ? 'bracket' : 'brace';

            const header = document.createElement('div');
            header.className = 'line';

            const btn = document.createElement('span');
            btn.className = 'toggle-btn';
            btn.textContent = '-';
            header.appendChild(btn);

            if (key !== null) {
              header.appendChild(span('key', JSON.stringify(key)));
              header.appendChild(span('colon', ':'));
            }

            header.appendChild(span(bracketCls, open));

            const summary = document.createElement('span');
            summary.className = 'summary';
            const count = isArr ? value.length : Object.keys(value).length;
            summary.textContent = isArr
              ? String(count) + ' item' + (count === 1 ? '' : 's')
              : String(count) + ' key' + (count === 1 ? '' : 's');
            summary.style.display = 'none';
            header.appendChild(summary);

            const collapsedClose = document.createElement('span');
            collapsedClose.className = bracketCls;
            collapsedClose.textContent = close;
            collapsedClose.style.display = 'none';
            header.appendChild(collapsedClose);

            if (!isLast) header.appendChild(span('comma', ','));

            wrapper.appendChild(header);

            const children = document.createElement('div');
            children.className = 'children';

            const entries = isArr ? value.map((v, i) => [i, v]) : Object.entries(value);
            entries.forEach(([k, v], idx) => {
              const childKey = isArr ? null : k;
              children.appendChild(buildNode(childKey, v, idx === entries.length - 1));
            });

            wrapper.appendChild(children);

            const footer = document.createElement('div');
            footer.className = 'line';
            footer.appendChild(span('spacer', ''));
            footer.appendChild(span(bracketCls, close));
            if (!isLast) footer.appendChild(span('comma', ','));
            wrapper.appendChild(footer);

            children.classList.add('anim');
            footer.classList.add('anim');

            let expanded = true;
            btn.addEventListener('click', () => {
              expanded = !expanded;
              btn.textContent = expanded ? '-' : '+';
              wrapper.classList.toggle('collapsed', !expanded);

              if (expanded) {
                animateFade(summary, false);
                animateFade(collapsedClose, false);
                animateHeightFade(children, true);
                animateHeightFade(footer, true);
              } else {
                animateHeightFade(children, false);
                animateHeightFade(footer, false);
                animateFade(summary, true);
                animateFade(collapsedClose, true);
              }
            });

            return wrapper;
          }

          const root = document.getElementById('root');
          const isStructuredLog = RAW !== null
            && typeof RAW === 'object'
            && !Array.isArray(RAW)
            && ('requestBody' in RAW || 'requestHeader' in RAW || 'responseData' in RAW || 'api' in RAW);

          function addSection(title, value) {
            const section = document.createElement('div');
            section.className = 'section';

            const h = document.createElement('div');
            h.className = 'section-title';
            h.textContent = title;
            section.appendChild(h);

            if (value !== undefined) {
              if (value !== null && typeof value === 'object') {
                section.appendChild(buildNode(null, value, true));
              } else {
                const line = document.createElement('div');
                line.className = 'line';
                line.appendChild(span('spacer', ''));
                line.appendChild(valueSpan(value));
                section.appendChild(line);
              }
            }

            root.appendChild(section);
          }

          if (isStructuredLog) {
            if (RAW.api && typeof RAW.api === 'object') {
              const apiSection = document.createElement('div');
              apiSection.className = 'section';

              const h = document.createElement('div');
              h.className = 'section-title';
              h.textContent = 'API endpoint';
              apiSection.appendChild(h);

              const line = document.createElement('div');
              line.className = 'api-line';

              const method = RAW.api.method ? String(RAW.api.method).toUpperCase() : '';
              const url = RAW.api.url ? String(RAW.api.url) : '';
              if (method) line.appendChild(span('', method + ': '));
              if (url) {
                const a = document.createElement('a');
                a.href = url;
                a.target = '_blank';
                a.rel = 'noreferrer';
                a.textContent = url;
                line.appendChild(a);
              }
              apiSection.appendChild(line);
              root.appendChild(apiSection);
            }

            addSection('Request Body', RAW.requestBody);
            addSection('Request Header', RAW.requestHeader);
            addSection('Response Data', RAW.responseData);
          } else if (RAW !== null && typeof RAW === 'object') {
            root.appendChild(buildNode(null, RAW, true));
          } else {
            root.textContent = JSON.stringify(RAW);
          }
        </script>
      </body>
    </html>
  `);
});

// Homepage route
app.get('/', (req, res) => {
  res.redirect(DEFAULT_PATH);
});

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload too large' });
  }

  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  next(err);
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}${DEFAULT_PATH}`);
});
