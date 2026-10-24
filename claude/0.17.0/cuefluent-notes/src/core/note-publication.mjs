import path from 'node:path';
import { fail } from './errors.mjs';

export const MAX_NOTE_BYTES = 10 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const ID = /^(?:0|[1-9][0-9]{0,39})$/;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const invalid = message => fail('NOTE_PUBLICATION_INVALID', message);

function data(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(`${label} must be a plain data object.`);
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  if (keys.length !== fields.length || fields.some(key => !Object.hasOwn(descriptors, key)) || keys.some(key =>
    typeof key !== 'string' || !fields.includes(key) || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable)) invalid(`${label} must contain exactly its supported data fields.`);
}

function identity(value) {
  data(value, ['device', 'inode'], 'File identity');
  if (typeof value.device !== 'string' || !ID.test(value.device) || typeof value.inode !== 'string' || !ID.test(value.inode)) invalid('Invalid exact file identity.');
  return Object.freeze({ device: value.device, inode: value.inode });
}

function boundedPath(value, paths) {
  if (typeof value !== 'string' || value.length > 4096) invalid('Publication paths must be bounded.');
  if (/[\u0000-\u001f\u007f]/.test(value) || !paths.isAbsolute(value) || paths.normalize(value) !== value) invalid('Use a normalized absolute publication path.');
  if (paths === path.win32 && (!/^[A-Za-z]:\\/.test(value) || value.slice(3).split('\\').some(part => /[:*?"<>|]|[. ]$/.test(part) || RESERVED.test(part)))) invalid('Use a local Windows publication path without aliases or alternate streams.');
  return value;
}

/** The current run owns this metadata; it contains no note text or receipt history.
 * stage:null is the read-only preparation state. A stage inode must be durably
 * recorded through persistIntent before native cloning or note-content writes.
 */
export function validateNotePublication(input, { platform = process.platform } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  data(input, ['schema', 'runId', 'draftId', 'root', 'relative', 'parent', 'expectedHash', 'hash', 'bytes', 'original', 'stage', 'capture'], 'Note publication');
  if (input.schema !== 1 || typeof input.runId !== 'string' || !UUID.test(input.runId) ||
      typeof input.draftId !== 'string' || !UUID.test(input.draftId) || input.runId === input.draftId ||
      (input.expectedHash !== null && (typeof input.expectedHash !== 'string' || !HASH.test(input.expectedHash))) ||
      typeof input.hash !== 'string' || !HASH.test(input.hash) ||
      !Number.isSafeInteger(input.bytes) || input.bytes < 0 || input.bytes > MAX_NOTE_BYTES) invalid('Invalid publication identity, hash, or size.');
  const root = boundedPath(input.root, paths);
  if (typeof input.relative !== 'string' || input.relative.length > 4096 || !/\.(?:md|markdown)$/i.test(input.relative)) invalid('The publication target must be a bounded Markdown path.');
  if (!input.relative || /[\u0000-\u001f\u007f\\]/.test(input.relative) || input.relative.split('/').some(part => !part || part === '.' || part === '..' || /[:*?"<>|]|[. ]$/.test(part) || RESERVED.test(part))) invalid('Use a portable relative publication path.');
  const target = paths.join(root, ...input.relative.split('/'));
  if (!Array.isArray(input.parent) || !input.parent.length || input.parent.length > 128 ||
      Reflect.ownKeys(Object.getOwnPropertyDescriptors(input.parent)).length !== input.parent.length + 1) invalid('The parent pin must be a bounded dense array.');
  const parent = [];
  for (let i = 0; i < input.parent.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(input.parent, i);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid('Parent pins must contain data entries.');
    const entry = descriptor.value;
    data(entry, ['path', 'device', 'inode'], 'Parent pin');
    const name = boundedPath(entry.path, paths), exact = identity({ device: entry.device, inode: entry.inode });
    if ((i === 0 && paths.dirname(name) !== name) || (i > 0 && paths.dirname(name) !== parent[i - 1].path)) invalid('Parent pins must describe the complete ancestor chain.');
    parent.push(Object.freeze({ path: name, ...exact }));
  }
  if (parent.at(-1).path !== paths.dirname(target) || !parent.some(entry => entry.path === root)) invalid('The target must have its exact pinned root and parent.');
  let original = null;
  if (input.original !== null) {
    data(input.original, ['device', 'inode', 'metadata'], 'Inspected original');
    const exact = identity({ device: input.original.device, inode: input.original.inode });
    if (typeof input.original.metadata !== 'string' || !HASH.test(input.original.metadata)) invalid('Original metadata requires an exact digest.');
    original = Object.freeze({ ...exact, metadata: input.original.metadata });
  }
  if ((input.expectedHash === null) !== (original === null)) invalid('Absent and inspected-original expectations must agree.');
  const stage = input.stage === null ? null : identity(input.stage);
  if (stage && original && stage.device === original.device && stage.inode === original.inode) invalid('A stage cannot alias the original note.');
  const capture = input.capture === null ? null : identity(input.capture);
  if (capture && (!original || !stage)) invalid('A capture requires the inspected original and recorded stage.');
  const result = Object.freeze({ schema: 1, runId: input.runId, draftId: input.draftId, root, relative: input.relative,
    parent: Object.freeze(parent), expectedHash: input.expectedHash, hash: input.hash, bytes: input.bytes, original, stage, capture });
  if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024) invalid('The publication intent exceeds its metadata profile.');
  return result;
}
