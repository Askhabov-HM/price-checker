import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openSource,setScenario,startLab,SCENARIOS} from './test-lab/fixture.js';

const repository = dirname(dirname(fileURLToPath(import.meta.url))), directory = join(repository, '.data/test-lab');
const args = process.argv.slice(2);
let run = null, scenario = null, port = 8001;
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--run') run = args[++index];
  else if (args[index] === '--scenario') scenario = args[++index];
  else if (args[index] === '--port') port = Number(args[++index]);
  else throw new Error('Unknown argument: ' + args[index]);
}
if (!run) run = existsSync(join(directory,'active.json')) ? JSON.parse(readFileSync(join(directory,'active.json'),'utf8')).run : 'manual';
if (!/^[a-zA-Z0-9_-]{1,80}$/.test(run) || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid test run or port');
if (scenario !== null && !Object.hasOwn(SCENARIOS,scenario)) throw new Error('Unknown scenario. Use: ' + Object.keys(SCENARIOS).join(', '));
const root = join(directory,'runs',run);
mkdirSync(directory,{recursive:true});
if (scenario !== null) {
  const source = openSource(root);
  try {setScenario(source,scenario);} finally {source.close();}
  console.log(`Scenario: ${scenario}. Click Check prices in the test application.`);
} else {
  const lab = await startLab({root,port});
  writeFileSync(join(directory,'active.json'),JSON.stringify({run},null,2));
  writeFileSync(join(root,'server.json'),JSON.stringify({pid:process.pid,url:lab.url,source:lab.sourceUrl,run},null,2));
  const shutdown = () => {lab.close().catch(() => {process.exitCode = 1;});};
  process.once('SIGINT',shutdown); process.once('SIGTERM',shutdown);
  console.log(`Test Price Checker: ${lab.url}\nSource database: ${join(root,'source.sqlite3')}\nHistory database: ${join(root,'history.sqlite3')}`);
  await lab.stopped;
}
