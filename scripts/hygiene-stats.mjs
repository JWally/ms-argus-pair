#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cruise } from 'dependency-cruiser';
import { ESLint } from 'eslint';
import ts from 'typescript';

const ROOT = process.cwd();
const require = createRequire(import.meta.url);
const SOURCE_RE = /^(cdk|src|tests|scripts)\/.*\.(ts|tsx|mts|mjs|js)$/;
const FUNCTION_LIMIT = 120;
const FILE_LIMIT = 600;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error instanceof Error ? result.error.message : '',
  };
}

function pct(value) {
  return typeof value === 'number' ? `${value.toFixed(2)}%` : 'n/a';
}

function plural(count, singular, pluralLabel = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralLabel}`;
}

function sourceFiles() {
  const result = run('git', ['ls-files', '--cached', '--others', '--exclude-standard']);
  if (!result.stdout) {
    throw new Error(result.stderr.trim() || 'git ls-files produced no output');
  }
  return result.stdout
    .split('\n')
    .filter((file) => SOURCE_RE.test(file))
    .filter((file) => existsSync(path.join(ROOT, file)));
}

function lineStats(files) {
  const rows = files.map((file) => {
    const text = readFileSync(path.join(ROOT, file), 'utf8');
    return {
      file,
      lines: text.split('\n').length,
    };
  });
  rows.sort((a, b) => b.lines - a.lines);
  return {
    totalFiles: rows.length,
    totalLines: rows.reduce((sum, row) => sum + row.lines, 0),
    overLimit: rows.filter((row) => row.lines > FILE_LIMIT),
    top: rows.slice(0, 10),
  };
}

function functionName(node) {
  if ('name' in node && node.name && ts.isIdentifier(node.name)) return node.name.text;
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name))
    return node.name.text;
  return '<anonymous>';
}

function functionStats(files) {
  const rows = [];
  for (const file of files) {
    const fullPath = path.join(ROOT, file);
    const text = readFileSync(fullPath, 'utf8');
    const scriptKind = file.endsWith('.tsx')
      ? ts.ScriptKind.TSX
      : file.endsWith('.ts') || file.endsWith('.mts')
        ? ts.ScriptKind.TS
        : ts.ScriptKind.JS;
    const source = ts.createSourceFile(fullPath, text, ts.ScriptTarget.Latest, true, scriptKind);
    const lineStarts = source.getLineStarts();
    const lineFor = (pos) => {
      if (!Number.isFinite(pos)) return 1;
      const bounded = Math.max(0, Math.min(pos, text.length));
      let low = 0;
      let high = lineStarts.length - 1;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (lineStarts[mid] <= bounded) {
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      return high + 1;
    };
    const visit = (node) => {
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node)
      ) {
        const start = lineFor(node.getStart(source, false));
        const end = lineFor(node.end);
        rows.push({
          file,
          name: functionName(node),
          line: start,
          lines: end - start + 1,
        });
      }
      ts.forEachChild(node, visit);
    };
    if (lineStarts.length > 0) visit(source);
  }
  rows.sort((a, b) => b.lines - a.lines);
  return {
    totalFunctions: rows.length,
    overLimit: rows.filter((row) => row.lines > FUNCTION_LIMIT),
    top: rows.slice(0, 10),
  };
}

async function eslintStats() {
  let files;
  try {
    const eslint = new ESLint();
    files = await eslint.lintFiles(['.']);
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message : String(error) };
  }
  const counts = files.reduce(
    (acc, file) => {
      acc.errors += file.errorCount ?? 0;
      acc.warnings += file.warningCount ?? 0;
      for (const msg of file.messages ?? []) {
        const rule =
          msg.ruleId ??
          (msg.message?.startsWith('Unused eslint-disable') ? 'unused-eslint-disable' : 'eslint');
        acc.byRule.set(rule, (acc.byRule.get(rule) ?? 0) + 1);
      }
      return acc;
    },
    { errors: 0, warnings: 0, byRule: new Map() }
  );
  return {
    errors: counts.errors,
    warnings: counts.warnings,
    topRules: [...counts.byRule.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([rule, count]) => ({ rule, count })),
  };
}

async function boundaryStats() {
  let summary;
  try {
    const config = require('../dependency-cruiser.config.cjs');
    const result = await cruise(['cdk', 'loader', 'src', 'tests'], {
      ...config.options,
      ruleSet: { forbidden: config.forbidden },
    });
    summary = result.output.summary ?? {};
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message : String(error) };
  }
  return {
    violations: summary.violations?.length ?? 0,
    errors: summary.error ?? 0,
    warnings: summary.warn ?? 0,
    modules: summary.totalCruised ?? 0,
    dependencies: summary.totalDependenciesCruised ?? 0,
  };
}

function duplicationStats() {
  const outDir = mkdtempSync(path.join(tmpdir(), 'argus-hygiene-jscpd-'));
  try {
    const result = run('npx', [
      'jscpd',
      'src',
      'cdk',
      'loader',
      '--reporters',
      'json',
      '--output',
      outDir,
    ]);
    const reportPath = path.join(outDir, 'jscpd-report.json');
    if (!existsSync(reportPath))
      return { unavailable: result.stderr.trim() || result.stdout.trim() };
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const stat = report.statistics?.total ?? {};
    const percentage = Number(stat.percentage ?? 0);
    const percentageTokens = Number(stat.percentageTokens ?? 0);
    return {
      clones: report.duplicates?.length ?? 0,
      duplicatedLines: stat.duplicatedLines ?? 0,
      duplicatedLinePct: percentage,
      duplicatedTokens: stat.duplicatedTokens ?? 0,
      duplicatedTokenPct: percentageTokens,
    };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

function coverageStats() {
  const coveragePath = path.join(ROOT, 'coverage', 'coverage-summary.json');
  if (!existsSync(coveragePath)) {
    return { unavailable: 'coverage/coverage-summary.json missing; run npm run test:coverage' };
  }
  const total = JSON.parse(readFileSync(coveragePath, 'utf8')).total;
  return {
    statements: total.statements?.pct,
    branches: total.branches?.pct,
    functions: total.functions?.pct,
    lines: total.lines?.pct,
  };
}

function printRows(rows, render) {
  for (const row of rows) {
    console.log(`  ${render(row)}`);
  }
}

async function main() {
  const files = sourceFiles();
  const lines = lineStats(files);
  const functions = functionStats(files);
  const [lint, boundaries] = await Promise.all([eslintStats(), boundaryStats()]);
  const duplication = duplicationStats();
  const coverage = coverageStats();

  console.log('Argus hygiene stats');
  console.log('');
  console.log(`Source: ${plural(lines.totalFiles, 'file')}, ${plural(lines.totalLines, 'line')}`);
  console.log(
    `Large files: ${lines.overLimit.length} over ${FILE_LIMIT} lines; functions: ${functions.overLimit.length} over ${FUNCTION_LIMIT} lines`
  );
  console.log('');

  console.log('Quality signals');
  console.log(
    `  ESLint: ${
      lint.unavailable
        ? `unavailable (${lint.unavailable})`
        : `${lint.errors} errors, ${lint.warnings} warnings`
    }`
  );
  console.log(
    `  Boundaries: ${
      boundaries.unavailable
        ? `unavailable (${boundaries.unavailable})`
        : `${boundaries.violations} violations across ${boundaries.modules} modules / ${boundaries.dependencies} deps`
    }`
  );
  console.log(
    `  Duplication: ${
      duplication.unavailable
        ? `unavailable (${duplication.unavailable})`
        : `${duplication.clones} clones, ${duplication.duplicatedLines} duplicated lines (${pct(
            duplication.duplicatedLinePct
          )})`
    }`
  );
  console.log(
    `  Coverage: ${
      coverage.unavailable
        ? `unavailable (${coverage.unavailable})`
        : `statements ${pct(coverage.statements)}, branches ${pct(
            coverage.branches
          )}, functions ${pct(coverage.functions)}, lines ${pct(coverage.lines)}`
    }`
  );
  console.log('');

  if (!lint.unavailable && lint.topRules.length > 0) {
    console.log('Top lint rules');
    printRows(lint.topRules, (row) => `${row.count} ${row.rule}`);
    console.log('');
  }

  console.log('Largest files');
  printRows(lines.top, (row) => `${row.lines.toString().padStart(5)}  ${row.file}`);
  console.log('');

  console.log('Largest functions');
  printRows(
    functions.top,
    (row) => `${row.lines.toString().padStart(4)}  ${row.file}:${row.line}  ${row.name}`
  );
}

await main();
