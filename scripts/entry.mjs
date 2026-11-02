import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

// Node resolves imported modules through links; argv retains the invoked path.
export function isMain(url,entry=process.argv[1]){
  return Boolean(entry)&&realpathSync(fileURLToPath(url))===realpathSync(entry);
}
