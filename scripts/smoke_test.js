#!/usr/bin/env node

/**
 * Smoke test for Zeta backend
 * Verifies backend health and basic solve endpoint functionality
 * Usage: node scripts/smoke_test.js
 * Environment: ZETA_BACKEND_URL (default: http://localhost:8000)
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");

const DEFAULT_BACKEND_URL = "http://localhost:8000";
const REQUEST_TIMEOUT = 5000;

/**
 * Make an HTTP/HTTPS request and return the response
 * @param {string} urlStr - Full URL to request
 * @param {Object} options - Request options (method, headers)
 * @param {string|null} body - Optional request body
 * @returns {Promise<{status: number, body: string}>}
 */
function httpRequest(urlStr, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch (err) {
      reject(new Error(`Invalid URL: ${urlStr}`));
      return;
    }

    const mod = parsed.protocol === "https:" ? https : http;
    const port = parsed.port || (parsed.protocol === "https:" ? 443 : 80);
    const path = parsed.pathname + (parsed.search || "");

    const req = mod.request(
      {
        hostname: parsed.hostname,
        port: port,
        path: path,
        method: options.method || "GET",
        headers: options.headers || {},
        timeout: REQUEST_TIMEOUT,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode, body: data });
        });
      }
    );

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });

    req.on("error", reject);

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

/**
 * Run the smoke test
 */
async function runSmokeTest() {
  const backendUrl = process.env.ZETA_BACKEND_URL || DEFAULT_BACKEND_URL;

  try {
    // Step 1: Check backend health
    let response;
    try {
      response = await httpRequest(`${backendUrl}/healthz`, { method: "GET" });
    } catch (err) {
      console.error(
        `✗ Backend not reachable at ${backendUrl}`
      );
      console.error("Setup: start the backend with:");
      console.error(
        "  cd services/lean-backend && uvicorn app.main:app --reload --port 8000"
      );
      console.error("Set ZETA_BACKEND_URL env var to override the default URL.");
      process.exit(1);
    }

    if (response.status !== 200) {
      console.error(
        `✗ Backend health check failed with status ${response.status}`
      );
      process.exit(1);
    }

    let healthData;
    try {
      healthData = JSON.parse(response.body);
    } catch (err) {
      console.error("✗ Backend health response is not valid JSON");
      process.exit(1);
    }

    if (healthData.status !== "ok") {
      console.error(`✗ Backend status is not ok: ${healthData.status}`);
      process.exit(1);
    }

    console.log("✓ Backend health: ok");

    // Step 1b: Check service status (LLM / Modal config)
    try {
      const statusResp = await httpRequest(`${backendUrl}/v1/status`, { method: "GET" });
      if (statusResp.status === 200) {
        const statusData = JSON.parse(statusResp.body);
        const llmLabel = statusData.llm_configured ? "configured" : "not configured";
        const modalLabel = statusData.modal_configured ? "configured" : "not configured";
        console.log(`  LLM:   ${llmLabel}`);
        console.log(`  Modal: ${modalLabel}`);
      }
    } catch (_e) { /* /v1/status optional */ }

    // Step 2: Test solve endpoint
    const solvePayload = JSON.stringify({
      nl_input:
        "Prove that for all natural numbers n, n + 0 = n.",
      context: {},
      max_iters: 1,
    });

    try {
      response = await httpRequest(`${backendUrl}/v1/lean/solve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(solvePayload),
        },
      }, solvePayload);
    } catch (err) {
      console.error(`✗ Solve endpoint request failed: ${err.message}`);
      process.exit(1);
    }

    if (response.status !== 200) {
      console.error(
        `✗ Solve endpoint returned status ${response.status}`
      );
      process.exit(1);
    }

    let solveData;
    try {
      solveData = JSON.parse(response.body);
    } catch (err) {
      console.error("✗ Solve response is not valid JSON");
      process.exit(1);
    }

    // Verify it's a valid object with some keys
    if (typeof solveData !== "object" || solveData === null) {
      console.error("✗ Solve response is not a valid object");
      process.exit(1);
    }

    const provider = solveData.provider || solveData.source || solveData.model || "backend";
    console.log(`✓ Solve response received (provider: ${provider})`);

    // Success
    console.log("✓ Smoke test passed");
    process.exit(0);
  } catch (err) {
    console.error(`✗ Unexpected error: ${err.message}`);
    process.exit(1);
  }
}

runSmokeTest();
