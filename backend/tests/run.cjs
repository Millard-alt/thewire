/**
 * Isolated test runner for The Wire.
 * Boots the server on a dedicated test port (4123) with a fresh SQLite file,
 * executes e2e.mjs, and safely shuts down the server.
 * A unique temp DB path is used each run so prior test state never bleeds in.
 */
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');

const TEST_PORT = 4123;
const TEST_BASE = `http://127.0.0.1:${TEST_PORT}`;

// Fresh temp DB per run — no stale data from previous tests
const SQLITE_PATH = path.join(os.tmpdir(), `wire-test-${Date.now()}.db`);

function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function ping() {
      http.get(`${url}/api/content`, (res) => {
        if (res.statusCode === 200) resolve();
        else retry();
      }).on('error', retry);
    }
    function retry() {
      if (Date.now() - start > timeoutMs) {
        return reject(new Error('Timeout waiting for test server to start'));
      }
      setTimeout(ping, 250);
    }
    ping();
  });
}

async function run() {
  console.log('[test-runner] Starting isolated test server on port ' + TEST_PORT + ' (SQLite)...');

  const serverProc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      DATABASE_URL: '', // Force SQLite for safe isolated testing
      SQLITE_PATH,      // Fresh file, never shared with production
      NODE_ENV: 'test',
      OWNER_USERNAME: 'owner',
      OWNER_PASSWORD: 'change-me-now'
    },
    stdio: 'ignore'
  });

  function cleanup() {
    serverProc.kill();
    try { fs.unlinkSync(SQLITE_PATH); } catch (e) { /* best-effort */ }
  }

  try {
    await waitForServer(TEST_BASE);
    console.log('[test-runner] Server ready. Running e2e test suite...');

    const testProc = spawn(process.execPath, ['tests/e2e.mjs'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        TEST_BASE,
        OWNER_USERNAME: 'owner',
        OWNER_PASSWORD: 'change-me-now'
      },
      stdio: 'inherit'
    });

    testProc.on('exit', (code) => {
      cleanup();
      process.exit(code || 0);
    });
  } catch (err) {
    console.error('[test-runner] Error:', err.message);
    cleanup();
    process.exit(1);
  }
}

run();
