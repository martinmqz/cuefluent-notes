// Shared, dependency-free validation for the replacement workflow contracts.
import { createHash } from 'node:crypto';

export const CLIENTS = Object.freeze(['codex', 'claude']);

export function fail(code, message = code) { throw Object.assign(new Error(message), { code }); }
export const object = value => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export function keys(value, required, optional = []) {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => ![...required, ...optional].includes(key))) fail('INVALID_WORKFLOW');
}
export function string(value, max = 4096, { empty = false } = {}) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || /[\u0000\ud800-\udfff]/u.test(value)) fail('INVALID_WORKFLOW');
  return value;
}
export function choice(value, allowed) {
  if (!allowed.includes(value)) fail('INVALID_WORKFLOW');
  return value;
}
export function list(value, max = 100, { empty = true } = {}) {
  if (!Array.isArray(value) || value.length > max || (!empty && !value.length) ||
      Array.from({ length: value.length }, (_, index) => index).some(index => !Object.hasOwn(value, index))) fail('INVALID_WORKFLOW');
  return value;
}
export function id(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) fail('INVALID_WORKFLOW');
  return value;
}
export function nativeId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)) fail('UNSUPPORTED_NATIVE_IDENTITY');
  return value;
}
export function hash(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('INVALID_WORKFLOW');
  return value;
}
export function integer(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_WORKFLOW');
  return value;
}
export function unique(values) {
  if (new Set(values).size !== values.length) fail('INVALID_WORKFLOW');
}
export function timestamp(value) {
  string(value, 32);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('INVALID_WORKFLOW');
  return value;
}
// Fixed lexical key ordering, independent of locale and insertion order.
export function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
  if (value === null || ['string', 'boolean'].includes(typeof value) ||
      (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  fail('INVALID_WORKFLOW');
}
export const digest = value => createHash('sha256').update(value).digest('hex');
