import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import lockfile from 'proper-lockfile';

export class AlreadyRunning extends Error {}

export async function acquireInstance(path) {
  mkdirSync(dirname(path), {recursive: true});
  // Lock heartbeats update the lock directory, not the target. Opening an
  // existing root-created target for writing would block the service user.
  try {writeFileSync(path, '', {flag: 'wx'});} catch (error) {if (error.code !== 'EEXIST') throw error;}
  try {
    return await lockfile.lock(path, {stale: 10000, update: 2000, retries: 0});
  } catch (error) {
    if (error.code === 'ELOCKED') throw new AlreadyRunning();
    throw error;
  }
}
