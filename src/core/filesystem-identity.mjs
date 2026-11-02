// Durable device identity uses a macOS volume UUID when the filesystem reports
// one. Filesystems explicitly lacking UUIDs and other platforms use the native
// device number; they do not claim recovery across device renumbering.
export const LIVE_DEVICE = Symbol('live filesystem device');
export const isFilesystemDevice = value => typeof value === 'string' &&
  (/^(?:0|[1-9][0-9]{0,39})$/.test(value) || /^volume:(?!0{32}$)[a-f0-9]{32}$/.test(value));
export const isFilesystemInode = value => typeof value === 'string' && /^(?:0|[1-9][0-9]{0,39})$/.test(value);
// A live observation carries this internal symbol through object spreads. JSON
// deliberately omits it; a newly opened operation then pins its current device.
export function identityDataKeys(descriptors) {
  const live = descriptors[LIVE_DEVICE];
  const observation = Object.hasOwn(descriptors, 'device') && Object.hasOwn(descriptors, 'inode') &&
    live?.enumerable && Object.hasOwn(live, 'value') && isFilesystemInode(live.value);
  return Reflect.ownKeys(descriptors).filter(key => !(observation && key === LIVE_DEVICE));
}
