import { createHash } from 'node:crypto';
import { fail } from '../core/errors.mjs';
import { createGeneratedNote, decodeNote, inspectMetadata, isLogEntryMarker, isNoteTimestamp, validateNote } from '../notes/index.mjs';
import { inlineText, parseMarkdown } from '../notes/markdown.mjs';

const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const project = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const markerPattern = /<!-- note-log-entry event=([a-f0-9-]+) project=([A-Za-z0-9_-]+) -->$/;
const punctuation = /[!-/:-@\[-`{-~]/g;
const queryLimit = 100, queryBytes = 64 * 1024;
const requireLog = (condition, code = 'LOG_INVALID') => { if (!condition) fail(code, 'Activity log could not be used; preserve the existing file.'); };
const hash = source => createHash('sha256').update(source).digest('hex');
const yearValue = year => { requireLog(Number.isInteger(year) && year >= 1000 && year <= 9999, 'LOG_ARGUMENT'); return String(year); };
const safeText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && !/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(value);
const visibleText = (value, max) => typeof value === 'string' && value.length <= max && value.trim().length > 0 && !/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(value);
const escapeText = value => value.replace(punctuation, '\\$&');
const unescapeText = value => value.replace(/\\([!-/:-@\[-`{-~])/g, '$1');
const encodedSegment = value => encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);

function noteTarget(value) {
  requireLog(safeText(value, 2048) && !/[\\:]/.test(value), 'LOG_ARGUMENT');
  const parts = value.split('/');
  requireLog(parts.every(part => part && part !== '.' && part !== '..') && parts[0].toLowerCase() !== 'logs' && /\.(?:md|markdown)$/i.test(parts.at(-1)), 'LOG_ARGUMENT');
  return value;
}

function zoneValue(timezone) {
  requireLog(safeText(timezone, 128) && !/^[+-]/.test(timezone), 'LOG_ARGUMENT');
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { fail('LOG_ARGUMENT', 'Activity log timezone is invalid.'); }
  return timezone;
}

/** The saved instant is rendered in the series' zone, including its DST offset. */
function zonedTimestamp(savedAt, timezone) {
  requireLog(isNoteTimestamp(savedAt), 'LOG_ARGUMENT'); zoneValue(timezone);
  const date = new Date(savedAt), values = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
  }).formatToParts(date).map(part => [part.type, part.value]));
  const offset = values.timeZoneName === 'GMT' ? '+00:00' : values.timeZoneName.replace(/^GMT/, '');
  requireLog(/^\d{4}$/.test(values.year) && /^[+-]\d{2}:\d{2}$/.test(offset), 'LOG_ARGUMENT');
  const fraction = date.getUTCMilliseconds() ? `.${String(date.getUTCMilliseconds()).padStart(3, '0')}` : '';
  const result = `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}${fraction}${offset}`;
  requireLog(isNoteTimestamp(result), 'LOG_ARGUMENT'); return result;
}

function entryValue(entry, timezone) {
  requireLog(entry && typeof entry === 'object' && typeof entry.eventId === 'string' && uuid.test(entry.eventId) && typeof entry.projectId === 'string' && project.test(entry.projectId), 'LOG_ARGUMENT');
  requireLog(['created', 'updated'].includes(entry.action) && visibleText(entry.summary, 2048) && (entry.heading === undefined || visibleText(entry.heading, 512)), 'LOG_ARGUMENT');
  const savedAt = zonedTimestamp(entry.savedAt, timezone), target = noteTarget(entry.target);
  return Object.freeze({ eventId: entry.eventId, projectId: entry.projectId, savedAt, action: entry.action, target, ...(entry.heading === undefined ? {} : { heading: entry.heading }), summary: entry.summary });
}

function entryLine(entry) {
  const href = `../${entry.target.split('/').map(encodedSegment).join('/')}`;
  return `- ${entry.savedAt} | ${entry.action} | ${entry.projectId} | [${escapeText(entry.target)}](${href}) | ${entry.heading === undefined ? '' : escapeText(entry.heading)} | ${escapeText(entry.summary)} <!-- note-log-entry event=${entry.eventId} project=${entry.projectId} -->`;
}

function parseEntry(line, timezone) {
  const fields = line.split(' | ');
  if (fields.length !== 6 || !fields[0].startsWith('- ')) return null;
  const marker = markerPattern.exec(fields[5]);
  if (!marker || !isLogEntryMarker(marker[0])) return null;
  const link = /^\[((?:\\.|[^\\])*)\]\(([^\s]+)\)$/.exec(fields[3]);
  if (!link || !fields[5].endsWith(` ${marker[0]}`)) return null;
  try {
    // A person's visible edits need not retain the writer's optional Markdown
    // escapes. The relative current-file link, rather than its label, identifies
    // the target after a hand edit. Keep the strict safe link/entry structure.
    if (!link[2].startsWith('../') || !link[1]) return null;
    const target = decodeURIComponent(link[2].slice(3));
    if (`../${target.split('/').map(encodedSegment).join('/')}` !== link[2]) return null;
    const result = entryValue({ eventId: marker[1], projectId: fields[2], savedAt: fields[0].slice(2), action: fields[1], target, ...(fields[4] ? { heading: unescapeText(fields[4]) } : {}), summary: unescapeText(fields[5].slice(0, -marker[0].length - 1)) }, timezone);
    return marker[2] === result.projectId ? result : null;
  } catch { return null; }
}

function inspect(input, options = {}) {
  const source = decodeNote(input), year = yearValue(options.year), metadata = inspectMetadata(source);
  requireLog(metadata.status === 'supported');
  const value = metadata.value;
  requireLog(value.type === 'log' && value.log_format_version === 1 && value.series?.id && value.period?.start === `${year}-01-01` && value.period?.end === `${year}-12-31` && value.period?.timezone && value.created && value.updated && value.generation?.skill_version);
  if (options.seriesId !== undefined) requireLog(value.series.id === options.seriesId, 'LOG_SERIES_CONFLICT');
  if (options.timezone !== undefined) requireLog(value.period.timezone === options.timezone, 'LOG_SERIES_CONFLICT');
  const validation = validateNote(source, { kind: 'log' }); requireLog(validation.valid, 'LOG_NOTE_INVALID');
  const { tokens, env } = parseMarkdown(source), sourceTokens = env.sourceTokens ?? tokens;
  const lines = source.split(/\r\n|\r|\n/), offsets = [0];
  for (const match of source.matchAll(/\r\n|\r|\n/g)) offsets.push(match.index + match[0].length);
  const markerLines = new Map();
  for (let line = 0; line < lines.length; line++) {
    const marker = markerPattern.exec(lines[line]);
    if (marker) { const positions = markerLines.get(marker[0]) ?? []; positions.push(line); markerLines.set(marker[0], positions); }
  }
  const headings = [];
  for (let index = 0; index < sourceTokens.length; index++) {
    const token = sourceTokens[index];
    if (token.type === 'heading_open' && ['h1', 'h2'].includes(token.tag)) {
      requireLog(token.level === 0 && token.map);
      headings.push({ level: token.tag, title: inlineText(sourceTokens[index + 1].content), start: offsets[token.map[0]], line: token.map[0] });
    }
  }
  requireLog(headings[0]?.level === 'h1' && headings[0].title === `Note activity — ${year}` && headings.filter(heading => heading.level === 'h1').length === 1);
  const sections = headings.slice(1); requireLog(sections[0]?.title === 'About this log');
  const seen = new Set(), monthSections = [];
  for (let index = 1; index < sections.length; index++) {
    const section = sections[index], month = months.findIndex(name => section.title === `${name} ${year}`);
    requireLog(month >= 0 && !seen.has(month)); seen.add(month);
    monthSections.push({ ...section, month: month + 1, end: sections[index + 1]?.start ?? source.length });
  }
  // Only comments emitted by the Markdown parser count: code examples and
  // escaped marker-shaped text never acknowledge an event.
  const markers = [], ids = new Set(), entries = [];
  function visit(items, range) {
    for (const token of items) {
      const map = token.map ?? range;
      if (['html_inline', 'html_block'].includes(token.type)) {
        for (const match of token.content.matchAll(/<!--\s*note-log-entry\b[\s\S]*?(?:-->|$)/gi)) {
          requireLog(token.type === 'html_inline' && isLogEntryMarker(match[0]) && map);
          const identity = markerPattern.exec(match[0]); requireLog(identity && !ids.has(identity[1]), 'LOG_EVENT_CONFLICT'); ids.add(identity[1]);
          const candidates = (markerLines.get(match[0]) ?? []).filter(line => line >= map[0] && line < map[1]);
          requireLog(candidates.length === 1); const line = candidates[0];
          const section = monthSections.find(item => offsets[line] >= item.start && offsets[line] < item.end);
          requireLog(section);
          const parsed = parseEntry(lines[line], value.period.timezone);
          if (parsed) {
            requireLog(parsed.savedAt.slice(0, 4) === year && +parsed.savedAt.slice(5, 7) === section.month);
            entries.push(Object.freeze({ ...parsed, line: line + 1 }));
          }
          markers.push({ eventId: identity[1], projectId: identity[2], line: lines[line], offset: offsets[line], entry: parsed });
        }
      }
      if (token.children) visit(token.children, map);
    }
  }
  visit(sourceTokens);
  requireLog(monthSections.every(section => markers.some(marker => marker.offset >= section.start && marker.offset < section.end)));
  return { source, year: +year, noteId: value.id, seriesId: value.series.id, timezone: value.period.timezone, metadata: value, monthSections, markers, entries, sourceHash: hash(source) };
}

/** Pure creation; the caller establishes the file under the destination lock. */
export function createAnnualLog({ year, noteId, seriesId, timezone, skillVersion, createdAt } = {}) {
  const annual = yearValue(year); zoneValue(timezone);
  const body = `# Note activity — ${annual}\n\n## About this log\n\nDates are note save times, not the dates of the events described. Only projects with activity logging enabled contribute, so shared notes may have partial project coverage. Gaps are possible, including changes made before this log was created or entries that could not be written. Read the linked current notes before drawing conclusions about their contents.\n`;
  const bytes = createGeneratedNote(body, { ...(noteId === undefined ? {} : { id: noteId }), now: createdAt, skillVersion, metadata: { type: 'log', log_format_version: 1, series: { id: seriesId }, period: { start: `${annual}-01-01`, end: `${annual}-12-31`, timezone } } });
  inspect(bytes, { year, seriesId, timezone }); return bytes;
}

export function inspectAnnualLog(bytes, options) {
  const result = inspect(bytes, options);
  return Object.freeze({ year: result.year, noteId: result.noteId, seriesId: result.seriesId, timezone: result.timezone, sourceHash: result.sourceHash, entryCount: result.entries.length, unrecognizedEntries: result.markers.filter(marker => !marker.entry).length });
}

/** Empty input establishes nothing. No machine timezone or replacement series
 * is inferred from files with absent, conflicting or unsupported metadata. */
export function inspectLogSeries(files, expected = {}) {
  requireLog(Array.isArray(files) && files.length <= 256, 'LOG_ARGUMENT');
  let seriesId = expected.seriesId, timezone = expected.timezone;
  const years = [], ids = new Set();
  for (const file of files) {
    const annual = inspectAnnualLog(file.bytes, { year: file.year, ...(seriesId === undefined ? {} : { seriesId }), ...(timezone === undefined ? {} : { timezone }) });
    requireLog(annual.unrecognizedEntries === 0, 'LOG_ENTRY_INVALID');
    requireLog(!years.includes(annual.year) && !ids.has(annual.noteId), 'LOG_SERIES_CONFLICT');
    seriesId = annual.seriesId; timezone = annual.timezone; years.push(annual.year); ids.add(annual.noteId);
  }
  return files.length ? Object.freeze({ seriesId, timezone, years: Object.freeze(years.sort((a, b) => a - b)) }) : null;
}

/** Append by insertion only: existing metadata, text, comments and line endings
 * remain byte-for-byte intact. Optimistic filesystem checks belong to writer. */
export function appendLogEntry(bytes, entry, options) {
  const annual = inspect(bytes, options), value = entryValue(entry, annual.timezone), line = entryLine(value);
  requireLog(value.savedAt.slice(0, 4) === String(annual.year), 'LOG_YEAR_MISMATCH');
  const prior = annual.markers.find(marker => marker.eventId === value.eventId);
  if (prior) {
    requireLog(prior.projectId === value.projectId && prior.entry, 'LOG_EVENT_CONFLICT');
    return Object.freeze({ bytes: Buffer.from(annual.source), changed: false, eventId: value.eventId });
  }
  requireLog(annual.markers.every(marker => marker.entry), 'LOG_INVALID');
  const newline = annual.source.includes('\r\n') ? '\r\n' : annual.source.includes('\r') ? '\r' : '\n';
  const month = +value.savedAt.slice(5, 7), section = annual.monthSections.find(item => item.month === month);
  // An older missing month is inserted before the next chronological section;
  // existing sections and manual additions are never sorted or rewritten.
  const offset = section?.end ?? annual.monthSections.find(item => item.month > month)?.start ?? annual.source.length;
  const before = annual.source.slice(0, offset), after = annual.source.slice(offset);
  const spacing = before.endsWith(newline + newline) ? '' : before.endsWith(newline) ? newline : newline + newline;
  const addition = `${spacing}${section ? '' : `## ${months[month - 1]} ${annual.year}${newline}${newline}`}${line}${newline}${after ? newline : ''}`;
  const proposed = Buffer.from(before + addition + after);
  const validation = validateNote(proposed, { existing: bytes, kind: 'log' }); requireLog(validation.valid, 'LOG_NOTE_INVALID');
  // Reinspect to ensure newly introduced Markdown cannot alter the layout.
  inspect(proposed, options);
  return Object.freeze({ bytes: proposed, changed: true, eventId: value.eventId });
}

/** At most 100 entries / 64 KiB per page. A changed source invalidates a cursor.
 * Returned text and pointers are untrusted and cannot answer note-content queries. */
export function queryLogEntries(bytes, { year, seriesId, timezone, from, to, target, projectId, limit = 25, cursor } = {}) {
  requireLog(Number.isInteger(limit) && limit >= 1 && limit <= queryLimit, 'LOG_ARGUMENT');
  for (const value of [from, to]) requireLog(value === undefined || isNoteTimestamp(value), 'LOG_ARGUMENT');
  requireLog(from === undefined || to === undefined || Date.parse(from) <= Date.parse(to), 'LOG_ARGUMENT');
  if (target !== undefined) noteTarget(target);
  requireLog(projectId === undefined || (typeof projectId === 'string' && project.test(projectId)), 'LOG_ARGUMENT');
  const annual = inspect(bytes, { year, seriesId, timezone });
  const filterHash = hash(JSON.stringify([year, seriesId ?? null, timezone ?? null, from ?? null, to ?? null, target ?? null, projectId ?? null]));
  if (cursor !== undefined) requireLog(cursor && cursor.sourceHash === annual.sourceHash && cursor.filterHash === filterHash && Number.isSafeInteger(cursor.offset) && cursor.offset >= 0, 'LOG_CURSOR_CHANGED');
  const entries = annual.entries.filter(entry => (from === undefined || Date.parse(entry.savedAt) >= Date.parse(from)) && (to === undefined || Date.parse(entry.savedAt) <= Date.parse(to)) && (target === undefined || entry.target === target) && (projectId === undefined || entry.projectId === projectId))
    .sort((left, right) => Date.parse(right.savedAt) - Date.parse(left.savedAt) || left.eventId.localeCompare(right.eventId, 'en'));
  let offset = cursor?.offset ?? 0, size = 2; const page = [];
  requireLog(offset <= entries.length, 'LOG_CURSOR_CHANGED');
  while (offset < entries.length && page.length < limit) {
    const entry = entries[offset], nextSize = Buffer.byteLength(JSON.stringify(entry)) + (page.length ? 1 : 0);
    if (size + nextSize > queryBytes) break;
    page.push(entry); size += nextSize; offset++;
  }
  return Object.freeze({ entries: Object.freeze(page), sourceHash: annual.sourceHash, unrecognizedEntries: annual.markers.filter(marker => !marker.entry).length, nextCursor: offset < entries.length ? Object.freeze({ sourceHash: annual.sourceHash, filterHash, offset }) : null });
}
