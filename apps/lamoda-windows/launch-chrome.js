import {launchLamodaChrome} from './chrome-launcher.js';

try {
  const {profile} = await launchLamodaChrome();
  console.log('Lamoda Chrome launch requested. Profile: '+profile);
} catch (error) {
  console.error('Lamoda Chrome launch failed: '+error.message);
  process.exitCode = 1;
}
