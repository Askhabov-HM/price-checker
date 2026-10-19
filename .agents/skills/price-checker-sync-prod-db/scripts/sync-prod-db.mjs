import {spawn} from 'node:child_process';
import {closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {DatabaseSync, backup} from 'node:sqlite';
import {acquireInstance, AlreadyRunning} from '../../../../src/instance.js';

const projectRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const defaultHost = 'root@153.76.171.172';
const requiredTables = ['products', 'variants', 'lists', 'memberships', 'observations', 'checks', 'settings'];

export function describeDatabase(path) {
  const database = new DatabaseSync(path, {readOnly: true});
  try {
    const integrity = database.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('SQLite integrity check failed');
    const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    if (requiredTables.some(table => !tables.has(table))) throw new Error('The database is missing Price Checker tables');
    const counts = Object.fromEntries(['products', 'variants', 'observations', 'checks'].map(table => [table, database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));
    return {...counts, last_observation: database.prepare('SELECT MAX(checked_at) AS checked_at FROM observations').get().checked_at};
  } finally {database.close();}
}

async function copyDatabase(source, destination) {
  const database = new DatabaseSync(source, {readOnly: true});
  try {await backup(database, destination);} finally {database.close();}
  chmodSync(destination, 0o600);
}

export async function downloadSnapshot(destination, {host = defaultHost, port = 22, identity} = {}) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]*@[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host)) throw new Error('Expected SSH host in user@host form');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SSH port');
  const args = ['-T', '-p', String(port), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4'];
  if (identity) args.push('-i', resolve(identity), '-o', 'IdentitiesOnly=yes');
  args.push(host, 'python3 -');
  const output = openSync(destination, 'wx', 0o600);
  try {
    // Keep the event loop free so the local application's lock heartbeat runs
    // throughout a slow SSH download; its stale interval is only ten seconds.
    const child = spawn('ssh', args, {stdio: ['pipe', output, 'pipe'], timeout: 180000, windowsHide: true});
    let stderr = '', processError;
    child.on('error', error => {processError = error;});
    child.stderr?.on('data', chunk => {if (stderr.length < 1024 * 1024) stderr += chunk.toString();});
    child.stdin?.on('error', () => {});
    const completed = new Promise((resolve, reject) => child.on('close', (status, signal) => {
      if (processError) reject(processError);
      else if (status !== 0) reject(new Error(`SSH snapshot failed: ${stderr.trim() || signal || status}`));
      else resolve();
    }));
    child.stdin?.end(readFileSync(new URL('./snapshot.py', import.meta.url)));
    await completed;
  } finally {closeSync(output);}
}

export async function syncDatabase({root = projectRoot, snapshotOnly = false, host = defaultHost, port = 22, identity, fetchSnapshot = downloadSnapshot} = {}) {
  const directory = join(root, '.data');
  mkdirSync(directory, {recursive: true});
  let release;
  if (!snapshotOnly) {
    try {release = await acquireInstance(join(directory, 'app.lock'));}
    catch (error) {
      if (error instanceof AlreadyRunning) throw new Error('Local Price Checker is running. Stop the local application before syncing its database.');
      throw error;
    }
  }
  const stamp = new Date().toISOString().replace(/[-:.]/g, '') + '-' + randomUUID().slice(0, 8);
  const snapshots = join(directory, 'prod-snapshots');
  const snapshot = join(snapshots, `prod-${stamp}.sqlite3`), partial = snapshot + '.partial';
  let localBackup = null;
  try {
    mkdirSync(snapshots, {recursive: true});
    await fetchSnapshot(partial, {host, port, identity});
    const data = describeDatabase(partial);
    renameSync(partial, snapshot);
    const local = join(directory, 'prices.sqlite3');
    if (!snapshotOnly) {
      if (existsSync(local)) {
        const backups = join(directory, 'local-backups');
        mkdirSync(backups, {recursive: true});
        localBackup = join(backups, `before-prod-sync-${stamp}.sqlite3`);
        await copyDatabase(local, localBackup);
        describeDatabase(localBackup);
      }
      // SQLite replaces the destination in a transaction and handles its WAL.
      // Do not unlink WAL/SHM files or overwrite a live database with a raw copy.
      await copyDatabase(snapshot, local);
      describeDatabase(local);
    }
    const result = {mode: snapshotOnly ? 'snapshot-only' : 'synced',
      source: `${host}:/var/lib/price-checker/data/prices.sqlite3`, copied_at: new Date().toISOString(),
      local_database: snapshotOnly ? null : local, snapshot, local_backup: localBackup, ...data};
    writeFileSync(snapshot + '.json', JSON.stringify(result, null, 2) + '\n', {mode: 0o600});
    return result;
  } catch (error) {
    if (localBackup) error.message += ` Local backup: ${localBackup}`;
    throw error;
  } finally {
    rmSync(partial, {force: true});
    await release?.();
  }
}

function parseArgs(values) {
  const options = {};
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value === '--snapshot-only') options.snapshotOnly = true;
    else if (value === '--host' || value === '--identity' || value === '--port') {
      const next = values[++index];
      if (!next || next.startsWith('--')) throw new Error(`Missing value for ${value}`);
      options[value.slice(2)] = value === '--port' ? Number(next) : next;
    } else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {console.log(JSON.stringify(await syncDatabase(parseArgs(process.argv.slice(2))), null, 2));}
  catch (error) {console.error(error.message); process.exitCode = 1;}
}
