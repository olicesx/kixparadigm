#!/usr/bin/env node
// fetch-webpage.mjs — fetch a URL and convert HTML to markdown for LLM consumption.
// Usage: node fetch-webpage.mjs <url> [--article] [--max-chars N] [--out file] [--timeout-ms N] [--ua string]
// Exit codes: 0 success | 1 fetch/parse failure | 2 argument error

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);

const DEFAULTS = {
  maxChars: 120000,
  timeoutMs: 20000,
  ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  maxBytes: 20 * 1024 * 1024, // hard cap on response body
};

function printHelp() {
  console.log(`Usage: node fetch-webpage.mjs <url> [options]
  --article          extract main article body (drop nav/footer noise)
  --max-chars N      cap output characters (0 = unlimited, default ${DEFAULTS.maxChars})
  --out <file>       also write markdown to file
  --timeout-ms N     request timeout (default ${DEFAULTS.timeoutMs})
  --ua <string>      custom User-Agent`);
}

function parseArgs(argv) {
  const args = { url: null, article: false, maxChars: DEFAULTS.maxChars, out: null, timeoutMs: DEFAULTS.timeoutMs, ua: DEFAULTS.ua };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--article': args.article = true; break;
      case '--max-chars': args.maxChars = parseInt(argv[++i], 10); if (Number.isNaN(args.maxChars)) return fail(`--max-chars must be a number, got '${argv[i]}'`); break;
      case '--out': args.out = argv[++i]; break;
      case '--timeout-ms': args.timeoutMs = parseInt(argv[++i], 10); if (Number.isNaN(args.timeoutMs)) return fail(`--timeout-ms must be a number, got '${argv[i]}'`); break;
      case '--ua': args.ua = argv[++i]; break;
      case '-h': case '--help': printHelp(); process.exit(0); break;
      default:
        if (a.startsWith('-')) return fail(`unknown option: ${a}`);
        positional.push(a);
    }
  }
  if (positional.length === 0) return fail('missing URL');
  if (!/^https?:\/\//i.test(positional[0])) return fail(`URL must start with http(s):// : ${positional[0]}`);
  args.url = positional[0];
  return args;
}

function fail(msg) {
  console.error(`fetch-webpage: ${msg}`);
  process.exit(2);
}

// --- turndown bootstrap: prefer the global npm copy (DSH ships it), else fall back to a minimal converter ---
function turndownSearchPaths() {
  const paths = [];
  if (process.platform === 'win32') {
    if (process.env.APPDATA) paths.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
    paths.push(path.join(path.dirname(process.execPath), 'node_modules'));
  }
  try {
    // 'npm' alone fails under execFileSync on Windows (.cmd needs a shell),
    // so go through ComSpec.
    const out = execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/c', 'npm root -g'], { encoding: 'utf8', windowsHide: true });
    paths.push(out.trim());
  } catch { /* keep the candidates we have */ }
  return paths;
}

function loadTurndown() {
  for (const root of turndownSearchPaths()) {
    try {
      const turndownPath = require.resolve('turndown', { paths: [root] });
      const mod = require(turndownPath);
      return { TurndownService: mod.default ?? mod, root };
    } catch { /* try next candidate */ }
  }
  return null;
}

function minimalHtmlToMarkdown(html) {
  // Last-resort converter: strip scripts/styles/tags, keep code blocks and paragraph breaks.
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<pre[\s\S]*?<\/pre>/gi, (m) => '\n```\n' + m.replace(/<[^>]+>/g, '').trim() + '\n```\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function detectCharset(resCtype, htmlHead) {
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(resCtype);
  if (fromHeader) return fromHeader[1];
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(htmlHead);
  if (fromMeta) return fromMeta[1];
  return 'utf-8';
}

function absolutizeLinks(document, baseUrl) {
  for (const sel of ['a[href]', 'img[src]', 'link[href]', 'source[src]']) {
    for (const el of document.querySelectorAll(sel)) {
      const attr = sel.endsWith('[src]') ? 'src' : 'href';
      const v = el.getAttribute(attr);
      if (v && !/^(https?:|mailto:|tel:|data:|javascript:|#|\/\/)/i.test(v)) {
        try { el.setAttribute(attr, new URL(v, baseUrl).href); } catch { /* leave as-is */ }
      }
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // NEVER call process.exit() after fetch() on Windows: node 24's undici races
  // its connection cleanup against the libuv loop and aborts with
  // "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c"
  // (verified: plain/close/abort variants all crash; exitCode + natural drain
  // is clean). All paths set process.exitCode and return; connection: close
  // guarantees no keep-alive handle holds the loop open. If a pathological
  // page still hangs, the pwsh call layer's timeout is the safety net.

  let res;
  try {
    res = await fetch(args.url, {
      redirect: 'follow',
      headers: {
        'user-agent': args.ua,
        accept: 'text/html,text/plain,*/*',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        // Disable keep-alive: a pooled idle socket keeps the event loop alive
        // and forces hard exit()s, which crash libuv on Windows when a body
        // was cancelled. With connection: close every path can exit naturally.
        connection: 'close',
      },
      signal: AbortSignal.timeout(args.timeoutMs),
    });
  } catch (err) {
    const reason = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? `timeout after ${args.timeoutMs}ms` : (err?.message ?? String(err));
    console.error(`fetch-webpage: fetch failed: ${reason}`);
    process.exitCode = 1;
    return;
  }
  if (!res.ok) {
    // Cancel the body stream and let the event loop drain BEFORE the process
    // exits: on Windows, exit() with an unconsumed undici body triggers a
    // libuv assertion crash (UV_HANDLE_CLOSING).
    await res.body?.cancel().catch(() => {});
    console.error(`fetch-webpage: HTTP ${res.status} ${res.statusText} for ${args.url}`);
    if (res.status === 403 || res.status === 429) {
      console.error('hint: the site may be blocking automated access; retry with a different --ua');
    }
    process.exitCode = 1;
    return;
  }

  // Stream body with a hard byte cap.
  let buf;
  let bodyTruncated = false;
  try {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (total > DEFAULTS.maxBytes) { bodyTruncated = true; await reader.cancel(); break; }
    }
    buf = Buffer.concat(chunks);
  } catch (err) {
    await res.body?.cancel().catch(() => {});
    const reason = err?.name === 'AbortError' ? `timeout after ${args.timeoutMs}ms` : (err?.message ?? String(err));
    console.error(`fetch-webpage: failed reading response body: ${reason}`);
    process.exitCode = 1;
    return;
  }

  const ctype = res.headers.get('content-type') ?? '';
  const headSample = buf.subarray(0, 4096).toString('latin1');
  const charset = detectCharset(ctype, headSample);

  let text;
  try { text = new TextDecoder(charset).decode(buf); }
  catch { text = new TextDecoder('utf-8').decode(buf); } // unknown charset label -> utf-8

  const isHtml = /text\/html/i.test(ctype) || /<html[\s>]/i.test(headSample) || /<!doctype html>/i.test(headSample);
  if (!isHtml) {
    // Plain text (or JSON/XML): emit as-is.
    const body = text.slice(0, args.maxChars || undefined);
    const out = `${body}${(args.maxChars && text.length > args.maxChars) ? '\n<!-- truncated -->' : ''}`;
    if (args.out) writeFileSync(args.out, out);
    process.stdout.write(out);
    process.exitCode = 0;
    return;
  }

  const tdLoader = loadTurndown();
  let markdown, title = '';

  if (tdLoader) {
    const { TurndownService } = tdLoader;
    let domino;
    try {
      domino = require(require.resolve('@mixmark-io/domino', { paths: turndownSearchPaths() }));
    } catch { domino = null; }

    if (domino) {
      const document = domino.createDocument(text);
      title = (document.querySelector('title')?.textContent ?? '').trim();
      absolutizeLinks(document, args.url);
      let node = document.body ?? document.documentElement;
      if (args.article) {
        let best = null;
        for (const sel of ['article', 'main', '[role="main"]']) {
          const el = document.querySelector(sel);
          if (el && el.textContent.trim().length > 200) { best = el; break; }
        }
        if (best) node = best;
      }
      const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', hr: '---' });
      td.remove(['script', 'style', 'noscript', 'template', 'iframe', 'svg']);
      markdown = td.turndown(node.innerHTML);
    } else {
      const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', hr: '---' });
      td.remove(['script', 'style', 'noscript', 'template', 'iframe', 'svg']);
      const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
      if (m) title = m[1].replace(/<[^>]+>/g, '').trim();
      markdown = td.turndown(text);
    }
  } else {
    console.error('fetch-webpage: turndown not found — using the minimal built-in converter (lower quality)');
    const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
    if (m) title = m[1].replace(/<[^>]+>/g, '').trim();
    markdown = minimalHtmlToMarkdown(text);
  }

  markdown = markdown.replace(/\n{3,}/g, '\n\n').trim();
  let out = '';
  if (title) out += `# ${title}\n\n`;
  out += `> Source: ${args.url}\n\n`;
  out += markdown;
  if (args.maxChars && out.length > args.maxChars) {
    out = out.slice(0, args.maxChars) + '\n\n<!-- truncated; rerun with --max-chars 0 for full content -->';
  }
  if (bodyTruncated) out += '\n<!-- response body exceeded 20MB cap; content may be incomplete -->';

  if (args.out) writeFileSync(args.out, out);
  process.stdout.write(out);
}

main();
