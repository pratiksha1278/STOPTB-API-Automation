/**
 * generate-summary.js
 *
 * Reads the Newman JSON reporter output (newman/report.json) and produces:
 *   1. GITHUB_OUTPUT values (counts, timing, collection info) for the email step.
 *   2. A standalone detailed-summary.html with an expandable section per request
 *      (status, timing, size, assertions, truncated req/response bodies).
 *
 * If report.json is missing (e.g. an earlier step failed before Newman ran),
 * this script does NOT throw — it writes a fallback summary/outputs so the
 * email step still has something valid to attach and report, instead of the
 * pipeline silently producing a half-finished result.
 */

const fs = require('fs');
const path = require('path');

const REPORT_PATH = path.join(process.cwd(), 'newman', 'report.json');
const OUT_HTML = path.join(process.cwd(), 'detailed-summary.html');

function writeOutputs(outputs) {
  const githubOutputPath = process.env.GITHUB_OUTPUT;
  if (githubOutputPath) {
    const lines = Object.entries(outputs).map(([k, v]) => `${k}=${v}`).join('\n');
    fs.appendFileSync(githubOutputPath, lines + '\n');
  }
  console.log('Summary outputs:', outputs);
}

if (!fs.existsSync(REPORT_PATH)) {
  console.error(`newman/report.json not found at ${REPORT_PATH} — an earlier step likely failed before Newman ran (check the "Fetch Postman collection/environment" and "Run Newman collection" steps).`);

  const fallbackHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>StopTB Perf Test Suite — Run Failed</title></head>
  <body style="font-family:Segoe UI, Arial, sans-serif; padding:16px;">
    <h2 style="color:#cf222e;">StopTB Perf Test Suite — Pipeline did not reach the test run</h2>
    <p><code>newman/report.json</code> was not found. This means Newman never executed — most likely the Postman collection or environment fetch step failed (missing/invalid <code>POSTMAN_API_KEY</code>, <code>POSTMAN_COLLECTION_UID</code>, or <code>POSTMAN_ENVIRONMENT_UID</code>), or the login/token step in the collection itself failed.</p>
    <p>Check the workflow run logs for the "Fetch Postman collection", "Fetch Postman environment", and "Run Newman collection" steps.</p>
  </body></html>`;
  fs.writeFileSync(OUT_HTML, fallbackHtml, 'utf8');

  writeOutputs({
    collection_name: 'N/A (run did not start)',
    total_iterations: 0,
    total_requests: 0,
    total_assertions: 0,
    passed_assertions: 0,
    failed_assertions: 0,
    skipped_assertions: 0,
    failed_requests: 0,
    execution_time_sec: '0.00',
    overall_status: 'FAILED - PRE-RUN ERROR',
  });

  // Exit 0 on purpose: we WANT the upload-artifact and email steps to still
  // run with this fallback content rather than the job dying silently here.
  process.exit(0);
}

const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
const run = report.run;
const stats = run.stats;
const timings = run.timings;
const collectionName = report.collection ? report.collection.info.name : 'Unknown Collection';

const totalIterations = stats.iterations.total;
const totalAssertions = stats.assertions.total;
const failedAssertions = stats.assertions.failed;
const passedAssertions = totalAssertions - failedAssertions;
const skippedAssertions = stats.assertions.pending || 0;
const totalRequests = stats.requests.total;
const failedRequests = stats.requests.failed;

const executionTimeMs = (timings.completed || 0) - (timings.started || 0);
const executionTimeSec = (executionTimeMs / 1000).toFixed(2);

const executions = run.executions || [];

function escapeHtml(str) {
  if (str === undefined || str === null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeBody(bodyStream) {
  if (!bodyStream) return '';
  try {
    if (bodyStream.toJSON) {
      const buf = bodyStream.toJSON();
      return Buffer.from(buf.data || []).toString('utf8');
    }
    return String(bodyStream);
  } catch (e) {
    return '[unable to render body]';
  }
}

const rows = executions.map((exec, idx) => {
  const name = exec.item ? exec.item.name : `Request ${idx + 1}`;
  const req = exec.request || {};
  const res = exec.response || {};
  const method = req.method || 'N/A';
  const url = req.url ? (req.url.toString ? req.url.toString() : JSON.stringify(req.url)) : 'N/A';
  const status = res.code !== undefined ? res.code : 'N/A';
  const statusText = res.status || '';
  const responseTime = res.responseTime !== undefined ? `${res.responseTime} ms` : 'N/A';
  const responseSize = res.responseSize !== undefined ? `${(res.responseSize / 1024).toFixed(2)} KB` : 'N/A';

  const assertions = exec.assertions || [];
  const failedInThisRequest = assertions.filter(a => a.error);
  const requestPassed = failedInThisRequest.length === 0;

  const statusBadge = requestPassed
    ? '<span style="color:#1a7f37;font-weight:600;">PASS</span>'
    : '<span style="color:#cf222e;font-weight:600;">FAIL</span>';

  const assertionList = assertions.map(a => {
    if (a.error) {
      return `<li style="color:#cf222e;">✗ ${escapeHtml(a.assertion)} — ${escapeHtml(a.error.message)}</li>`;
    }
    return `<li style="color:#1a7f37;">✓ ${escapeHtml(a.assertion)}</li>`;
  }).join('');

  let requestBodyHtml = '';
  if (req.body && req.body.raw) {
    requestBodyHtml = `<pre style="background:#f6f8fa;padding:8px;overflow-x:auto;">${escapeHtml(req.body.raw).slice(0, 2000)}</pre>`;
  }

  let responseBodyHtml = '';
  const rawResponseBody = safeBody(res.stream || res.body);
  if (rawResponseBody) {
    responseBodyHtml = `<pre style="background:#f6f8fa;padding:8px;overflow-x:auto;">${escapeHtml(rawResponseBody).slice(0, 2000)}</pre>`;
  }

  return `
  <details style="border:1px solid #d0d7de;border-radius:6px;margin-bottom:8px;padding:8px 12px;">
    <summary style="cursor:pointer;font-weight:600;">
      ${statusBadge} — ${escapeHtml(method)} ${escapeHtml(name)}
      <span style="font-weight:400;color:#57606a;"> (${status} ${escapeHtml(statusText)}, ${responseTime}, ${responseSize})</span>
    </summary>
    <div style="margin-top:8px;">
      <p><strong>URL:</strong> ${escapeHtml(url)}</p>
      <p><strong>Assertions:</strong></p>
      <ul>${assertionList || '<li>No assertions defined</li>'}</ul>
      ${requestBodyHtml ? `<p><strong>Request Body:</strong></p>${requestBodyHtml}` : ''}
      ${responseBodyHtml ? `<p><strong>Response Body (truncated):</strong></p>${responseBodyHtml}` : ''}
    </div>
  </details>`;
}).join('\n');

const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>StopTB Perf Test Suite — Execution Summary</title>
</head>
<body style="font-family:Segoe UI, Arial, sans-serif; color:#1f2328; max-width:900px; margin:0 auto; padding:16px;">
  <h2>StopTB Perf Test Suite — Execution Summary</h2>
  <p><strong>Collection:</strong> ${escapeHtml(collectionName)}</p>
  <table style="border-collapse:collapse; width:100%; margin-bottom:16px;">
    <tr><td style="padding:4px 8px;border:1px solid #d0d7de;">Total Iterations</td><td style="padding:4px 8px;border:1px solid #d0d7de;">${totalIterations}</td></tr>
    <tr><td style="padding:4px 8px;border:1px solid #d0d7de;">Total Requests</td><td style="padding:4px 8px;border:1px solid #d0d7de;">${totalRequests}</td></tr>
    <tr><td style="padding:4px 8px;border:1px solid #d0d7de;">Total Assertions</td><td style="padding:4px 8px;border:1px solid #d0d7de;">${totalAssertions}</td></tr>
    <tr><td style="padding:4px 8px;border:1px solid #d0d7de;">Passed Assertions</td><td style="padding:4px 8px;border:1px solid #d0d7de;color:#1a7f37;">${passedAssertions}</td></tr>
    <tr><td style="padding:4px 8px;border:1px solid #d0d7de;">Failed Assertions</td><td style="padding:4px 8px;border:1px solid #d0d7de;color:#cf222e;">${failedAssertions}</td></tr>
    <tr><td style="padding:4px 8px;border:1px solid #d0d7de;">Skipped Assertions</td><td style="padding:4px 8px;border:1px solid #d0d7de;">${skippedAssertions}</td></tr>
    <tr><td style="padding:4px 8px;border:1px solid #d0d7de;">Failed Requests</td><td style="padding:4px 8px;border:1px solid #d0d7de;color:#cf222e;">${failedRequests}</td></tr>
    <tr><td style="padding:4px 8px;border:1px solid #d0d7de;">Execution Time</td><td style="padding:4px 8px;border:1px solid #d0d7de;">${executionTimeSec} s</td></tr>
  </table>
  <h3>Request-Level Detail (click to expand)</h3>
  ${rows}
</body>
</html>`;

fs.writeFileSync(OUT_HTML, html, 'utf8');

writeOutputs({
  collection_name: collectionName,
  total_iterations: totalIterations,
  total_requests: totalRequests,
  total_assertions: totalAssertions,
  passed_assertions: passedAssertions,
  failed_assertions: failedAssertions,
  skipped_assertions: skippedAssertions,
  failed_requests: failedRequests,
  execution_time_sec: executionTimeSec,
  overall_status: failedAssertions > 0 || failedRequests > 0 ? 'FAILED' : 'PASSED',
});
