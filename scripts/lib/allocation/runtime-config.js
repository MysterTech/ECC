'use strict';

const fs = require('node:fs');
const path = require('node:path');
const TOML = require('@iarna/toml');
const { TextDecoder } = require('node:util');
const io = require('../context-profile-store-fs');
const { digestObject, failure } = require('./provider-common');

function readBoundConfig(file) {
  try {
    const canonical = fs.realpathSync(file);
    if (canonical !== file) throw new Error('noncanonical');
    const bytes = io.read(file);
    if (bytes.length > 65536) throw new Error('bound');
    return bytes;
  } catch { throw failure('ECC_ALLOCATION_BINDING_CHANGED', 'Native configuration cannot be safely bound'); }
}

function parseConfig(file, bytes, target) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return target === 'codex' ? TOML.parse(text) : JSON.parse(text);
  }
  catch { throw failure('ECC_ALLOCATION_AUTH_ROUTE_UNVERIFIED', 'Native configuration cannot establish a subscription route'); }
}

function checkRouteConfig(value, target, depth = 0) {
  if (depth > 16) throw failure('ECC_ALLOCATION_AUTH_ROUTE_UNVERIFIED', 'Native configuration nesting exceeds its bound');
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:apiKeyHelper|apiKey|api_key|authToken|auth_token|base_url|baseUrl|model_providers|env_key|envKey|credentials|credentialHelper)$/.test(key)
      || (key === 'model_provider' && item !== 'openai')
      || (key === 'forced_login_method' && item !== 'chatgpt')) {
      throw failure('ECC_ALLOCATION_SUBSCRIPTION_REQUIRED', 'Native configuration selects an unverified billing route');
    }
    if (key === 'env') require('./subscription-guard').assertSubscriptionEnvironment(item);
    if (target === 'claude' && /^(?:provider|modelProvider|endpoint)$/.test(key)) {
      throw failure('ECC_ALLOCATION_SUBSCRIPTION_REQUIRED', 'Claude native backend route cannot be verified');
    }
    checkRouteConfig(item, target, depth + 1);
  }
}

function configDigest(record, bytes, document, target) {
  if (record.normalization === 'raw') return io.hash(bytes);
  if (record.normalization === 'codex-provider-bookkeeping-v1' && target === 'codex') {
    const { trust: _trust, projects: _projects, ...stable } = document;
    return digestObject(stable);
  }
  throw failure('ECC_ALLOCATION_INCOMPATIBLE', 'Unsupported native configuration normalization');
}

function routeFiles(provider, providerHome, workingRepoRoot) {
  if (provider.target === 'codex') return [path.join(providerHome, 'config.toml'),
    path.join(providerHome, 'requirements.toml'), path.join(workingRepoRoot, '.codex/config.toml')];
  return [path.join(providerHome, 'settings.json'), path.join(providerHome, 'settings.local.json'),
    path.join(workingRepoRoot, '.claude/settings.json'), path.join(workingRepoRoot, '.claude/settings.local.json'),
    ...(process.platform === 'darwin' ? ['/Library/Application Support/ClaudeCode/managed-settings.json'] :
      process.platform === 'linux' ? ['/etc/claude-code/managed-settings.json'] : [])];
}

function inspectConfiguration({ provider, providerHome, workingRepoRoot }) {
  const records = provider.knownConfigBindings;
  const required = routeFiles(provider, providerHome, workingRepoRoot).filter(file => fs.existsSync(file));
  if (required.some(file => !records.some(record => record.path === file))) {
    throw failure('ECC_ALLOCATION_AUTH_ROUTE_UNVERIFIED', 'Native route configuration is not pinned');
  }
  return records.map(record => {
    const bytes = readBoundConfig(record.path);
    const document = /\.(?:json|toml)$/.test(record.path) || record.normalization !== 'raw'
      ? parseConfig(record.path, bytes, provider.target) : {};
    checkRouteConfig(document, provider.target);
    const digest = configDigest(record, bytes, document, provider.target);
    if (digest !== record.digest) throw failure('ECC_ALLOCATION_BINDING_CHANGED', 'Native configuration binding changed');
    return { path: record.path, digest, normalization: record.normalization };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

module.exports = { inspectConfiguration, readBoundConfig, checkRouteConfig };
