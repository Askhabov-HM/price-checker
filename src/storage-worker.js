import {parentPort,workerData} from 'node:worker_threads';
import {prepareStores} from './storage-maintenance.js';
import {storageFailure} from './storage-migrations.js';

// Keep the lock owner's heartbeat responsive during synchronous SQLite work.
try {parentPort.postMessage(prepareStores(workerData.root));}
catch (error) {parentPort.postMessage(storageFailure(error));}
