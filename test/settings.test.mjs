import test from 'node:test';
import assert from 'node:assert/strict';
import { emptySettings, createProject, validateSettings, chooseProject, assertSettingsChange, SETTINGS_LIMITS } from '../src/core/settings.mjs';

const posix = { platform: 'posix' };
const windows = { platform: 'win32' };
const project = (changes = {}, options = posix) => createProject({ id: 'work', root: '/projects/work',
  destination: { kind: 'directory', path: '/notes' }, ...changes }, options);
const settings = (...projects) => ({ schemaVersion: 1, projects });
const throwsCode = (action, code = 'SETTINGS_INVALID') => assert.throws(action, { code });

test('fresh project defaults are independent and settings start empty', () => {
  assert.deepEqual(emptySettings(), { schemaVersion: 1, projects: [] });
  assert.deepEqual(project(), { id: 'work', root: '/projects/work', destination: { kind: 'directory', path: '/notes' },
    tracking: 'manual', saving: 'review', activityLog: { enabled: true, timezone: new Intl.DateTimeFormat().resolvedOptions().timeZone, path: '/notes/logs' }, expandedMetadata: false });
  assert.equal(project({ tracking: 'auto' }).saving, 'review');
  assert.equal(project({ saving: 'auto' }).tracking, 'manual');
  assert.equal(project({ activityLog: { enabled: true, timezone: 'America/Los_Angeles' } }).tracking, 'manual');
  const optedOut = project({ activityLog: { enabled: false } });
  assert.deepEqual(optedOut.activityLog, { enabled: false });
  assert.deepEqual(validateSettings(settings(optedOut), posix).projects[0].activityLog, { enabled: false });
});

test('settings snapshots detach from caller objects and freeze every nested object', () => {
  const input = structuredClone(settings(project()));
  const snapshot = validateSettings(input, posix);
  input.projects[0].root = '/changed'; input.projects[0].destination.path = '/changed-notes';
  input.projects[0].activityLog.enabled = false; input.projects.push(project({ id: 'other', root: '/other' }));
  assert.equal(snapshot.projects.length, 1);
  assert.equal(snapshot.projects[0].root, '/projects/work');
  assert.equal(snapshot.projects[0].destination.path, '/notes');
  assert.equal(snapshot.projects[0].activityLog.enabled, true);
  for (const value of [snapshot, snapshot.projects, snapshot.projects[0], snapshot.projects[0].destination, snapshot.projects[0].activityLog]) {
    assert(Object.isFrozen(value));
  }
  assert.throws(() => { snapshot.projects[0].saving = 'auto'; }, TypeError);
});

test('validate complete settings without silently adding creation defaults', () => {
  for (const field of ['id', 'root', 'destination', 'tracking', 'saving', 'activityLog', 'expandedMetadata']) {
    const incomplete = structuredClone(project()); delete incomplete[field];
    throwsCode(() => validateSettings(settings(incomplete), posix));
  }
  for (const schemaVersion of [undefined, null, 0, 2, '1']) {
    throwsCode(() => validateSettings({ schemaVersion, projects: [] }, posix), 'SETTINGS_SCHEMA_UNSUPPORTED');
  }
  throwsCode(() => validateSettings({ projects: [] }, posix));
  throwsCode(() => validateSettings({ schemaVersion: 1 }, posix));
});

test('unknown settings and nested fields are rejected instead of discarded', () => {
  throwsCode(() => validateSettings({ ...emptySettings(), collections: [] }, posix));
  for (const extra of [{ alias: 'old' }, { tracking: 'automatic' }, { saving: 'manual' }, { id: '../unsafe' }]) {
    throwsCode(() => project(extra));
  }
  throwsCode(() => project({ destination: { kind: 'directory', path: '/notes', writer: '/state' } }));
  throwsCode(() => project({ activityLog: { enabled: false, timezone: 'UTC' } }));
  throwsCode(() => project({ activityLog: { enabled: true, timezone: 'UTC', path: '/elsewhere' } }));
  throwsCode(() => project({ tracking: undefined }));
  throwsCode(() => validateSettings(new Date(), posix));
});

test('reject accessor fields and non-data project arrays', () => {
  let accessed = false;
  const input = { schemaVersion: 1, get projects() { accessed = true; return []; } };
  throwsCode(() => validateSettings(input, posix));
  assert.equal(accessed, false);
  const list = [project()]; list.extra = 'unsupported';
  throwsCode(() => validateSettings({ schemaVersion: 1, projects: list }, posix));
  throwsCode(() => validateSettings({ schemaVersion: 1, projects: new Array(1) }, posix));
  const hidden = { ...emptySettings() }; Object.defineProperty(hidden, 'hidden', { value: true });
  throwsCode(() => validateSettings(hidden, posix));
});

test('settings have finite project and scalar bounds', () => {
  throwsCode(() => validateSettings({ schemaVersion: 1, projects: new Array(SETTINGS_LIMITS.projects + 1) }, posix));
  throwsCode(() => project({ id: 'a'.repeat(SETTINGS_LIMITS.idLength + 1) }));
  throwsCode(() => project({ root: `/${'a'.repeat(SETTINGS_LIMITS.pathBytes)}` }));
  throwsCode(() => project({ activityLog: { enabled: true, timezone: 'a'.repeat(SETTINGS_LIMITS.timezoneLength + 1) } }));
});

test('validate IANA activity zones and prohibit logging through single-file routes', () => {
  for (const timezone of ['UTC', 'Etc/UTC', 'America/New_York', 'Europe/London']) {
    assert.equal(project({ activityLog: { enabled: true, timezone } }).activityLog.timezone, timezone);
  }
  for (const activityLog of [{ enabled: true }, { enabled: true, timezone: '+01:00' }, { enabled: true, timezone: 'Invalid/Zone' },
    { enabled: 'true', timezone: 'UTC' }, { enabled: true, timezone: ' UTC' }]) {
    throwsCode(() => project({ activityLog }));
  }
  const destination = { kind: 'file', path: '/notes/work.md' };
  assert.equal(project({ destination }).destination.kind, 'file');
  assert.deepEqual(project({ destination }).activityLog, { enabled: false });
  throwsCode(() => project({ destination, activityLog: { enabled: true, timezone: 'UTC' } }));
  for (const target of ['/notes/work.txt', '/notes/.md', '/notes/work.md/']) {
    throwsCode(() => project({ destination: { kind: 'file', path: target } }));
  }
});

test('absolute canonical paths are required without inferring filesystem safety', () => {
  for (const root of ['.', 'relative/work', '/projects/../work', '/projects/./work', '/projects//work', '/projects/work/', '/bad\0path']) {
    throwsCode(() => project({ root }));
  }
  throwsCode(() => project({ destination: { kind: 'directory', path: 'relative' } }));
  assert.equal(project({ root: '/' }).root, '/');
  assert.equal(project({ destination: { kind: 'directory', path: '/projects/work/notes' } }).destination.path, '/projects/work/notes');
});

test('duplicate IDs and project roots are rejected while overlapping destinations are allowed', () => {
  throwsCode(() => validateSettings(settings(project(), project({ root: '/other' })), posix));
  throwsCode(() => validateSettings(settings(project(), project({ id: 'second' })), posix));
  const second = project({ id: 'second', root: '/other', destination: { kind: 'directory', path: '/notes/nested' } });
  assert.equal(validateSettings(settings(project(), second), posix).projects.length, 2);
  assert.equal(validateSettings(settings(project(), project({ id: 'shared', root: '/shared' })), posix).projects.length, 2);
});

test('first ownership selects the nearest true ancestor independent of declaration order', () => {
  const outer = project({ id: 'outer', root: '/projects' }), inner = project({ id: 'inner', root: '/projects/work/nested' });
  for (const configured of [settings(inner, outer, project()), settings(outer, project(), inner)]) {
    assert.equal(chooseProject(configured, '/projects/work/nested/lib', posix).id, 'inner');
    assert.equal(chooseProject(configured, '/projects/work', posix).id, 'work');
    assert.equal(chooseProject(configured, '/projects/workshop', posix).id, 'outer');
    assert.equal(chooseProject(configured, '/unconfigured', posix), null);
  }
  assert.equal(chooseProject(settings(project({ root: '/' })), '/anywhere', posix).id, 'work');
});

test('retained owners survive nested additions and working directory moves', () => {
  const old = settings(project()), nested = project({ id: 'nested', root: '/projects/work/nested' });
  const next = assertSettingsChange(old, settings(project(), nested), { ...posix, retainedProjectIds: ['work'] });
  assert.equal(chooseProject(next, '/projects/work/nested/lib', { ...posix, existingOwnerId: 'work' }).id, 'work');
  assert.equal(chooseProject(next, '/elsewhere', { ...posix, existingOwnerId: 'work' }).id, 'work');
  throwsCode(() => chooseProject(next, '/projects/work', { ...posix, existingOwnerId: 'missing' }), 'PROJECT_OWNER_MISSING');
});

test('retained work prevents removal, ID replacement, and root reassignment including nested owners', () => {
  const nested = project({ id: 'nested', root: '/projects/work/nested' }), current = settings(project(), nested);
  for (const next of [settings(project()), settings(project(), { ...nested, id: 'new-id' }),
    settings(project(), { ...nested, root: '/elsewhere' })]) {
    throwsCode(() => assertSettingsChange(current, next, { ...posix, retainedProjectIds: new Set(['nested']) }), 'SETTINGS_RETAINED_PROJECT');
  }
  assert.equal(assertSettingsChange(current, settings(project()), posix).projects.length, 1);
  throwsCode(() => assertSettingsChange(current, current, { ...posix, retainedProjectIds: ['unknown'] }), 'PROJECT_OWNER_MISSING');
  throwsCode(() => assertSettingsChange(current, current, { ...posix, retainedProjectIds: 'nested' }));
});

test('pending runs independently prevent removal, destination and saving changes', () => {
  const current = settings(project()), options = { ...posix, pendingRuns: new Set(['work']) };
  throwsCode(() => assertSettingsChange(current, emptySettings(), options), 'SETTINGS_RETAINED_PROJECT');
  for (const changed of [project({ saving: 'auto' }), project({ destination: { kind: 'directory', path: '/new-notes' } }),
    project({ destination: { kind: 'file', path: '/notes/work.md' } })]) {
    throwsCode(() => assertSettingsChange(current, settings(changed), options), 'SETTINGS_PENDING_RUN');
  }
  assert.equal(assertSettingsChange(current, settings(project({ saving: 'auto' })), { ...posix, retainedProjectIds: ['work'] }).projects[0].saving, 'auto');
});

test('tracking and future logging can change during a pending run without modifying its original snapshot', () => {
  const current = validateSettings(settings(project({ activityLog: { enabled: false } })), posix);
  const changed = settings(project({ tracking: 'auto', activityLog: { enabled: true, timezone: 'America/New_York' } }));
  const next = assertSettingsChange(current, changed, { ...posix, pendingRuns: ['work'] });
  assert.equal(next.projects[0].tracking, 'auto');
  assert.deepEqual(next.projects[0].activityLog, { enabled: true, timezone: 'America/New_York', path: '/notes/logs' });
  assert.deepEqual(current.projects[0].activityLog, { enabled: false });
  assert.equal(current.projects[0].tracking, 'manual');
});

test('Windows drive and UNC ownership reject aliases and honor separator boundaries', () => {
  const winProject = changes => project({ root: 'C:\\Projects\\Work', destination: { kind: 'directory', path: 'D:\\Notes' }, ...changes }, windows);
  const current = settings(winProject());
  assert.equal(chooseProject(current, 'c:\\PROJECTS\\work\\src', windows).id, 'work');
  assert.equal(chooseProject(current, 'C:\\Projects\\Workshop', windows), null);
  throwsCode(() => validateSettings(settings(winProject(), winProject({ id: 'alias', root: 'c:\\projects\\work' })), windows));
  const unc = winProject({ root: '\\\\server\\share\\work' });
  assert.equal(chooseProject(settings(unc), '\\\\SERVER\\SHARE\\WORK\\child', windows).id, 'work');
  assert.equal(chooseProject(settings(unc), '\\\\server\\share\\workshop', windows), null);
  const alias = winProject({ root: 'c:\\projects\\work', destination: { kind: 'directory', path: 'd:\\NOTES' } });
  assert.equal(assertSettingsChange(current, settings(alias), { ...windows, pendingRuns: ['work'] }).projects[0].id, 'work');
});

test('Windows roots and destinations reject ambiguous or reserved spellings', () => {
  for (const root of ['C:relative', '\\rooted', 'C:/Projects/Work', 'C:\\Projects\\..\\Work', 'C:\\Work\\',
    'C:\\NUL', 'C:\\aux.md', 'C:\\COM1\\work', 'C:\\LPT².txt', 'C:\\work.', 'C:\\work ',
    'C:\\work:stream', '\\\\?\\C:\\work', '\\\\.\\pipe\\work']) {
    throwsCode(() => project({ root, destination: { kind: 'directory', path: 'D:\\Notes' } }, windows));
  }
  throwsCode(() => project({ root: 'C:\\Work', destination: { kind: 'file', path: 'D:\\Notes\\CON.md' } }, windows));
  assert.equal(project({ root: 'C:\\', destination: { kind: 'file', path: 'D:\\Notes\\Work.MD' } }, windows).root, 'C:\\');
});


test('expanded metadata defaults only at creation and loaded settings require the explicit preference', () => {
  assert.equal(project().expandedMetadata, false);
  const optedIn = project({ expandedMetadata: true });
  assert.equal(validateSettings(settings(optedIn), posix).projects[0].expandedMetadata, true);
  const omitted = { ...optedIn }; delete omitted.expandedMetadata;
  throwsCode(() => validateSettings(settings(omitted), posix));
  assert.equal(createProject(omitted, posix).expandedMetadata, false);
  assert.equal(project({ expandedMetadata: false }).expandedMetadata, false);
  for (const expandedMetadata of [null, undefined, 0, 'false']) throwsCode(() => project({ expandedMetadata }));
});
