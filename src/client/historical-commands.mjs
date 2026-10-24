import path from 'node:path';
import { matchAction, codexLinkedCommand } from './commands.mjs';
import { extractNativeFields } from '../transcript/native.mjs';
import { metaValue as value, inspectNativeRow, rowTokenStream, transcriptLimits, transcriptError, verifyRow } from '../transcript/source.mjs';
import { nativeId } from '../transcript/checkpoint.mjs';

const key = at => JSON.stringify(at);
const same = (a, b) => a.length === b.length && a.every((part, index) => part === b[index]);
const begins = (a, b) => a.length >= b.length && b.every((part, index) => part === a[index]);

async function verify(source, row, limits) {
  if (typeof source.verify === 'function') await source.verify(row);
  else await verifyRow(source, row, { limits });
}

async function text(source, row, at, maxUnits, limits, prefix = false) {
  const info = row.strings[key(at)];
  if (!info || (!prefix && info.units > maxUnits)) return null;
  const fields = [{ kind: 'human', path: at, format: 'text' }];
  let output = '';
  for await (const item of extractNativeFields(source, row, fields, { limits })) {
    if (item.type !== 'text') continue;
    output += item.text;
    if (prefix && output.length >= maxUnits) return output.slice(0, maxUnits);
    if (output.length > maxUnits) return null;
  }
  return output;
}

async function codexStructure(source, row, textIndex, limits, expectedCount = 2) {
  const base = ['payload', 'item', 'content'], elements = [...base, textIndex, 'text_elements'];
  let count = 0, annotated = false;
  for await (const token of rowTokenStream(source, row, limits)) {
    if (begins(token.path, base) && token.path.length === base.length + 1 &&
        ['startObject', 'startArray', 'startString', 'startNumber', 'trueValue', 'falseValue', 'nullValue'].includes(token.name)) {
      if (token.name !== 'startObject' || ++count > expectedCount) return false;
    }
    if (same(token.path, elements) && !['key', 'startArray', 'endArray'].includes(token.name)) annotated = true;
    if (begins(token.path, elements) && token.path.length > elements.length) annotated = true;
    if (same(token.path, base) && token.name === 'endArray') return count === expectedCount && !annotated;
  }
  return false;
}

/** Construct a bounded per-human classifier from the caller-verified installed
 * skill identity. It reads no settings, credentials, transcript directories or
 * command registry. The source capability must enforce snapshot integrity.
 */
export function createHistoricalCommandClassifier({ client, name, skillPath, limits: inputLimits = {}, platform = process.platform } = {}) {
  if (!['claude', 'codex'].includes(client)) transcriptError('TRANSCRIPT_COMMAND_INVALID', 'Unsupported command client');
  nativeId(name);
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (typeof skillPath !== 'string' || skillPath.length > 32768 || /[\u0000-\u001f\u007f]/.test(skillPath) ||
      !paths.isAbsolute(skillPath) || paths.normalize(skillPath) !== skillPath || paths.basename(skillPath) !== 'SKILL.md') {
    transcriptError('TRANSCRIPT_COMMAND_INVALID', 'The verified installed skill path must be an absolute SKILL.md path');
  }
  const limits = transcriptLimits(inputLimits), expansionHeader = 'Base directory for this skill: ';
  const expansionPrefix = `${expansionHeader}${paths.dirname(skillPath)}\n\n`;
  const wrapperPrefix = `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>`;
  const wrapperSuffix = '</command-args>';
  return async (source, row, { sessionId } = {}) => {
    nativeId(sessionId);
    if (client === 'codex') {
      if (value(row, 'type') !== 'event_msg' || value(row, 'payload', 'type') !== 'item_completed' ||
          value(row, 'payload', 'thread_id') !== sessionId || value(row, 'payload', 'item', 'type') !== 'UserMessage') return null;
      const base = ['payload', 'item', 'content'];
      const types = [0, 1].map(index => value(row, ...base, index, 'type'));
      if (types[0] === 'text' && types[1] === undefined) {
        const typed = await text(source, row, [...base, 0, 'text'], 32768 + name.length * 2 + 160, limits);
        const selected = codexLinkedCommand(typed, name, { platform });
        if (selected === null || !(await codexStructure(source, row, 0, limits, 1))) return null;
        await verify(source, row, limits);
        if (selected.skillPath !== skillPath) return Object.freeze({ pending: 'CLIENT_COMMAND_IDENTITY_UNKNOWN' });
        return Object.freeze({ promptId: nativeId(value(row, 'payload', 'turn_id')), rowId: nativeId(value(row, 'payload', 'item', 'id')),
          action: selected.action, anchors: Object.freeze([Object.freeze({ start: row.start, end: row.end, hash: row.hash })]) });
      }
      if (types.filter(type => type === 'skill').length !== 1 || types.filter(type => type === 'text').length !== 1) return null;
      const skillIndex = types.indexOf('skill'), textIndex = types.indexOf('text');
      if (value(row, ...base, skillIndex, 'name') !== name || !(await codexStructure(source, row, textIndex, limits))) return null;
      const typed = await text(source, row, [...base, textIndex, 'text'], 128, limits), selected = matchAction(typed);
      if (selected === null) return null;
      await verify(source, row, limits);
      if (value(row, ...base, skillIndex, 'path') !== skillPath) return Object.freeze({ pending: 'CLIENT_COMMAND_IDENTITY_UNKNOWN' });
      return Object.freeze({ promptId: nativeId(value(row, 'payload', 'turn_id')), rowId: nativeId(value(row, 'payload', 'item', 'id')),
        action: selected, anchors: Object.freeze([Object.freeze({ start: row.start, end: row.end, hash: row.hash })]) });
    }
    if (value(row, 'type') !== 'user' || value(row, 'message', 'role') !== 'user' || value(row, 'sessionId') !== sessionId ||
        value(row, 'isMeta') === true || value(row, 'turnCompanion') === true || value(row, 'isSidechain') === true ||
        value(row, 'isCompactSummary') === true || value(row, 'isVisibleInTranscriptOnly') === true) return null;
    const wrapper = await text(source, row, ['message', 'content'], wrapperPrefix.length + 128 + wrapperSuffix.length, limits);
    if (!wrapper?.startsWith(wrapperPrefix) || !wrapper.endsWith(wrapperSuffix)) return null;
    const selected = matchAction(wrapper.slice(wrapperPrefix.length, -wrapperSuffix.length));
    if (selected === null) return null;
    if (row.end >= source.size) return Object.freeze({ pending: 'TRANSCRIPT_COMMAND_PAIR_PENDING' });
    const expanded = await inspectNativeRow(source, row.end, { limits });
    if (expanded.pending) return Object.freeze({ pending: 'TRANSCRIPT_COMMAND_PAIR_PENDING' });
    const promptId = nativeId(value(row, 'promptId')), rowId = nativeId(value(row, 'uuid'));
    if (value(expanded, 'type') !== 'user' || value(expanded, 'message', 'role') !== 'user' || value(expanded, 'sessionId') !== sessionId ||
        value(expanded, 'promptId') !== promptId || value(expanded, 'parentUuid') !== rowId || value(expanded, 'isSidechain') === true ||
        value(expanded, 'isMeta') !== true || value(expanded, 'turnCompanion') !== true || value(expanded, 'uuid') === rowId ||
        value(expanded, 'turnOrigin') !== undefined || value(expanded, 'turnPosition', 'turnIndex') !== undefined ||
        value(expanded, 'message', 'content', 0, 'type') !== 'text') return null;
    nativeId(value(expanded, 'uuid'));
    const prefix = await text(source, expanded, ['message', 'content', 0, 'text'], expansionHeader.length + 4096 + 2, limits, true);
    if (!prefix?.startsWith(expansionPrefix)) {
      const separator = prefix?.indexOf('\n\n', expansionHeader.length) ?? -1;
      if (prefix?.startsWith(expansionHeader) && separator === -1 && prefix.length === expansionHeader.length + 4096 + 2) {
        await verify(source, row, limits); await verify(source, expanded, limits);
        return Object.freeze({ pending: 'CLIENT_CONTRACT_PATH_LIMIT' });
      }
      const directory = separator > expansionHeader.length && prefix.startsWith(expansionHeader) ? prefix.slice(expansionHeader.length, separator) : null;
      if (!directory || /[\u0000-\u001f\u007f]/.test(directory) || !paths.isAbsolute(directory) || paths.normalize(directory) !== directory) return null;
      await verify(source, row, limits); await verify(source, expanded, limits);
      return Object.freeze({ pending: 'CLIENT_COMMAND_IDENTITY_UNKNOWN' });
    }
    await verify(source, row, limits); await verify(source, expanded, limits);
    return Object.freeze({ promptId, rowId, action: selected, anchors: Object.freeze([row, expanded].map(item => Object.freeze({ start: item.start, end: item.end, hash: item.hash }))) });
  };
}

/** The caller validates the bounded append-only identities from this exact chat
 * snapshot. No current executable package path substitutes for a missing entry.
 */
export function createHistoricalCommandClassifiers({ client, clientContracts, limits, platform } = {}) {
  const classifiers = clientContracts.map(identity => createHistoricalCommandClassifier({ client, ...identity, limits, platform }));
  return async (...args) => {
    let pending = null;
    for (const classify of classifiers) {
      const result = await classify(...args);
      if (result && !result.pending) return result;
      pending ??= result;
    }
    return pending;
  };
}
