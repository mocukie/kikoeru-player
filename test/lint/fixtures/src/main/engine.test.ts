import { createFakeWorker } from '../../test/fakes/fake-worker.js';
import { handle } from '../worker/index.js';

export const cases = [createFakeWorker, handle];
