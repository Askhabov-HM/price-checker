import {collectOnce} from './desktop-api.js';

try {
  const result = await collectOnce();
  console.log(JSON.stringify({status:'staged',count:result.count,received_at:result.received_at,run_id:result.run_id}));
} catch (error) {
  console.error(JSON.stringify({status:'error',reason:error.code || error.message}));
  process.exitCode = 1;
}
