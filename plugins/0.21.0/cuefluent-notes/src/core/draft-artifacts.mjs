import path from 'node:path';
import { isMarkdownPath } from './note-path.mjs';
import { fail } from './errors.mjs';
import { validateNoteBinding } from './note-binding.mjs';
import { MAX_NOTE_BYTES } from './note-publication.mjs';

export const DRAFT_ARTIFACT_LIMITS = Object.freeze({ drafts: 64, manifestBytes: 2 * 1024 * 1024, journalBytes: 4 * 1024 * 1024, fileBytes: MAX_NOTE_BYTES });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const ID = /^(?:0|[1-9][0-9]{0,39})$/;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const invalid = message => fail('DRAFT_ARTIFACT_INVALID', message);
const uuid = value => typeof value === 'string' && UUID.test(value);
const hash = value => typeof value === 'string' && HASH.test(value);

function data(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid('Artifact metadata must be plain data.');
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  if (keys.length !== fields.length || fields.some(key => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value')) ||
      keys.some(key => typeof key !== 'string' || !fields.includes(key))) invalid('Artifact metadata must contain exactly its supported data fields.');
}

function identity(value) {
  data(value, ['device', 'inode']);
  if (typeof value.device !== 'string' || !ID.test(value.device) || typeof value.inode !== 'string' || !ID.test(value.inode)) invalid('Artifact files require exact filesystem identities.');
  return Object.freeze({ device: value.device, inode: value.inode });
}

export function validateDraftArtifactPointer(input) {
  data(input, ['schema', 'runId', 'relative', 'directory', 'journal', 'manifestHash']);
  if (input.schema !== 1 || !uuid(input.runId) || !hash(input.manifestHash) || typeof input.relative !== 'string' || input.relative.length > 4096 ||
      /[\\\u0000-\u001f\u007f]/.test(input.relative) || input.relative.split('/').some(part => !part || part === '.' || part === '..' || /[:*?"<>|]|[. ]$/.test(part) || RESERVED.test(part)) ||
      input.relative.split('/').at(-1) !== input.runId) invalid('Artifacts require the current run\'s exact reserved directory.');
  const directory = identity(input.directory), journal = identity(input.journal);
  if (directory.device !== journal.device || directory.inode === journal.inode) invalid('Artifact directory and journal identities disagree.');
  return Object.freeze({ schema: 1, runId: input.runId, relative: input.relative, directory, journal, manifestHash: input.manifestHash });
}

/** Immutable completed-model manifest. Payload bytes and model input are absent. */
export function validateDraftArtifactManifest(input, { platform = process.platform } = {}) {
  data(input, ['runId', 'outcome', 'drafts']);
  if (!uuid(input.runId) || !['drafted', 'nothing-useful'].includes(input.outcome) || !Array.isArray(input.drafts) || input.drafts.length > DRAFT_ARTIFACT_LIMITS.drafts) invalid('Invalid bounded draft manifest.');
  const descriptors = Object.getOwnPropertyDescriptors(input.drafts);
  if (Reflect.ownKeys(descriptors).length !== input.drafts.length + 1 || (input.outcome === 'drafted') !== (input.drafts.length > 0)) invalid('The completed draft outcome must match its exact set.');
  const paths = platform === 'win32' ? path.win32 : path.posix, ids = new Set(), targets = new Set(), drafts = [];
  for (let index = 0; index < input.drafts.length; index++) {
    if (!descriptors[index]?.enumerable || !Object.hasOwn(descriptors[index], 'value')) invalid('Drafts must be a dense data array.');
    const value = descriptors[index].value;
    data(value, ['id', 'target', 'expectedHash', 'hash', 'summary', 'heading', 'byteLength', 'binding']);
    if (!uuid(value.id) || value.id === input.runId || typeof value.target !== 'string' || value.target.length > 4096 || !paths.isAbsolute(value.target) || paths.normalize(value.target) !== value.target ||
        /[\u0000-\u001f\u007f]/.test(value.target) || !isMarkdownPath(value.target, paths) || (value.expectedHash !== null && !hash(value.expectedHash)) || !hash(value.hash) ||
        !Number.isSafeInteger(value.byteLength) || value.byteLength < 1 || value.byteLength > DRAFT_ARTIFACT_LIMITS.fileBytes) invalid('Invalid exact draft descriptor.');
    const parts = platform === 'win32' ? value.target.slice(3).split('\\') : value.target.slice(1).split('/');
    if ((platform === 'win32' && !/^[A-Za-z]:\\/.test(value.target)) || parts.some(part => !part || part === '.' || part === '..' ||
        (platform === 'win32' && (/[:*?"<>|]|[. ]$/.test(part) || RESERVED.test(part))))) invalid('Draft targets must use canonical local paths.');
    for (const [field, max] of [['summary', 1024], ['heading', 512]]) {
      if (value[field] !== null && (typeof value[field] !== 'string' || !value[field].trim() || value[field].length > max || /[\u0000-\u001f\u007f]/.test(value[field]))) invalid('Draft descriptions must be bounded single-line data.');
    }
    data(value.binding, ['root', 'parent']);
    const binding = validateNoteBinding(value.binding, value.target, { kind: 'directory', path: value.binding.root }, { platform });
    const target = value.target.normalize('NFC').toLowerCase();
    if (ids.has(value.id) || targets.has(target)) invalid('Draft IDs and portable target names must be unique.');
    ids.add(value.id); targets.add(target);
    drafts.push(Object.freeze({ id: value.id, target: value.target, expectedHash: value.expectedHash, hash: value.hash, summary: value.summary,
      heading: value.heading, byteLength: value.byteLength, binding }));
  }
  const result = Object.freeze({ runId: input.runId, outcome: input.outcome, drafts: Object.freeze(drafts) });
  if (Buffer.byteLength(JSON.stringify(result)) > DRAFT_ARTIFACT_LIMITS.manifestBytes) invalid('Draft manifest metadata exceeds its supported profile.');
  return result;
}
