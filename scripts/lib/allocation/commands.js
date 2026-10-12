'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const io = require('../context-profile-store-fs');
const { AllocationError, fail } = require('./errors');
const { runAllocationOperation } = require('./controller');
const { resultFor, exitCode } = require('./controller-results');

const OPERATIONS = Object.freeze(['run', 'progress', 'checkpoint', 'next', 'switch', 'resume', 'status', 'recover']);
const CONFIG_OPERATIONS = Object.freeze(['run', 'next', 'resume']);
const MAX_BYTES = 65536;
const HELP = `ECC task allocation CLI

Usage:
  ecc allocation <operation> --input <file|-> --db <absolute-path> [--json]
  ecc allocation run --config <policy.json> --input <file|-> --dry-run [--json]

Operations:
  run         Start a configured task (requires --config)
  progress    Save portable task progress without launching a provider
  checkpoint  Record verification and reserve a capability successor
  next        Execute a saved capability successor (requires --config)
  switch      Reserve a safe same-tier provider successor
  resume      Execute a saved provider successor (requires --config)
  status      Read an existing published task snapshot
  recover     Reconcile or abandon without launching a provider

All inputs are strict versioned JSON. run/next/resume require --config.
Only run accepts --dry-run. No database default or environment opt-in is used.
--input - reads stdin. --json emits one redacted result; native output is private.
See docs/workflows/system-1-allocation-usage.md for setup and operation envelopes.
`;

function safePath(value) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 4096
    || unsafeControls(value, false)) fail('INVALID_INPUT', 'A safe input path is required');
  return value;
}

function unsafeControls(value, whitespace) {
  return [...value].some(character => {
    const code = character.codePointAt(0);
    return code < 32 && !(whitespace && [9, 10, 13].includes(code)) || code >= 127 && code <= 159;
  });
}

function validateFlags(result) {
  if (!result.inputPath || (CONFIG_OPERATIONS.includes(result.operation) !== Boolean(result.configPath))
    || (result.dryRun && result.operation !== 'run') || (!result.dryRun && !result.dbPath)
    || (result.dbPath && !path.isAbsolute(result.dbPath)) || result.configPath === '-') {
    fail('INVALID_INPUT', 'CLI flags conflict with the operation');
  }
  return result;
}

function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) fail('INVALID_INPUT', 'Invalid CLI arguments');
  if ((argv.length === 1 && argv[0] === '--help')
    || (argv.length === 2 && OPERATIONS.includes(argv[0]) && argv[1] === '--help')) return { help: true };
  const operation = argv[0];
  if (!OPERATIONS.includes(operation)) fail('INVALID_INPUT', 'An allocation operation is required');
  const result = { operation, configPath: null, inputPath: null, dbPath: null, dryRun: false, json: false, help: false };
  const seen = new Set();
  const fields = { '--config': 'configPath', '--input': 'inputPath', '--db': 'dbPath', '--dry-run': 'dryRun', '--json': 'json' };
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index]; const field = Object.hasOwn(fields, flag) ? fields[flag] : null;
    if (!field || seen.has(flag)) fail('INVALID_INPUT', 'Unknown or duplicate CLI flag');
    seen.add(flag);
    if (flag === '--json' || flag === '--dry-run') result[field] = true;
    else {
      const value = argv[++index];
      if (!value || value.startsWith('--')) fail('INVALID_INPUT', 'A CLI flag value is required');
      result[field] = safePath(value);
    }
  }
  return validateFlags(result);
}

function readFileBytes(inputPath) {
  const file = path.resolve(safePath(inputPath));
  const before = io.inspect(file);
  if (!before.stat.isFile() || before.stat.nlink !== 1 || before.stat.size > MAX_BYTES) fail('INVALID_INPUT', 'Input file is unsafe or oversized');
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const opened = fs.fstatSync(descriptor); io.recheck(before.chain);
    if (opened.dev !== before.stat.dev || opened.ino !== before.stat.ino || opened.size !== before.stat.size
      || opened.mtimeMs !== before.stat.mtimeMs || opened.ctimeMs !== before.stat.ctimeMs || !opened.isFile()) {
      fail('INVALID_INPUT', 'Input file changed during inspection');
    }
    const buffer = Buffer.alloc(opened.size + 1); let count = 0;
    while (count < buffer.length) {
      const length = fs.readSync(descriptor, buffer, count, buffer.length - count, null);
      if (!length) break;
      count += length;
    }
    const after = fs.fstatSync(descriptor); io.recheck(before.chain);
    if (count !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs) fail('INVALID_INPUT', 'Input file changed during read');
    return buffer.subarray(0, count);
  } finally { fs.closeSync(descriptor); }
}

async function readStdinBytes(stdin) {
  const chunks = []; let bytes = 0;
  for await (const chunk of stdin) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > MAX_BYTES) fail('INVALID_INPUT', 'Input exceeds its byte limit');
    chunks.push(value);
  }
  return Buffer.concat(chunks, bytes);
}

async function readOperationInput(inputPath, { stdin = process.stdin, code = 'INVALID_INPUT' } = {}) {
  try {
    const bytes = inputPath === '-' ? await readStdinBytes(stdin) : readFileBytes(inputPath);
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (unsafeControls(value, true)) fail('INVALID_INPUT', 'Input contains terminal controls');
    return JSON.parse(value);
  } catch { fail(code, 'Cannot read bounded UTF-8 JSON input'); }
}

function printProgress(output, event) {
  const labels = { 'classifier-starting': 'Assessing task requirements', 'proposal-starting': 'Selecting ECC context',
    'task-starting': 'Starting task', 'task-completed': 'Task attempt finished', 'usage-limit': 'Subscription usage limit reached',
    'provider-switch': 'Continuing with another provider' };
  if (!Object.hasOwn(labels, event.stage) || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(event.providerId || '')) return;
  output.write(`${labels[event.stage]} (${event.providerId}).\n`);
}

function printHuman(output, result) {
  output.write(`ECC allocation ${result.operation || 'input'}: ${result.status} (${result.code}).\n`);
  if (result.taskState) output.write(`Task state: ${result.taskState}.\n`);
  if (result.route?.tierId) output.write(`Capability tier: ${result.route.tierId}; allocation: ${result.route.allocationId || 'pending'}.\n`);
  if (result.nextActions.length) output.write(`Next actions: ${result.nextActions.join(', ')}.\n`);
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const stdout = dependencies.stdout || process.stdout; const stderr = dependencies.stderr || process.stderr;
  let parsed; let result;
  try {
    parsed = parseArgs(argv);
    if (parsed.help) { stdout.write(HELP); return 0; }
    const input = await readOperationInput(parsed.inputPath, { stdin: dependencies.stdin || process.stdin });
    const policy = parsed.configPath ? await readOperationInput(parsed.configPath, { code: 'INVALID_CONFIG' }) : null;
    result = await (dependencies.runAllocationOperation || runAllocationOperation)({ operation: parsed.operation, input,
      policy, dbPath: parsed.dbPath, dryRun: parsed.dryRun }, {
      ...dependencies, onProgress: event => { if (!parsed.json) printProgress(stderr, event); } });
  } catch (error) {
    const code = error instanceof AllocationError ? error.code : 'ECC_ALLOCATION_INVALID_INPUT';
    result = resultFor({ operation: parsed?.operation || (OPERATIONS.includes(argv?.[0]) ? argv[0] : null),
      input: null, code, status: 'rejected' });
  }
  if (parsed?.json || (Array.isArray(argv) && argv.includes('--json'))) stdout.write(`${JSON.stringify(result)}\n`);
  else printHuman(stdout, result);
  return exitCode(result);
}

module.exports = { parseArgs, readOperationInput, main };
