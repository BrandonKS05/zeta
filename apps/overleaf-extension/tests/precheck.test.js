const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const precheck = require("../precheck/precheck.js");

test("sample LaTeX paper parser extracts publishing entities", () => {
  const parsed = precheck.parseLatexProject(precheck.DEMO_LATEX_FILES);

  assert.equal(parsed.documents.length, 2);
  assert.equal(parsed.definitions.length, 2);
  assert.equal(parsed.theorems.length, 1);
  assert.equal(parsed.lemmas.length, 1);
  assert.ok(parsed.assumptions.length >= 1);
  assert.ok(parsed.symbols.some((item) => item.symbol === "\\sigma"));
});

test("notation drift detection catches sigma as matrix and scalar", () => {
  const parsed = precheck.parseLatexProject(precheck.DEMO_LATEX_FILES);
  const analysis = precheck.analyzePrecheck(parsed);
  const sigmaDrift = analysis.notationWarnings.find((issue) => issue.symbol === "\\sigma");

  assert.ok(sigmaDrift);
  assert.equal(sigmaDrift.type, "notation_drift");
  assert.match(sigmaDrift.message, /matrix/);
  assert.match(sigmaDrift.message, /scalar/);
});

test("undefined symbol detection catches symbol used before definition", () => {
  const parsed = precheck.parseLatexProject(precheck.DEMO_LATEX_FILES);
  const analysis = precheck.analyzePrecheck(parsed);
  const tauIssue = analysis.undefinedSymbols.find((issue) => issue.symbol === "\\tau");

  assert.ok(tauIssue);
  assert.equal(tauIssue.type, "undefined_symbol");
  assert.match(tauIssue.message, /before its detected definition/);
  assert.equal(tauIssue.first_use.file_path, "results.tex");
});

test("readiness score calculation penalizes warnings without dropping to zero", () => {
  const report = precheck.buildPrecheckReport(precheck.DEMO_LATEX_FILES);

  assert.equal(typeof report.score, "number");
  assert.ok(report.score < 100);
  assert.ok(report.score >= 75);
  assert.equal(report.counts.notationWarnings, 1);
  assert.equal(report.counts.undefinedSymbols, 1);
});

test("certification badge state reflects demo mode and needs-review thresholds", () => {
  const demoReport = precheck.buildPrecheckReport(precheck.DEMO_LATEX_FILES, { demoMode: true });
  assert.equal(demoReport.certification.key, "certified_demo_mode");

  const parsed = precheck.parseLatexProject(precheck.DEMO_LATEX_FILES);
  const analysis = precheck.analyzePrecheck(parsed, {
    verificationIssues: [{ type: "lean", severity: "error", message: "Lean check failed." }],
  });
  const score = precheck.calculateReadinessScore(parsed, analysis);
  const state = precheck.certificationStateFor(score, analysis);
  assert.equal(state.key, "needs_review");
});

test("review ledger generation includes scan, graph, warning, and report events", () => {
  const report = precheck.buildPrecheckReport(precheck.DEMO_LATEX_FILES, {
    timestamp: "2026-05-31T00:00:00.000Z",
  });
  const titles = report.reviewLedger.map((event) => event.title);

  assert.ok(titles.includes("Document scanned"));
  assert.ok(titles.includes("Notation graph built"));
  assert.ok(titles.includes("Drift warning detected"));
  assert.ok(titles.includes("Pre-Check report ready"));
  assert.ok(report.reviewLedger.some((event) => event.status === "warning"));
});

test("Markdown reviewer report is copyable and includes required sections", () => {
  const report = precheck.buildPrecheckReport(precheck.DEMO_LATEX_FILES, {
    demoMode: true,
    timestamp: "2026-05-31T00:00:00.000Z",
  });
  const markdown = precheck.markdownReviewerReport(report);

  assert.match(markdown, /^# Zeta Scientific Pre-Check Report/);
  assert.match(markdown, /Readiness score:/);
  assert.match(markdown, /Certification state: Certified Demo Mode/);
  assert.match(markdown, /## Top Issues/);
  assert.match(markdown, /## Suggested Fixes/);
  assert.match(markdown, /## Review Ledger/);
  assert.match(markdown, /heuristic and optional AI-assisted checks/);
});

test("counterexample explanation fallback explains notation drift", () => {
  const report = precheck.buildPrecheckReport(precheck.DEMO_LATEX_FILES);
  const drift = report.analysis.notationWarnings[0];
  const explanation = precheck.counterexampleExplanationForIssue(drift);

  assert.match(explanation, /Counterexample intuition/);
  assert.match(explanation, /covariance matrix/);
  assert.match(explanation, /scalar variance/);
});

test("demo mode works without API or backend input", () => {
  const report = precheck.buildPrecheckReport(null, { demoMode: true });

  assert.equal(report.demoMode, true);
  assert.equal(report.parsed.documents.length, 2);
  assert.equal(report.certification.key, "certified_demo_mode");
  assert.ok(report.analysis.allIssues.length >= 2);
});

test("in-document review model maps diagnostics to reviewer comments and fixes", () => {
  const report = precheck.buildPrecheckReport(precheck.DEMO_LATEX_FILES, { demoMode: true });
  const items = precheck.inDocumentReviewItems(report);
  const sigma = items.find((item) => item.symbol === "\\sigma");

  assert.ok(sigma);
  assert.equal(sigma.title, "Potential notation drift: \\sigma");
  assert.match(sigma.reviewerComment, /Reviewer Comment #/);
  assert.match(sigma.suggestedFix, /Rename the scalar variance parameter/);
  assert.match(sigma.whyThisMatters, /Submission risk/);
});

test("problem symbol extraction exposes sigma and tau chips for demo mode", () => {
  const report = precheck.buildPrecheckReport(null, { demoMode: true });
  const symbols = precheck.problemSymbolsForReport(report);
  const labels = symbols.map((item) => item.symbol);

  assert.ok(labels.includes("\\sigma"));
  assert.ok(labels.includes("\\tau"));
  assert.ok(symbols.every((item) => item.title && item.severity));
});

test("suggested fix generation handles used-before-definition warnings", () => {
  const report = precheck.buildPrecheckReport(precheck.DEMO_LATEX_FILES);
  const tauIssue = report.analysis.undefinedSymbols.find((issue) => issue.symbol === "\\tau");
  const fix = precheck.suggestedFixForIssue(tauIssue);
  const comment = precheck.reviewerCommentForIssue(tauIssue, 1);

  assert.match(fix, /Define \\tau before/);
  assert.match(comment, /Reviewer Comment #2/);
  assert.match(comment, /Recommended author action/);
});

test("AI reviewer summary falls back deterministically without provider", async () => {
  const report = precheck.buildPrecheckReport(null, { demoMode: true });
  const summary = await precheck.generateReviewerSummary(report);

  assert.equal(summary.state.key, "heuristic_fallback");
  assert.match(summary.text, /Zeta found/);
  assert.ok(summary.usedSignals.includes("unified diagnostics"));
  assert.ok(summary.usedSignals.includes("Lean/verifier info"));
});

test("AI reviewer summary uses provider-neutral fake provider", async () => {
  const report = precheck.buildPrecheckReport(precheck.DEMO_LATEX_FILES, {
    verificationIssues: [{ type: "lean", severity: "warning", message: "Lean failed to close a proof obligation." }],
  });
  report.repairs = [{ issueId: "notation-drift-sigma", text: "Rename scalar sigma." }];

  const seen = {};
  const summary = await precheck.generateReviewerSummary(report, {
    reviewerSummaryProvider: async (context) => {
      seen.diagnostics = context.diagnostics.length;
      seen.definitions = context.mathEntities.definitions.length;
      seen.leanIssues = context.lean.verificationIssues.length;
      seen.repairs = context.repairs.length;
      return {
        providerName: "fake-test-provider",
        text: "AI reviewer: prioritize notation drift, then Lean repair follow-up.",
        bullets: [
          `Diagnostics: ${context.diagnostics.length}`,
          `Repairs: ${context.repairs.length}`,
        ],
        usedSignals: ["fake provider", "unified diagnostics", "Lean/verifier info"],
      };
    },
  });

  assert.equal(summary.state.key, "ai_generated");
  assert.equal(summary.providerName, "fake-test-provider");
  assert.match(summary.text, /AI reviewer/);
  assert.equal(seen.diagnostics, report.analysis.allIssues.length);
  assert.equal(seen.definitions, report.parsed.definitions.length);
  assert.equal(seen.leanIssues, 1);
  assert.equal(seen.repairs, 1);
});

test("AI reviewer summary returns unavailable for invalid report input", async () => {
  const summary = await precheck.generateReviewerSummary(null, {
    reviewerSummaryProvider: async () => "should not run",
  });

  assert.equal(summary.state.key, "unavailable");
});

test("AI reviewer summary can surface unavailable state on provider failure", async () => {
  const report = precheck.buildPrecheckReport(null, { demoMode: true });
  const summary = await precheck.generateReviewerSummary(report, {
    providerFailureState: "unavailable",
    reviewerSummaryProvider: async () => {
      throw new Error("backend unavailable");
    },
  });

  assert.equal(summary.state.key, "unavailable");
  assert.match(summary.text, /backend LLM request failed or timed out/);
});

test("CLI writes zeta-report.json and zeta-report.md for a two-file fixture project", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zeta-cli-test-"));
  try {
    // main.tex: defines sigma as matrix
    fs.writeFileSync(
      path.join(tmpDir, "main.tex"),
      String.raw`\begin{definition}[Covariance]
Let $\sigma$ be a covariance matrix in $\mathbb{R}^{n \times n}$.
\end{definition}`
    );
    // results.tex: uses sigma as scalar
    fs.writeFileSync(
      path.join(tmpDir, "results.tex"),
      String.raw`\begin{lemma}[Scalar use]
Let $\sigma > 0$ be the scalar variance.
\end{lemma}`
    );

    const cliPath = path.resolve(__dirname, "../precheck/cli.js");
    execSync(`node ${cliPath} --dir ${tmpDir} --out ${tmpDir}`, { encoding: "utf8" });

    const jsonPath = path.join(tmpDir, "zeta-report.json");
    const mdPath = path.join(tmpDir, "zeta-report.md");

    assert.ok(fs.existsSync(jsonPath), "zeta-report.json should exist");
    assert.ok(fs.existsSync(mdPath), "zeta-report.md should exist");

    const reportData = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    assert.equal(typeof reportData.score, "number", "score should be a number");
    assert.ok(Array.isArray(reportData.issues), "issues should be an array");

    const mdContent = fs.readFileSync(mdPath, "utf8");
    assert.match(mdContent, /Zeta/, "markdown should contain 'Zeta'");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
