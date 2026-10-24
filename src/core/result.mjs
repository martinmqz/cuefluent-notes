import path from 'node:path';
import { fail } from './errors.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fields = ['schemaVersion', 'runId', 'projectId', 'status', 'paths', 'counts', 'warnings'];
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('RESULT_INVALID', 'Result must contain plain metadata.');
  const descriptors = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(descriptors);
  if (names.length !== keys.length || names.some(key => !keys.includes(key) || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable)) fail('RESULT_INVALID', 'Result contains unsupported fields.');
}
function strings(value, limit, length) {
  if (!Array.isArray(value) || value.length > limit) fail('RESULT_INVALID', 'Result list exceeds its metadata bound.');
  const descriptors = Object.getOwnPropertyDescriptors(value), result = [];
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) fail('RESULT_INVALID', 'Result lists must contain only indexed values.');
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(descriptors, index) || !Object.hasOwn(descriptors[index], 'value') || !descriptors[index].enumerable) fail('RESULT_INVALID', 'Result lists must be dense data arrays.');
    const item = descriptors[index].value;
    if (typeof item !== 'string' || !item.length || item.length > length || /[\u0000-\u001f\u007f]/.test(item)) fail('RESULT_INVALID', 'Result text must be bounded metadata on one line.');
    result.push(item);
  }
  return Object.freeze(result);
}
/** Latest outcome is descriptive only. It cannot authorize a note write or
 * removal, and contains neither conversation nor selected-record receipt history.
 */
export function validateResult(input) {
  const hasRequest = Object.hasOwn(input ?? {}, 'requestHash');
  object(input, hasRequest ? [...fields, 'requestHash'] : fields);
  if (hasRequest && (typeof input.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.requestHash) || input.runId === null)) fail('RESULT_INVALID', 'Direct results require their exact request hash.');
  if (input.schemaVersion !== 1 || !(input.runId === null || typeof input.runId === 'string' && UUID.test(input.runId)) ||
      typeof input.projectId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.projectId) ||
      !['saved', 'nothing-useful', 'skipped', 'empty'].includes(input.status)) fail('RESULT_INVALID', 'Unsupported result identity or state.');
  object(input.counts, ['handled', 'saved', 'remaining']);
  for (const [key, count] of Object.entries(input.counts)) {
    if (!(key === 'remaining' && count === null) && (!Number.isSafeInteger(count) || count < 0)) fail('RESULT_INVALID', 'Result counts must be nonnegative integers or an explicitly unknown remaining count.');
  }
  const paths = strings(input.paths, 1024, 32768), warnings = strings(input.warnings, 128, 1024);
  if (paths.some(target => !path.isAbsolute(target) || path.normalize(target) !== target)) fail('RESULT_INVALID', 'Saved paths must be canonical absolute paths.');
  return Object.freeze({ schemaVersion: 1, runId: input.runId, projectId: input.projectId, status: input.status,
    paths, counts: Object.freeze({ ...input.counts }), warnings, ...(hasRequest ? { requestHash: input.requestHash } : {}) });
}

export function completedResult(run, { skipped = false, remaining = null } = {}) {
  const changed = run.saved.filter(item => item.changed);
  return validateResult({ schemaVersion: 1, runId: run.id, projectId: run.projectId,
    status: skipped ? 'skipped' : changed.length ? 'saved' : 'nothing-useful',
    paths: changed.map(item => item.target), counts: {
      handled: skipped ? 0 : run.selection.length, saved: changed.length, remaining,
    }, warnings: run.warnings, ...(run.scope.kind === 'direct' ? { requestHash: run.scope.requestHash } : {}) });
}
