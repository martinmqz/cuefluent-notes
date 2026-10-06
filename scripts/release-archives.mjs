import fs from 'node:fs/promises';
import path from 'node:path';
import { zipSync, gzipSync } from 'fflate';
import tar from 'tar-stream';
import { compare } from './file-io.mjs';

/** Read a built tree once, retaining only portable paths and file bytes. */
export async function archiveFiles(root, { exclude = [] } = {}) {
  root = path.resolve(root);
  if (!(await fs.lstat(root)).isDirectory()) throw new Error('Nonportable archive root.');
  const files = [];
  async function visit(relative) {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (exclude.includes(name)) continue;
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) files.push({ name, bytes: await fs.readFile(path.join(root, name)) });
      else throw new Error(`Nonportable archive input: ${name}`);
    }
  }
  await visit('');
  return files.sort((a, b) => compare(a.name, b.name));
}

export function pluginZip(files) {
  const entries = Object.create(null);
  for (const { name, bytes } of files) entries[`cuefluent-notes/${name}`] = bytes;
  // ZIP stores local calendar fields, without a timezone. Use the same fields
  // everywhere; a UTC Date would encode differently on different hosts.
  return zipSync(entries, { level: 9, mtime: new Date(1980, 0, 1), os: 3, attrs: 0o100644 << 16 });
}

export async function marketplaceTar(files) {
  const pack = tar.pack();
  const chunks = [];
  const finished = new Promise((resolve, reject) => {
    pack.on('data', chunk => chunks.push(chunk));
    pack.on('end', resolve);
    pack.on('error', reject);
  });
  // Handle a stream failure immediately, even while an entry is being written.
  finished.catch(() => {});
  try {
    for (const { name, bytes } of files) {
      await new Promise((resolve, reject) => {
        pack.entry({ name, size: bytes.length, type: 'file', mode: 0o644,
          uid: 0, gid: 0, uname: '', gname: '', mtime: new Date('1980-01-01T00:00:00Z'),
        }, bytes, error => error ? reject(error) : resolve());
      });
    }
    pack.finalize();
    await finished;
    return gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
  } catch (error) {
    pack.destroy();
    throw error;
  }
}
