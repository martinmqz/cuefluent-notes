import path from 'node:path';
import { fail } from './errors.mjs';

const invalid = () => fail('RUN_INVALID', 'A draft requires its exact inspected root and ancestor identities.');
function data(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(key => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value'))) invalid();
}
export function validateNoteBinding(input, target, destination, { platform = process.platform } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const key = value => platform === 'win32' ? value.toLowerCase() : value;
  const root = destination.kind === 'file' ? paths.dirname(destination.path) : destination.path;
  data(input, ['root', 'parent']);
  if (typeof input.root !== 'string' || key(input.root) !== key(root) || !Array.isArray(input.parent) || !input.parent.length || input.parent.length > 128) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input.parent);
  if (Reflect.ownKeys(descriptors).length !== input.parent.length + 1) invalid();
  const parent = [];
  let sawRoot = false;
  for (let index = 0; index < input.parent.length; index++) {
    if (!Object.hasOwn(descriptors[index] ?? {}, 'value') || !descriptors[index].enumerable) invalid();
    const item = descriptors[index].value; data(item, ['path', 'device', 'inode']);
    if (typeof item.path !== 'string' || !paths.isAbsolute(item.path) || paths.normalize(item.path) !== item.path ||
        /[\u0000-\u001f\u007f]/.test(item.path) || typeof item.device !== 'string' || typeof item.inode !== 'string' || !/^[0-9]{1,30}$/.test(item.device) || !/^[0-9]{1,30}$/.test(item.inode)) invalid();
    if (index === 0 ? key(item.path) !== key(paths.parse(root).root) : key(paths.dirname(item.path)) !== key(parent[index - 1].path)) invalid();
    if (key(item.path) === key(root)) sawRoot = true;
    const relative = paths.relative(key(item.path), key(paths.dirname(target)));
    if (relative === '..' || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)) invalid();
    parent.push(Object.freeze({ path: item.path, device: item.device, inode: item.inode }));
  }
  if (!sawRoot) invalid();
  return Object.freeze({ root: input.root, parent: Object.freeze(parent) });
}
