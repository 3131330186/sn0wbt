import fs from 'node:fs';
import path from 'node:path';

export function installBridgeFiles(vendor, target) {
  const source = path.join(vendor, 'scripts');
  const scripts = path.join(target, 'scripts');
  const config = 'bridge-config.json';
  fs.accessSync(path.join(source, 'onebot_uia_bridge.py'));
  fs.mkdirSync(scripts, { recursive: true });
  for (const file of ['LICENSE', 'README.md', 'requirements.txt']) {
    fs.copyFileSync(path.join(vendor, file), path.join(target, file));
  }
  fs.cpSync(source, scripts, {
    recursive: true,
    filter: file => path.relative(source, file).toLowerCase() !== config
  });
  try {
    fs.copyFileSync(path.join(scripts, 'bridge-config.example.json'), path.join(scripts, config), fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}
