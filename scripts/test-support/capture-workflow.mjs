import * as controls from '../capture-controls.mjs';
import { runCollectionWorker as worker } from '../collection-worker.mjs';

// Functional capture tests exercise real storage and privacy checks without
// depending on runner/ACL latency. Budget tests override this clock explicitly;
// production entry points keep their real monotonic clock and ten-second limit.
const now = () => 0;
const functional = operation => (capability, request, options) =>
  operation(capability, request, { now, ...options });

export const controlCapture = functional(controls.controlCapture);
export const previewExplicitCapture = functional(controls.previewExplicitCapture);
export const selectExplicitCapture = functional(controls.selectExplicitCapture);
export const runSelectedCapture = functional(controls.runSelectedCapture);
export const runCollectionWorker = options => worker({ now, ...options });
export { captureSelectionStatus } from '../capture-controls.mjs';
