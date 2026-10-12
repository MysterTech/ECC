'use strict';

const crypto = require('crypto');
const path = require('path');
const { fail } = require('./errors');
const PHASES = ['explore', 'plan', 'implement', 'debug', 'review', 'verify', 'docs', 'maintenance'];
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SHA = /^[a-f0-9]{64}$/;
const CONTROL_CHARACTERS = new Set([...Array(32).keys(), ...Array.from({ length: 33 }, (_, index) => index + 127)]
  .filter(code => ![9, 10, 13].includes(code)));

function invalid(message) { fail('INVALID_INPUT', message); }
function object(raw, keys, required = keys) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) invalid('Expected a plain object.');
  if (Object.keys(raw).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(raw, key))) {
    invalid('Unexpected or missing field.');
  }
  return raw;
}
function text(raw, max = 128, blank = false) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > max || (!blank && !raw.trim())
    || [...raw].some(character => CONTROL_CHARACTERS.has(character.codePointAt(0)))
    || /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(raw)) {
    invalid('Invalid or oversized text.');
  }
  return raw;
}
function id(raw) { if (!ID.test(text(raw))) invalid('Invalid identifier.'); return raw; }
function digest(raw) { if (!SHA.test(text(raw, 64))) invalid('Invalid digest.'); return raw; }
function integer(raw, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(raw) || raw < min || raw > max) invalid('Invalid integer.');
  return raw;
}
function boolean(raw) { if (typeof raw !== 'boolean') invalid('Expected a boolean.'); return raw; }
function asserted(raw) { if (raw !== true) invalid('Explicit assertion required.'); return true; }
function enumeration(raw, values) { if (!values.includes(raw)) invalid('Unknown domain value.'); return raw; }
function timestamp(raw) {
  text(raw, 32);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(raw) || !Number.isFinite(Date.parse(raw))) invalid('Invalid UTC timestamp.');
  const normalized = new Date(raw).toISOString();
  if (normalized.slice(0, 19) !== raw.slice(0, 19)) invalid('Invalid UTC date.');
  return raw;
}
function absolute(raw) {
  text(raw, 4096);
  if (!path.isAbsolute(raw) || [...raw].some(character => character.codePointAt(0) < 32)) invalid('A control-free absolute path is required.');
  return raw;
}
function nullable(raw, normalize) { return raw === null ? null : normalize(raw); }
function array(raw, normalize, min = 0, max = 16, ordered = false) {
  if (!Array.isArray(raw) || raw.length < min || raw.length > max) invalid('Invalid array length.');
  const items = raw.map(normalize);
  const unique = items.map(item => typeof item === 'object' ? canonical(item) : item);
  if (new Set(unique).size !== items.length) invalid('Duplicate array entry.');
  return ordered ? items : [...items].sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol'
    || (typeof value === 'number' && !Number.isFinite(value))) invalid('Value is not canonical JSON.');
  return JSON.stringify(value);
}
function canonicalDigest(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }
function bounded(raw, bytes = 65536) { if (Buffer.byteLength(canonical(raw)) > bytes) invalid('Input exceeds its byte limit.'); }
function identity(raw) {
  object(raw, ['sessionId', 'taskId', 'revision', 'phase']);
  return { sessionId: id(raw.sessionId), taskId: id(raw.taskId), revision: integer(raw.revision, 1), phase: enumeration(raw.phase, PHASES) };
}
function sameIdentity(left, right) {
  if (canonical(identity(left)) !== canonical(identity(right))) invalid('Task and requirement identity differ.');
}

module.exports = { PHASES, ID, invalid, object, text, id, digest, integer, boolean, asserted, enumeration,
  timestamp, absolute, nullable, array, canonical, canonicalDigest, bounded, identity, sameIdentity };
