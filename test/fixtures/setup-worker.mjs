import fs from 'node:fs/promises';
import path from 'node:path';
import { setupProject } from '../../src/control/setup.mjs';

const [root, serialized, stop] = process.argv.slice(2), options = JSON.parse(serialized);
if (stop === 'annual') {
  const link = fs.link;
  fs.link = async (from, to) => {
    await link(from, to);
    if (to === path.join(root, 'notes', 'logs', '2026.md')) {
      await fs.writeFile(path.join(root, 'setup-boundary'), 'Annual published before settings.');
      await new Promise(() => {});
    }
  };
} else if (stop === 'settings') {
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    if (from === path.join(options.storeRoot, 'config', 'setup.json')) {
      await fs.writeFile(path.join(root, 'setup-boundary'), 'Settings published before setup journal removal.');
      await new Promise(() => {});
    }
    return rename(from, to);
  };
}
try {
  await fs.writeFile(path.join(root, 'setup-result.json'), JSON.stringify(await setupProject(options)));
} catch (error) {
  await fs.writeFile(path.join(root, 'setup-error.json'), JSON.stringify({ code: error.code, message: error.message }));
  process.exitCode = 1;
}
if (process.connected) process.disconnect();
