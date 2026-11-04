import { createRequire } from 'node:module';
import { getSystemErrorName } from 'node:util';

const require = createRequire(import.meta.url);
let binding;

/** Cache libSystem bindings, never filesystem observations or open descriptors. */
export function macosNative() {
  if (!binding) {
    const ffi = require('node:ffi');
    const library = ffi.dlopen('/usr/lib/libSystem.B.dylib', {
      getattrlist: { arguments: ['string', 'buffer', 'buffer', 'uint64', 'uint32'], return: 'int32' },
      fgetattrlist: { arguments: ['int32', 'buffer', 'buffer', 'uint64', 'uint32'], return: 'int32' },
      mbr_uid_to_uuid: { arguments: ['uint32', 'buffer'], return: 'int32' },
      __error: { arguments: [], return: 'pointer' },
    });
    binding = { library, ...library.functions, errno: () => ffi.getInt32(library.functions.__error()) };
  }
  return binding;
}

/** Darwin sys/attr.h; a descriptor stays owned by the caller throughout. */
export function readMacosAttributes(target, attributes, output, options = 0) {
  const api = macosNative();
  const descriptor = typeof target === 'number';
  const result = descriptor
    ? api.fgetattrlist(target, attributes, output, BigInt(output.length), options)
    : api.getattrlist(target, attributes, output, BigInt(output.length), options | 1); // FSOPT_NOFOLLOW
  if (result !== 0) {
    // Read this thread's errno immediately, before another native observation.
    const errno = api.errno(), error = new Error('Native filesystem attributes could not be read.');
    error.code = errno > 0 ? getSystemErrorName(-errno) : 'EIO';
    throw error;
  }
}
