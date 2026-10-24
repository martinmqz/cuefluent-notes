import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import MarkdownIt from 'markdown-it';
import { buildPackages, verifyPackage, readProductionDependencies, readTar, tarArchive, zipArchive, packagePath, defaultNpmCache, REFERENCES, INVENTORY } from '../tools/packaging.mjs';

const execute = promisify(execFile), repo = path.resolve(import.meta.dirname, '..');
// CI may set its own prepared cache without reading npm configuration/auth.
const cacheRoot = process.env.CUEFLUENT_TEST_NPM_CACHE ?? defaultNpmCache();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fixtureCLI = `import fs from 'node:fs';
import YAML from 'yaml';
import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import * as stream from 'stream-json';
import { label } from './support.mjs';
const input=process.argv[2]==='hook'?fs.readFileSync(0,'utf8'):'';
console.log(JSON.stringify({label,args:process.argv.slice(2),input,parsed:YAML.parse('synthetic: true'),markdown:new MarkdownIt().use(footnote).render('Text[^1]\\n\\n[^1]: Synthetic.'),stream:typeof stream}));
`;
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cue-packaging-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); await fs.mkdir(source); await fs.mkdir(path.join(source, 'src')); await fs.mkdir(path.join(source, 'references'));
  await fs.mkdir(path.join(source, 'tools'));
  for (const name of ['packaging.mjs', 'install.mjs']) await fs.copyFile(path.join(repo, 'tools', name), path.join(source, 'tools', name));
  await fs.cp(path.join(repo, 'packaging/plugin'), path.join(source, 'packaging/plugin'), { recursive: true });
  for (const name of ['package.json', 'package-lock.json', 'LICENSE.md']) await fs.copyFile(path.join(repo, name), path.join(source, name));
  await fs.writeFile(path.join(source, 'README.md'), '# Synthetic package\n\nDisposable fixture.\n');
  await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: cuefluent-notes\ndescription: Synthetic detached package fixture.\n---\n\nUse explicit commands.\n');
  for (const name of REFERENCES) await fs.writeFile(path.join(source, `references/${name}.md`), `# Synthetic ${name}\n\nDisposable fixture.\n`);
  await fs.writeFile(path.join(source, 'src/cli.mjs'), fixtureCLI); await fs.writeFile(path.join(source, 'src/support.mjs'), 'const keys = ["from", "to"]; export const label = "detached";\n');
  await fs.writeFile(path.join(source, 'packaging/plugin/source-files.json'), JSON.stringify(['src/cli.mjs', 'src/support.mjs']));
  // These plausible accidental inputs must not enter either distribution.
  for (const name of ['scripts/legacy.mjs', 'test/private.test.mjs', '.local/private.md', 'AGENTS.md', 'references/unshipped.md']) {
    await fs.mkdir(path.dirname(path.join(source, name)), { recursive: true }); await fs.writeFile(path.join(source, name), 'Not shipped.');
  }
  return { root, source, build: output => buildPackages({ repoRoot: source, outputRoot: path.join(root, output), cacheRoot }) };
}

test('production lock closure includes exact SRI tarball bytes, all licenses and no development dependency', async () => {
  const closure = await readProductionDependencies({ repoRoot: repo, cacheRoot });
  assert.equal(closure.dependencies.length, 11); assert.ok(closure.dependencies.some(item => item.name === 'punycode.js'));
  assert.ok(closure.dependencies.every(item => item.integrity.startsWith('sha512-')));
  assert.equal(closure.files.some(file => file.path.includes('agent-guidance-sync')), false);
  assert.equal(closure.runtime.devDependencies, undefined); assert.equal(closure.runtime.scripts, undefined);
  assert.equal(Object.keys(closure.lock.packages).length, closure.dependencies.length + 1);
  for (const dependency of closure.dependencies) {
    assert.match(closure.notices.toString(), new RegExp(dependency.name.replaceAll('.', '\\.') + ' ' + dependency.version.replaceAll('.', '\\.')));
    assert.ok(closure.files.some(file => file.path.startsWith(dependency.path + '/') && /LICENSE/i.test(file.path)));
  }
});

test('npm cache defaults match POSIX and Windows layouts without reading npm settings', () => {
  assert.equal(defaultNpmCache({ platform: 'linux', env: {}, home: '/home/synthetic' }), '/home/synthetic/.npm');
  assert.equal(defaultNpmCache({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\synthetic\\Local' }, home: 'C:\\Users\\synthetic' }), 'C:\\Users\\synthetic\\Local\\npm-cache');
  assert.equal(defaultNpmCache({ platform: 'win32', env: {}, home: 'C:\\Users\\synthetic' }), 'C:\\Users\\synthetic\\AppData\\Local\\npm-cache');
  assert.equal(defaultNpmCache({ platform: 'win32', env: { npm_config_cache: 'D:\\exact-cache', NPM_CONFIG_CACHE: 'D:\\other-cache' }, home: 'C:\\Users\\synthetic' }), 'D:\\exact-cache');
});

test('malformed public versions fail before package publication', async t => {
  const f = await fixture(t), metadata = JSON.parse(await fs.readFile(path.join(f.source, 'package.json'), 'utf8'));
  const lock = JSON.parse(await fs.readFile(path.join(f.source, 'package-lock.json'), 'utf8'));
  const versions = ['0.16.0-01', '0.16.0-.', '0.16.0-dev..1', ...['\n', '\r', '\r\n', '\u2028', '\u2029'].map(end => `0.16.0-dev.0${end}`)];
  for (const [index, version] of versions.entries()) {
    metadata.version = version; lock.version = version; lock.packages[''].version = version;
    await fs.writeFile(path.join(f.source, 'package.json'), JSON.stringify(metadata)); await fs.writeFile(path.join(f.source, 'package-lock.json'), JSON.stringify(lock));
    const output = `bad-version-${index}`;
    await assert.rejects(f.build(output), { code: 'PACKAGE_LOCK_INVALID' });
    await assert.rejects(fs.stat(path.join(f.root, output)), { code: 'ENOENT' });
  }
});

test('dependency pins and locked versions require SemVer identifiers while allowing build metadata', async t => {
  const f = await fixture(t), metadata = JSON.parse(await fs.readFile(path.join(f.source, 'package.json'), 'utf8'));
  const lock = JSON.parse(await fs.readFile(path.join(f.source, 'package-lock.json'), 'utf8')), cache = path.join(f.root, 'synthetic-cache');
  await fs.mkdir(cache);
  async function writeDependency(version) {
    const name = 'synthetic-dependency', archive = tarArchive([
      { path: 'package.json', bytes: Buffer.from(JSON.stringify({ name, version, license: 'MIT' })) },
      { path: 'LICENSE', bytes: Buffer.from('Synthetic license.\n') },
    ], { prefix: 'package' });
    const encoded = createHash('sha512').update(archive).digest('hex'), file = path.join(cache, `_cacache/content-v2/sha512/${encoded.slice(0, 2)}/${encoded.slice(2, 4)}/${encoded.slice(4)}`);
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, archive);
    metadata.dependencies = { [name]: version };
    lock.packages = { '': { ...lock.packages[''], dependencies: metadata.dependencies },
      [`node_modules/${name}`]: { version, license: 'MIT', resolved: 'https://registry.npmjs.org/synthetic-dependency/-/synthetic-dependency.tgz', integrity: `sha512-${Buffer.from(encoded, 'hex').toString('base64')}` } };
    await fs.writeFile(path.join(f.source, 'package.json'), JSON.stringify(metadata)); await fs.writeFile(path.join(f.source, 'package-lock.json'), JSON.stringify(lock));
  }
  for (const version of ['1.2.3', '1.2.3-0', '1.2.3-01a', '1.2.3-rc.1+001.build-0', '1.2.3+001']) {
    await writeDependency(version);
    const closure = await readProductionDependencies({ repoRoot: f.source, cacheRoot: cache });
    assert.equal(closure.dependencies[0].version, version);
  }
  for (const version of ['1.2.3-01', '1.2.3-.', '1.2.3-dev..1', '1.2.3+', '1.2.3+.', '1.2.3+build..1', '01.2.3', ...['\n', '\r', '\r\n', '\u2028', '\u2029'].map(end => `1.2.3-rc.1+001${end}`)]) {
    await writeDependency(version);
    await assert.rejects(readProductionDependencies({ repoRoot: f.source, cacheRoot: cache }), { code: 'PACKAGE_DEPENDENCY_UNPINNED' });
    metadata.dependencies['synthetic-dependency'] = '1.2.3'; lock.packages[''].dependencies = metadata.dependencies;
    await fs.writeFile(path.join(f.source, 'package.json'), JSON.stringify(metadata)); await fs.writeFile(path.join(f.source, 'package-lock.json'), JSON.stringify(lock));
    await assert.rejects(readProductionDependencies({ repoRoot: f.source, cacheRoot: cache }), { code: 'PACKAGE_LOCK_INVALID' });
  }
});

test('fresh builds are deterministic and detached inventories bind exact shipped source/dependency files', async t => {
  const f = await fixture(t), first = await f.build('one'), second = await f.build('two');
  assert.deepEqual(first, second);
  for (const item of first.packages) {
    const root = path.join(f.root, 'one', item.path), result = await verifyPackage(root, { expectedInventorySha256: item.inventorySha256 });
    assert.equal(result.client, item.client); assert.equal(result.integrityVerified, true); assert.equal(result.trustedInventoryVerified, true);
    const inventory = JSON.parse(await fs.readFile(path.join(root, INVENTORY), 'utf8'));
    assert.equal(inventory.files.some(file => /^(?:scripts|test|\.local|tools|packaging)\//.test(file.path) || file.path === 'AGENTS.md' || file.path.endsWith('unshipped.md')), false);
    assert.equal(inventory.files.some(file => file.path.includes('agent-guidance-sync')), false);
    assert.ok(inventory.files.some(file => file.path === 'src/cli.mjs'));
    for (const archive of item.archives) {
      const bytes = await fs.readFile(path.join(f.root, 'one', archive.path));
      assert.equal(sha(bytes), archive.sha256); assert.deepEqual(bytes, await fs.readFile(path.join(f.root, 'two', archive.path)));
    }
    const run = await execute(process.execPath, [path.join(root, 'src/cli.mjs'), '--help'], { cwd: os.tmpdir(), env: { ...process.env, NODE_PATH: '' } });
    assert.equal(JSON.parse(run.stdout).label, 'detached');
  }
  await assert.rejects(f.build('one'), { code: 'PACKAGE_OUTPUT_EXISTS' });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root, 'one/build.json'), 'utf8')), first);
});

test('README links reach the same reference bytes in source and both detached client packages', async t => {
  const f = await fixture(t), readme = await fs.readFile(path.join(repo, 'README.md'), 'utf8');
  await fs.writeFile(path.join(f.source, 'README.md'), readme);
  const links = text => new MarkdownIt().parse(text, {}).flatMap(token => token.children ?? [])
    .filter(token => token.type === 'link_open').map(token => token.attrGet('href'));
  const sourceLinks = links(readme);
  assert.ok(sourceLinks.some(href => href.startsWith('references/')));
  const built = await f.build('linked');
  for (const item of built.packages) {
    const root = path.join(f.root, 'linked', item.path), packagedReadme = await fs.readFile(path.join(root, 'README.md'), 'utf8');
    const packagedLinks = links(packagedReadme);
    assert.equal(packagedLinks.length, sourceLinks.length);
    for (const [index, href] of sourceLinks.entries()) {
      if (!href.startsWith('references/')) { assert.equal(packagedLinks[index], href); continue; }
      const sourceBytes = await fs.readFile(new URL(href, pathToFileURL(path.join(f.source, 'README.md'))));
      const packagedBytes = await fs.readFile(new URL(packagedLinks[index], pathToFileURL(path.join(root, 'README.md'))));
      assert.deepEqual(packagedBytes, sourceBytes);
    }
    await verifyPackage(root, { expectedInventorySha256: item.inventorySha256 });
  }
  assert.equal(await fs.readFile(path.join(f.source, 'README.md'), 'utf8'), readme);
});

test('standard tar and ZIP tools accept deterministic archives and extracted package executes without repository dependencies', async t => {
  const f = await fixture(t), built = await f.build('built'), item = built.packages[0];
  for (const archive of item.archives) {
    const file = path.posix.join('built', archive.path), directory = archive.path.endsWith('.zip') ? 'zip' : 'tar';
    const extraction = path.join(f.root, directory); await fs.mkdir(extraction);
    // GNU tar treats a Windows drive colon as a remote archive. Both tools get
    // portable relative paths within the same disposable fixture instead.
    if (file.endsWith('.zip')) await execute('unzip', ['-q', file, '-d', directory], { cwd: f.root });
    else await execute('tar', ['-xzf', file, '-C', directory], { cwd: f.root });
    const root = path.join(extraction, 'cuefluent-notes'); await verifyPackage(root, { expectedInventorySha256: item.inventorySha256 });
    assert.equal(JSON.parse((await execute(process.execPath, [path.join(root, 'src/cli.mjs'), '--help'], { cwd: extraction, env: { ...process.env, NODE_PATH: '' } })).stdout).label, 'detached');
  }
});

test('hook launch descriptors preserve stdin/stdout and hostile-looking plugin path characters as literal arguments', async t => {
  const f = await fixture(t), built = await f.build('built'), text = 'Synthetic stdin: "quoted" $value `literal`\n';
  for (const item of built.packages) {
    const source = path.join(f.root, 'built', item.path), root = path.join(f.root, `${item.client} space ' apostrophe $dollar \x60tick\x60`); await fs.rename(source, root);
    const hooks = JSON.parse(await fs.readFile(path.join(root, 'hooks/hooks.json'), 'utf8')).hooks;
    assert.deepEqual(Object.keys(hooks).sort(), (item.client === 'claude' ? ['SessionStart', 'Stop', 'StopFailure', 'SessionEnd', 'PostCompact', 'UserPromptExpansion'] : ['SessionStart', 'Stop', 'SessionEnd', 'Interrupt']).sort());
    if (item.client === 'codex') for (const [event, groups] of Object.entries(hooks)) for (const group of groups) for (const handler of group.hooks) {
      assert.equal(handler.timeout, ['SessionEnd', 'Interrupt'].includes(event) ? 3 : 10, `${event} must use its native timeout profile`);
    }
    const hook = hooks.SessionStart[0].hooks[0], environment = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`, PLUGIN_ROOT: root, CLAUDE_PLUGIN_ROOT: root };
    const child = item.client === 'claude' ? spawn(process.execPath, hook.args.map(arg => arg.replaceAll('${CLAUDE_PLUGIN_ROOT}', root)), { env: environment, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', process.platform === 'win32' ? ['/d', '/s', '/c', hook.command] : ['-c', hook.command], { env: environment, windowsVerbatimArguments: process.platform === 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { error += bytes; });
    const exited = new Promise(resolve => child.once('exit', code => resolve(code))); child.stdin.end(text);
    assert.equal(await exited, 0, error); const result = JSON.parse(output);
    assert.deepEqual(result.args, ['hook', item.client]); assert.equal(result.input, text);
    const mcp = JSON.parse(await fs.readFile(path.join(root, '.mcp.json'), 'utf8')).mcpServers.cuefluent_control;
    assert.equal(mcp.command, 'node'); assert.deepEqual(mcp.args.slice(1), ['mcp', item.client]);
    assert.equal(mcp.args[0].replaceAll(item.client === 'claude' ? '${CLAUDE_PLUGIN_ROOT}' : '${PLUGIN_ROOT}', root), `${root}/src/cli.mjs`);
  }
});

test('integrity verification rejects modified, unexpected and removed files and a wrong trusted inventory digest', async t => {
  const f = await fixture(t), built = await f.build('built'), item = built.packages[0], root = path.join(f.root, 'built', item.path);
  await assert.rejects(verifyPackage(root, { expectedInventorySha256: '0'.repeat(64) }), { code: 'PACKAGE_TRUSTED_DIGEST_MISMATCH' });
  const target = path.join(root, 'src/support.mjs'), original = await fs.readFile(target); await fs.writeFile(target, 'Changed.');
  await assert.rejects(verifyPackage(root), { code: 'PACKAGE_CONTENT_MISMATCH' }); await fs.writeFile(target, original);
  await fs.writeFile(path.join(root, 'unrecognized.txt'), 'Unexpected.'); await assert.rejects(verifyPackage(root), { code: 'PACKAGE_CONTENT_MISMATCH' }); await fs.unlink(path.join(root, 'unrecognized.txt'));
  await fs.unlink(target); await assert.rejects(verifyPackage(root), { code: 'PACKAGE_CONTENT_MISMATCH' });
});

test('malformed source inventories, incomplete imports and symlink sources fail before an output directory exists', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.source, 'src/cli.mjs'), "import './missing.mjs';\n");
  await assert.rejects(f.build('missing'), { code: 'PACKAGE_SOURCE_CLOSURE' }); await assert.rejects(fs.stat(path.join(f.root, 'missing')), { code: 'ENOENT' });
  await fs.writeFile(path.join(f.source, 'src/cli.mjs'), "import {\n  value\n} from './missing-multiline.mjs';\n");
  await assert.rejects(f.build('missing-multiline'), { code: 'PACKAGE_SOURCE_CLOSURE' }); await assert.rejects(fs.stat(path.join(f.root, 'missing-multiline')), { code: 'ENOENT' });
  await fs.writeFile(path.join(f.source, 'src/cli.mjs'), fixtureCLI); await fs.unlink(path.join(f.source, 'src/support.mjs'));
  if (process.platform !== 'win32') {
    await fs.symlink(path.join(f.source, 'README.md'), path.join(f.source, 'src/support.mjs'));
    await assert.rejects(f.build('link'), { code: 'PACKAGE_SOURCE_UNSAFE' });
  }
  await assert.rejects(buildPackages({ repoRoot: f.source, outputRoot: path.join(f.source, 'published'), cacheRoot }), { code: 'PACKAGE_OUTPUT_INVALID' });
});

test('fresh build output cannot enter the source through a symlink or case alias', { skip: process.platform === 'win32' ? 'POSIX symlink primitive; physical output ancestry is checked on all platforms.' : false }, async t => {
  const f = await fixture(t), alias = path.join(f.root, 'source-link'); await fs.symlink(f.source, alias, 'dir');
  await assert.rejects(buildPackages({ repoRoot: f.source, outputRoot: path.join(alias, 'new-output'), cacheRoot }), { code: 'PACKAGE_OUTPUT_INVALID' });
  await assert.rejects(fs.stat(path.join(f.source, 'new-output')), { code: 'ENOENT' });
  const caseAlias = path.join(f.root, 'SOURCE'); let same = false;
  try { const [a, b] = await Promise.all([fs.stat(f.source), fs.stat(caseAlias)]); same = a.dev === b.dev && a.ino === b.ino; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (same) {
    await assert.rejects(buildPackages({ repoRoot: f.source, outputRoot: path.join(caseAlias, 'case-output'), cacheRoot }), { code: 'PACKAGE_OUTPUT_INVALID' });
    await assert.rejects(fs.stat(path.join(f.source, 'case-output')), { code: 'ENOENT' });
  }
});

test('cached tarball corruption and unpinned root dependencies fail before package publication', async t => {
  const f = await fixture(t), lock = JSON.parse(await fs.readFile(path.join(f.source, 'package-lock.json'), 'utf8')), first = lock.packages['node_modules/argparse'];
  const encoded = Buffer.from(first.integrity.slice(7), 'base64').toString('hex'), relative = `_cacache/content-v2/sha512/${encoded.slice(0, 2)}/${encoded.slice(2, 4)}/${encoded.slice(4)}`;
  const broken = path.join(f.root, 'broken-cache'), file = path.join(broken, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'Not the locked tarball.');
  await assert.rejects(buildPackages({ repoRoot: f.source, outputRoot: path.join(f.root, 'bad-sri'), cacheRoot: broken }), { code: 'PACKAGE_DEPENDENCY_INTEGRITY' });
  await assert.rejects(fs.stat(path.join(f.root, 'bad-sri')), { code: 'ENOENT' });
  const metadata = JSON.parse(await fs.readFile(path.join(f.source, 'package.json'), 'utf8')); metadata.dependencies.yaml = '^2.9.1'; lock.packages[''].dependencies.yaml = '^2.9.1';
  await fs.writeFile(path.join(f.source, 'package.json'), JSON.stringify(metadata)); await fs.writeFile(path.join(f.source, 'package-lock.json'), JSON.stringify(lock));
  await assert.rejects(f.build('unpinned'), { code: 'PACKAGE_DEPENDENCY_UNPINNED' });
});

test('archives reject traversal, portable collisions and corrupted tar checksums', () => {
  for (const name of ['../escape', '/absolute', 'x/CON.md', 'x\\y', 'x/name.', 'x//y']) assert.throws(() => packagePath(name), { code: 'PACKAGE_PATH_INVALID' });
  const files = [{ path: 'one.txt', bytes: Buffer.from('one') }, { path: 'folder/two.txt', bytes: Buffer.from('two') }];
  assert.deepEqual(tarArchive(files), tarArchive([...files].reverse())); assert.deepEqual(zipArchive(files), zipArchive([...files].reverse()));
  const tar = gunzipSync(tarArchive(files)); assert.deepEqual(readTar(tar).map(file => file.path), ['cuefluent-notes/folder/two.txt', 'cuefluent-notes/one.txt']);
  tar[0] ^= 1; assert.throws(() => readTar(tar), { code: 'PACKAGE_ARCHIVE_INVALID' });
  assert.throws(() => tarArchive([{ path: 'Foo.txt', bytes: Buffer.alloc(0) }, { path: 'foo.txt', bytes: Buffer.alloc(0) }]), { code: 'PACKAGE_INVALID' });
});
