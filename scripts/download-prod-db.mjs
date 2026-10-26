import {randomUUID} from 'node:crypto';
import {chmodSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {describeDatabase, downloadSnapshot} from '../.agents/skills/price-checker-sync-prod-db/scripts/sync-prod-db.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sources = Object.freeze({
  randewoo: 'prices.sqlite3',
  ozon: 'ozon/prices.sqlite3',
  lamoda: 'lamoda/prices.sqlite3',
});
const host = 'root@153.76.171.172';

export async function downloadProdDatabase(store, {projectRoot = root, fetchSnapshot = downloadSnapshot} = {}) {
  if (!Object.hasOwn(sources, store)) throw new Error('Choose randewoo, ozon, or lamoda');
  const directory = join(resolve(projectRoot), '.data', 'prod-snapshots', store);
  mkdirSync(directory, {recursive: true, mode: 0o700});
  const stamp = new Date().toISOString().replace(/[-:.]/g, '') + '-' + randomUUID().slice(0, 8);
  const snapshot = join(directory, `prod-${store}-${stamp}.sqlite3`);
  const partial = snapshot + '.partial';
  try {
    await fetchSnapshot(partial, {store});
    const data = describeDatabase(partial, store);
    chmodSync(partial, 0o600);
    const bytes = statSync(partial).size;
    renameSync(partial, snapshot);
    const result = {store, source: `${host}:/var/lib/price-checker/data/${sources[store]}`,
      snapshot, bytes, copied_at: new Date().toISOString(), ...data};
    writeFileSync(snapshot + '.json', JSON.stringify(result, null, 2) + '\n', {mode: 0o600});
    return result;
  } catch (error) {
    rmSync(snapshot, {force: true});
    rmSync(snapshot + '.json', {force: true});
    throw error;
  } finally {
    rmSync(partial, {force: true});
    rmSync(partial + '-wal', {force: true});
    rmSync(partial + '-shm', {force: true});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/download-prod-db.mjs randewoo|ozon|lamoda');
    console.log(JSON.stringify(await downloadProdDatabase(process.argv[2]), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
