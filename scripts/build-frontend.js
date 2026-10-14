import {existsSync, readdirSync, statSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
function newest(path) {
  if (!statSync(path).isDirectory()) return statSync(path).mtimeMs;
  return Math.max(...readdirSync(path).map(name => newest(join(path, name))));
}
export async function ensureFrontend() {
  const output = join(root, 'dist/index.html');
  const inputs = ['frontend', 'vite.config.ts', 'tsconfig.json', 'package.json', 'package-lock.json'];
  if (!existsSync(output) || inputs.some(path => newest(join(root, path)) > statSync(output).mtimeMs)) {
    const {build} = await import('vite');
    await build({root: join(root, 'frontend'), configFile: join(root, 'vite.config.ts')});
  }
}
