import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {launchLamodaChrome} from './chrome-launcher.js';

export async function runAgent({launch = launchLamodaChrome} = {}) {
  return launch();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runAgent().catch(error => {
    console.error('Lamoda Chrome launch failed: '+error.message);
    process.exitCode = 1;
  });
}
