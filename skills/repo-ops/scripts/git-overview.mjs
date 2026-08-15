#!/usr/bin/env node
// git-overview.mjs — one-screen snapshot of a git repository (read-only).
// Usage: node git-overview.mjs [--path <dir>] [--log N] [--json]
// Exit codes: 0 ok | 1 not a git repo / git unavailable

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

function git(args, cwd) {
  try {
    // NOTE: strip trailing newlines only — NEVER trim() git output. porcelain v1
    // lines carry a semantic leading space in column X (" M file" = unstaged).
    const out = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\n+$/, '');
    return { ok: true, out };
  } catch (e) {
    return { ok: false, err: String(e.stderr ?? e.message ?? e).trim() };
  }
}

function parseArgs(argv) {
  const args = { path: process.cwd(), log: 10, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--path') args.path = argv[++i];
    else if (a === '--log') args.log = parseInt(argv[++i], 10);
    else if (a === '--json') args.json = true;
    else if (a === '-h' || a === '--help') { console.log('Usage: node git-overview.mjs [--path <dir>] [--log N] [--json]'); process.exit(0); }
    else { console.error(`unknown option: ${a}`); process.exit(2); }
  }
  return args;
}

const CODE_LABEL = {
  'M': 'modified', 'A': 'added', 'D': 'deleted', 'R': 'renamed', 'C': 'copied',
  'U': 'unmerged', 'T': 'type-change', '?': 'untracked', '!': 'ignored',
};

function parsePorcelain(lines) {
  const groups = { staged: [], unstaged: [], untracked: [] };
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('?? ')) { groups.untracked.push({ status: 'untracked', path: line.slice(3) }); continue; }
    const x = line[0], y = line[1];
    let p = line.slice(3);
    if (p.includes(' -> ')) p = p.split(' -> ')[1]; // rename target
    if (x !== ' ' && x !== '?') groups.staged.push({ status: CODE_LABEL[x] ?? x, path: p });
    if (y !== ' ' && y !== '?') groups.unstaged.push({ status: CODE_LABEL[y] ?? y, path: p });
  }
  return groups;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = path.resolve(args.path);

  const isRepo = git(['rev-parse', '--is-inside-work-tree'], cwd);
  if (!isRepo.ok) {
    console.error(`git-overview: not a git repository (or git unavailable): ${isRepo.err.split('\n')[0]}`);
    process.exit(1);
  }

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const head = git(['log', '-1', '--format=%h %ad %s', '--date=short'], cwd);
  const recent = git(['log', `-${args.log}`, '--format=%h %ad %s', '--date=short'], cwd);
  const status = git(['status', '--porcelain=v1'], cwd);
  const stat = git(['diff', '--stat', 'HEAD'], cwd);
  const upstream = git(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], cwd);

  const changes = status.ok ? parsePorcelain(status.out.split('\n')) : { staged: [], unstaged: [], untracked: [] };
  const repoName = path.basename(cwd) || cwd;

  if (args.json) {
    const payload = {
      repo: repoName, path: cwd,
      branch: branch.ok ? branch.out : null,
      head: head.ok ? head.out : null,
      upstream: upstream.ok ? (() => { const [a, b] = upstream.out.split(/\s+/).map(Number); return { ahead: a, behind: b }; })() : null,
      changes, diffStat: stat.ok ? stat.out : null,
      recentCommits: recent.ok ? recent.out.split('\n').filter(Boolean) : [],
    };
    process.stdout.write(JSON.stringify(payload, null, 2));
    process.exit(0);
  }

  const lines = [];
  lines.push(`# git overview — ${repoName}`);
  lines.push('');
  lines.push(`- **branch**: ${branch.ok ? branch.out : '?'}  (HEAD: ${head.ok ? head.out : '?'})`);
  if (upstream.ok) {
    const [a, b] = upstream.out.split(/\s+/).map(Number);
    lines.push(`- **upstream**: ahead ${a} / behind ${b}`);
  } else {
    lines.push(`- **upstream**: none (no tracking branch)`);
  }

  const total = changes.staged.length + changes.unstaged.length + changes.untracked.length;
  lines.push(`- **changes**: ${total} (staged ${changes.staged.length}, unstaged ${changes.unstaged.length}, untracked ${changes.untracked.length})`);
  lines.push('');
  if (total > 0) {
    lines.push('## changes');
    lines.push('');
    lines.push('| area | status | path |');
    lines.push('|---|---|---|');
    for (const c of changes.staged) lines.push(`| staged | ${c.status} | ${c.path} |`);
    for (const c of changes.unstaged) lines.push(`| unstaged | ${c.status} | ${c.path} |`);
    for (const c of changes.untracked) lines.push(`| untracked | ${c.status} | ${c.path} |`);
    lines.push('');
  }
  if (stat.ok && stat.out) {
    lines.push('## diff stat vs HEAD');
    lines.push('');
    lines.push('```');
    lines.push(stat.out);
    lines.push('```');
    lines.push('');
  }
  if (recent.ok && recent.out) {
    lines.push(`## recent commits (${args.log})`);
    lines.push('');
    lines.push('```');
    lines.push(recent.out);
    lines.push('```');
  }

  process.stdout.write(lines.join('\n') + '\n');
  process.exit(0);
}

main();
