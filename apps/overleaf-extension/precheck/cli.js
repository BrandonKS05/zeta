#!/usr/bin/env node
"use strict";

/**
 * Zeta Pre-Check CLI
 *
 * Usage:
 *   node cli.js --dir <path>         scan all .tex files recursively
 *   node cli.js --file <path>        single file (repeatable, must be .tex)
 *   node cli.js --out <dir>          output directory (defaults to cwd)
 *   node cli.js --quiet              suppress stdout summary
 *   node cli.js --strict             exit 1 on ANY issue regardless of severity
 *   node cli.js --help               show this help
 *
 * Exit codes:
 *   Normal mode : exit 1 only when there are "error" or "high" severity issues.
 *                 (precheck.js currently emits "warning" by default, so normal
 *                 mode exits 0 for demo data — use --strict to catch warnings.)
 *   --strict    : exit 1 on ANY issue including "warning" severity.
 */

const fs = require("fs");
const path = require("path");

const precheck = require("./precheck.js");

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const dirs = [];
  const files = [];
  let outDir = process.cwd();
  let quiet = false;
  let strict = false;
  let showHelp = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      showHelp = true;
    } else if (arg === "--quiet" || arg === "-q") {
      quiet = true;
    } else if (arg === "--strict") {
      strict = true;
    } else if (arg === "--dir") {
      const val = args[++i];
      if (!val) die("--dir requires a path argument");
      dirs.push(val);
    } else if (arg === "--file") {
      const val = args[++i];
      if (!val) die("--file requires a path argument");
      files.push(val);
    } else if (arg === "--out") {
      const val = args[++i];
      if (!val) die("--out requires a path argument");
      outDir = val;
    } else {
      die(`Unknown argument: ${arg}`);
    }
  }

  return { dirs, files, outDir, quiet, strict, showHelp };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function die(msg) {
  process.stderr.write(`zeta: error: ${msg}\n`);
  process.exit(1);
}

function printHelp() {
  process.stdout.write(
    `Zeta Scientific Pre-Check CLI

Usage:
  node cli.js --dir <path> [--dir <path>...] [options]
  node cli.js --file <path> [--file <path>...] [options]

Options:
  --dir <path>    Recursively scan directory for .tex files
  --file <path>   Include a specific .tex file (repeatable)
  --out <dir>     Output directory for reports (default: current directory)
  --quiet         Suppress stdout summary
  --strict        Exit 1 on ANY issue including warnings (normal mode exits 1
                  only for "error" or "high" severity issues)
  --help          Show this help message

Outputs:
  zeta-report.json   Machine-readable report
  zeta-report.md     Human-readable Markdown report
`
  );
}

/** Recursively collect all .tex files under a directory. */
function collectTexFiles(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTexFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".tex")) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Extract a human-readable location string from an issue.
 * precheck.js does not export issueLocation, so we derive it here.
 */
function issueLocation(issue) {
  if (!issue) return "";
  // notation_drift / undefined_symbol have definitions or first_use
  if (issue.first_use) {
    const u = issue.first_use;
    return u.file_path ? `${u.file_path}:${u.line || ""}` : "";
  }
  if (Array.isArray(issue.definitions) && issue.definitions.length > 0) {
    const d = issue.definitions[0];
    return d.file_path ? `${d.file_path}:${d.line || ""}` : "";
  }
  if (issue.file_path) {
    return issue.line ? `${issue.file_path}:${issue.line}` : issue.file_path;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const { dirs, files, outDir, quiet, strict, showHelp } = parseArgs(process.argv);

  if (showHelp) {
    printHelp();
    process.exit(0);
  }

  if (dirs.length === 0 && files.length === 0) {
    die("No input specified. Provide at least one --dir or --file argument.\nRun with --help for usage.");
  }

  // Collect all absolute .tex file paths
  const allPaths = new Set();

  for (const dir of dirs) {
    const absDir = path.resolve(dir);
    if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
      die(`--dir path does not exist or is not a directory: ${absDir}`);
    }
    for (const p of collectTexFiles(absDir)) {
      allPaths.add(p);
    }
  }

  for (const f of files) {
    const absFile = path.resolve(f);
    if (!absFile.endsWith(".tex")) {
      die(`zeta: --file must point to a .tex file: ${absFile}`);
    }
    if (!fs.existsSync(absFile) || !fs.statSync(absFile).isFile()) {
      die(`--file path does not exist or is not a file: ${absFile}`);
    }
    allPaths.add(absFile);
  }

  if (allPaths.size === 0) {
    die("No .tex files found in the specified paths.");
  }

  // Read file contents
  const filesInput = [];
  for (const absPath of allPaths) {
    let content;
    try {
      content = fs.readFileSync(absPath, "utf8");
    } catch (err) {
      process.stderr.write(`zeta: could not read file: ${absPath} (${err.message}), skipping\n`);
      continue;
    }
    filesInput.push({ file_path: path.basename(absPath), content });
  }

  // Run pre-check
  const report = precheck.buildPrecheckReport(filesInput);

  // Map allIssues to flat serialisable objects
  const allIssues = report.analysis?.allIssues || [];
  const issueList = allIssues.map((issue) => ({
    type: issue.type || "",
    symbol: issue.symbol || "",
    severity: issue.severity || "",
    title: precheck.issueTitle(issue),
    location: issueLocation(issue),
  }));

  const notationWarnings = (report.analysis?.notationWarnings || []).map((w) => ({
    type: w.type || "",
    symbol: w.symbol || "",
    severity: w.severity || "",
    title: precheck.issueTitle(w),
    location: issueLocation(w),
  }));

  // Build JSON payload
  const jsonPayload = {
    score: report.score,
    certification: {
      key: report.certification?.key || "",
      label: report.certification?.label || "",
    },
    issues: issueList,
    notationWarnings,
    reviewLedger: report.reviewLedger || [],
    files: [...allPaths].map((p) => path.basename(p)),
    generatedAt: new Date().toISOString(),
  };

  // Build Markdown
  const markdownContent = precheck.markdownReviewerReport(report);

  // Ensure output directory exists
  const absOut = path.resolve(outDir);
  if (!fs.existsSync(absOut)) {
    fs.mkdirSync(absOut, { recursive: true });
  }

  const jsonOutPath = path.join(absOut, "zeta-report.json");
  const mdOutPath = path.join(absOut, "zeta-report.md");

  try {
    fs.writeFileSync(jsonOutPath, JSON.stringify(jsonPayload, null, 2), "utf8");
  } catch (err) {
    process.stderr.write(`zeta: could not write report: ${jsonOutPath} (${err.message})\n`);
    process.exit(1);
  }
  try {
    fs.writeFileSync(mdOutPath, markdownContent, "utf8");
  } catch (err) {
    process.stderr.write(`zeta: could not write report: ${mdOutPath} (${err.message})\n`);
    process.exit(1);
  }

  // Stdout summary (unless --quiet)
  if (!quiet) {
    process.stdout.write(
      [
        `Zeta Pre-Check`,
        `  Files scanned : ${filesInput.length}`,
        `  Issues found  : ${allIssues.length}`,
        `  Score         : ${report.score}`,
        `  Certification : ${report.certification?.label || "(unknown)"}`,
        `  Output        : ${jsonOutPath}`,
        `                  ${mdOutPath}`,
        "",
      ].join("\n")
    );
  }

  // Exit code
  const highSeverityCount = allIssues.filter(
    (i) => i.severity === "error" || i.severity === "high"
  ).length;

  if (strict && allIssues.length > 0) {
    process.exit(1);
  }
  if (!strict && highSeverityCount > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main();
