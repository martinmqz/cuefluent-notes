export { NOTE_PROFILE, decodeNote, noteNewline } from './profile.mjs';
export { SOURCE_LOCATOR_LENGTH, createGeneratedNote, editMetadata, inspectMetadata, isLocalSourceReference, isNoteTimestamp, isSourceAppend, noteContent, noteSourceIdentity, preserveMetadata, serializeSources, validateMetadata, validateDocumentSources } from './metadata.mjs';
export { assertOrdinaryTarget, assertValidNote, hiddenComments, isLogEntryMarker, reviewNoteContent, validateNote } from './validate.mjs';
export { unreadableNoteHealth, DOCTOR_FINDINGS, inspectNoteHealth, sharedAliases, repeatedIdentities } from './doctor.mjs';
export { REPAIR_FIELDS, REPAIR_OPERATIONS, REPAIR_LIMITS, assertRepairScope, constructRepair, describeRepair, serializeRepair, summarizeRepair, validateRepairOperations } from './repair.mjs';
