'use strict';

const { spawn: nativeSpawn } = require('node:child_process');
const { TextDecoder } = require('node:util');
const { failure } = require('./provider-common');

async function probe(command, args, { cwd, env, spawn = nativeSpawn }) {
  return new Promise((resolve, reject) => {
    let child; let bytes = 0; let text = ''; let closed = false; let failed = false;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const error = () => failure('ECC_ALLOCATION_AUTH_ROUTE_UNVERIFIED', 'Native runtime observation is unavailable');
    let killTimer; let reapTimer;
    const stop = () => {
      if (closed || failed) return;
      failed = true; child?.kill('SIGTERM');
      killTimer = setTimeout(() => { if (!closed) child?.kill('SIGKILL'); }, 500);
      reapTimer = setTimeout(() => {
        if (closed) return;
        child?.stdout.destroy(); child?.stderr.destroy(); finish(null, null);
      }, 1500);
    };
    const timer = setTimeout(stop, 5000);
    function finish(code, signal) {
      if (closed) return;
      closed = true; clearTimeout(timer); clearTimeout(killTimer); clearTimeout(reapTimer);
      try { text += decoder.decode(); } catch { failed = true; }
      if (failed || signal || code !== 0) reject(error()); else resolve(text);
    }
    function data(chunk, stdout) {
      bytes += chunk.length;
      if (bytes > 65536) return stop();
      if (stdout) { try { text += decoder.decode(chunk, { stream: true }); } catch { stop(); } }
    }
    try { child = spawn(command, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { finish(null, null); return; }
    child.stdout.on('data', chunk => data(chunk, true)); child.stderr.on('data', chunk => data(chunk, false));
    child.on('error', () => finish(null, null)); child.on('close', finish);
  });
}

module.exports = { probe };
