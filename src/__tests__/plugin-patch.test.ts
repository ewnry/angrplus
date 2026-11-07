import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyPluginPatches } from '../../scripts/deploy.mjs';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
it('runs an enabled archive hook on the staging directory and propagates errors', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-plugin-patch-')); roots.push(root);
  const plugins = path.join(root,'plugins'), plugin = path.join(plugins,'test'), stage = path.join(root,'stage');
  fs.mkdirSync(plugin,{recursive:true}); fs.mkdirSync(stage);
  fs.writeFileSync(path.join(plugin,'plus-plugin.json'), JSON.stringify({id:'test',name:'Test',version:'1',enabled:true,patch:'patch.cjs'}));
  fs.writeFileSync(path.join(plugin,'patch.cjs'), "exports.patch = ({root,fs,path}) => fs.writeFileSync(path.join(root,'example.txt'),'patched');");
  await applyPluginPatches(path.resolve('dist'), stage, plugins);
  expect(fs.readFileSync(path.join(stage,'example.txt'),'utf8')).toBe('patched');
});
