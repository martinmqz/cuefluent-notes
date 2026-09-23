import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// cmd escaping adapted from cross-spawn (lib/util/escape.js and lib/parse.js).
// https://github.com/moxystudio/node-cross-spawn
// Copyright (c) 2018 Made With MOXY Lda <hello@moxy.studio>
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.
const metacharacters = /([()\][%!^"`<>&|;, *?])/g;
const escapeCommand = value => value.replace(metacharacters, '^$1');
function escapeArgument(value, twice) {
  const quoted = `"${value.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, '$1$1')}"`;
  const escaped = quoted.replace(metacharacters, '^$1');
  return twice ? escaped.replace(metacharacters, '^$1') : escaped;
}
// Node passes only the first lexicographically sorted case-insensitive key on
// Windows. Match its effective environment if callers supply both Path and PATH.
const environment = (env, name) => env[Object.keys(env).sort().find(key => key.toLowerCase() === name.toLowerCase())];
const isFile = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };

function windowsExecutable(command, env, cwd) {
  const explicit = /[\\/]/.test(command);
  const bases = explicit ? [path.resolve(cwd, command)] :
    (environment(env, 'PATH') ?? '').split(path.delimiter).filter(Boolean)
      .map(directory => path.resolve(cwd, directory.replace(/^"(.*)"$/, '$1'), command));
  const extensions = path.extname(command) ? [''] : ['.exe', '.com', '.cmd', '.bat'];
  for (const base of bases) for (const extension of extensions) {
    if (isFile(base + extension)) return base + extension;
  }
  return null;
}

// Pin a bare Windows client before the installer changes child working dirs.
export function resolveCommand(command, { env = process.env, cwd = process.cwd() } = {}) {
  if (process.platform !== 'win32') return command;
  const executable = windowsExecutable(command, env, cwd);
  if (!executable) throw Object.assign(new Error(`Cannot find ${command} on PATH or at its selected path.`), { code: 'ENOENT' });
  return executable;
}

/** Source installer/test utility; no dependencies are needed before npm ci. */
export function spawnCommand(command, args, options = {}) {
  if (process.platform !== 'win32') return spawnSync(command, args, { ...options, shell: false });
  const env = options.env ?? process.env;
  const executable = windowsExecutable(command, env, options.cwd ?? process.cwd());
  if (!executable) return spawnSync(command, args, { ...options, shell: false });
  if (/\.(?:mjs|cjs|js)$/i.test(executable)) return spawnSync(process.execPath, [executable, ...args], { ...options, shell: false });
  if (/\.(?:exe|com)$/i.test(executable)) return spawnSync(executable, args, { ...options, shell: false });
  if (!/\.(?:cmd|bat)$/i.test(executable)) throw new Error('Use a native executable, Node script, or Windows command shim.');
  const twice = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(executable);
  const invocation = [escapeCommand(executable), ...args.map(arg => escapeArgument(arg, twice))].join(' ');
  return spawnSync(environment(env, 'ComSpec') ?? 'cmd.exe', ['/d', '/s', '/v:off', '/c', `"${invocation}"`],
    { ...options, shell: false, windowsVerbatimArguments: true });
}
