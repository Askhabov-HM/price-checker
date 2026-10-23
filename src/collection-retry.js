import {setTimeout as delay} from 'node:timers/promises';

export const COLLECTION_ATTEMPTS = 4;
export const COLLECTION_RETRY_DELAY_MS = 5000;

// Called inside the queue lease. Only the final result is written to history.
export async function retryCollectionRead(read,{signal,pause = delay,retryable,onRetry} = {}) {
  for (let attempt = 1; attempt <= COLLECTION_ATTEMPTS; attempt++) {
    signal?.throwIfAborted();
    try {return await read();}
    catch (error) {
      // Do not hold other stores behind a source-imposed pause or owner action.
      if (signal?.aborted || attempt === COLLECTION_ATTEMPTS || error?.retry_after_ms > 0 || !retryable?.(error)) throw error;
      await onRetry?.({attempt:attempt+1,total:COLLECTION_ATTEMPTS,delay_ms:COLLECTION_RETRY_DELAY_MS});
      await pause(COLLECTION_RETRY_DELAY_MS,undefined,{signal});
    }
  }
}
