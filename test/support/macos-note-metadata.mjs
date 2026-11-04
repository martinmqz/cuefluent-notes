import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function readMacosAttribute(file, name) {
  const names = (await execute('/usr/bin/xattr', [file])).stdout.split('\n');
  return names.includes(name)
    ? (await execute('/usr/bin/xattr', ['-px', '--', name, file])).stdout.replace(/\s/g, '').toLowerCase()
    : null;
}

export async function readMacosAcl(file) {
  return (await execute('/bin/ls', ['-lde', file])).stdout.split('\n').slice(1).join('\n');
}
