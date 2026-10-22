import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fail } from '../core/errors.mjs';
import { hashBytes, readSnapshot, syncDirectory } from '../storage/files.mjs';
import { pinDirectory, assertChain, assertDirectory, inspectParent, lstatOrNull } from '../storage/paths.mjs';
import { prepareNotePublication, publishNotePublication } from '../storage/note-writer.mjs';
import { NOTE_PROFILE, isNoteTimestamp } from '../notes/index.mjs';
import { createAnnualLog, inspectAnnualLog, appendLogEntry, queryLogEntries } from './index.mjs';

const requireLog = (condition, code = 'LOG_INVALID') => { if (!condition) fail(code, 'The activity log was preserved because its series or layout could not be verified.'); };
const annualName = /^[1-9][0-9]{3}\.md$/;
export const logRelative = year => { requireLog(Number.isInteger(year) && year >= 1000 && year <= 9999, 'LOG_ARGUMENT'); return `logs/${year}.md`; };

export function logYear(savedAt, timezone) {
  requireLog(isNoteTimestamp(savedAt), 'LOG_ARGUMENT');
  let year; try { year = Number(new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric' }).format(new Date(savedAt))); } catch { requireLog(false, 'LOG_ARGUMENT'); }
  logRelative(year); return year;
}

function annualId(seriesId, year) {
  const hash = createHash('sha256').update(`cuefluent-annual-log\0${seriesId}\0${year}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export async function logPin(binding) {
  requireLog(binding && typeof binding.root === 'string' && Array.isArray(binding.parent));
  await assertChain(binding.parent);
  const pin = await pinDirectory(binding.root), parent = await inspectParent(pin, 'logs/0000.md');
  requireLog(JSON.stringify(parent.chain) === JSON.stringify(binding.parent), 'LOG_PATH_CHANGED');
  return pin;
}

async function annualFiles(pin) {
  const directory = path.join(pin.root, 'logs'), stat = await lstatOrNull(directory);
  requireLog(stat?.isDirectory() && !stat.isSymbolicLink(), 'LOG_MISSING');
  const parent = await inspectParent(pin, 'logs/0000.md'), handle = await fs.opendir(directory), files = [];
  let inspected = 0, unrelated = 0;
  try {
    for (;;) {
      const item = await handle.read(); if (!item) break;
      requireLog(++inspected <= 4096, 'LOG_LAYOUT_UNRECOGNIZED');
      if (!annualName.test(item.name)) { unrelated++; continue; }
      requireLog(files.length < 256 && item.isFile() && !item.isSymbolicLink(), 'LOG_LAYOUT_UNRECOGNIZED');
      const year = Number(item.name.slice(0, 4));
      const snapshot = await readSnapshot(pin, logRelative(year), { maxBytes: NOTE_PROFILE.fileBytes });
      const annual = inspectAnnualLog(snapshot.bytes, { year });
      requireLog(annual.unrecognizedEntries === 0, 'LOG_ENTRY_INVALID');
      files.push(annual);
    }
  } finally { await handle.close(); }
  await assertChain(parent.chain); await assertDirectory(pin);
  // An established annual series can coexist with Finder/editor files and
  // another run's transient stage. An unrelated-only folder is not a series to
  // adopt or silently replace during setup.
  requireLog(files.length > 0 || unrelated === 0, 'LOG_LAYOUT_UNRECOGNIZED');
  return { files, parent: parent.chain, unrelatedEntries: unrelated };
}

function seriesOf(files) {
  if (!files.length) return null;
  const first = files[0], ids = new Set();
  for (const file of files) {
    requireLog(file.seriesId === first.seriesId && file.timezone === first.timezone && !ids.has(file.noteId), 'LOG_SERIES_CONFLICT'); ids.add(file.noteId);
  }
  return { seriesId: first.seriesId, timezone: first.timezone, years: Object.freeze(files.map(file => file.year).sort((a, b) => a - b)) };
}

/** Read only. The caller pins this result in the run before model work. */
export async function inspectActivityLogSeries(destination) {
  requireLog(destination?.kind === 'directory', 'LOG_DESTINATION');
  const pin = await pinDirectory(destination.path), { files, parent, unrelatedEntries } = await annualFiles(pin), series = seriesOf(files);
  requireLog(series, 'LOG_SERIES_MISSING');
  return Object.freeze({ binding: Object.freeze({ root: pin.root, parent, seriesId: series.seriesId, timezone: series.timezone }), years: series.years, unrelatedEntries });
}

/** Explicit opt-in only, under the caller's destination writer gate. The setup
 * operation owns and durably persists its publication intent; settings are not
 * changed here. Existing valid shared series wins over requested defaults. */
export async function establishActivityLogSeries(pin, { year, timezone, seriesId, noteId, createdAt, skillVersion, runId, publication = null, persistIntent } = {}) {
  requireLog(pin?.private === false && typeof persistIntent === 'function' && typeof skillVersion === 'string', 'LOG_ARGUMENT');
  const relative = logRelative(year); await assertDirectory(pin);
  if (!publication) {
    const logs = path.join(pin.root, 'logs'), existing = await lstatOrNull(logs);
    if (!existing) {
      try { await fs.mkdir(logs, { mode: 0o777 }); await syncDirectory(pin.root); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const state = await annualFiles(pin);
    if (state.files.length) {
      const series = seriesOf(state.files);
      return Object.freeze({ root: pin.root, parent: state.parent, seriesId: series.seriesId, timezone: series.timezone });
    }
  }
  const bytes = createAnnualLog({ year, timezone, seriesId, noteId, createdAt, skillVersion });
  let note = publication ?? await prepareNotePublication(pin, relative, bytes, { runId, draftId: noteId, expectedHash: null, hash: hashBytes(bytes) });
  requireLog(note.root === pin.root && note.relative === relative && note.runId === runId && note.draftId === noteId && note.hash === hashBytes(bytes) && note.expectedHash === null, 'LOG_SETUP_CONFLICT');
  if (!publication) await persistIntent(note);
  await publishNotePublication(pin, note, bytes, { persistIntent: async next => { await persistIntent(next); note = next; } });
  const binding = (await inspectActivityLogSeries({ kind: 'directory', path: pin.root })).binding;
  requireLog(binding.seriesId === seriesId && binding.timezone === timezone, 'LOG_SERIES_CONFLICT');
  return binding;
}

/** Reproducible candidate from exact inspected original bytes and frozen event.
 * An absent annual file gets a deterministic note ID within the pinned series. */
export function logCandidate(binding, event, original, { skillVersion } = {}) {
  requireLog(typeof skillVersion === 'string', 'LOG_ARGUMENT');
  const year = logYear(event.savedAt, binding.timezone), options = { year, seriesId: binding.seriesId, timezone: binding.timezone };
  const before = original ?? createAnnualLog({ ...options, noteId: annualId(binding.seriesId, year), createdAt: event.savedAt, skillVersion });
  const result = appendLogEntry(before, event, options);
  return Object.freeze({ ...result, year, relative: logRelative(year) });
}

/** One bounded annual file; returned summaries and pointers are untrusted. */
export async function readActivityLog(destination, { year, binding, ...query } = {}) {
  requireLog(destination?.kind === 'directory', 'LOG_DESTINATION');
  const active = binding ?? (await inspectActivityLogSeries(destination)).binding;
  requireLog(active.root === destination.path, 'LOG_PATH_CHANGED');
  const pin = await logPin(active), snapshot = await readSnapshot(pin, logRelative(year), { maxBytes: NOTE_PROFILE.fileBytes });
  const options = { year, seriesId: active.seriesId, timezone: active.timezone };
  inspectAnnualLog(snapshot.bytes, options);
  return Object.freeze({ ...queryLogEntries(snapshot.bytes, { ...query, ...options }), year, seriesId: active.seriesId, timezone: active.timezone });
}
