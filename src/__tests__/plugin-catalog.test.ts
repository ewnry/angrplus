import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { discoverPlugins, pluginFile } from '../pluginCatalog';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-plugins-')); roots.push(root); return root; }
describe('plugin catalog', () => {
  it('discovers valid plugins with their enabled state', () => {
    const root = fixture(), dir = path.join(root, 'example'); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'main.js'), 'module.exports = () => {}');
    fs.writeFileSync(path.join(dir, 'plus-plugin.json'), JSON.stringify({id:'example',name:'Example',version:'1',enabled:true,main:'main.js'}));
    expect(discoverPlugins(root)).toMatchObject([{manifest:{id:'example',enabled:true}}]);
  });
  it('rejects plugin entry points outside the plugin directory', () => {
    const root = fixture(), dir = path.join(root, 'example'); fs.mkdirSync(dir); fs.writeFileSync(path.join(root, 'outside.js'),'');
    expect(() => pluginFile(dir, '../outside.js')).toThrow();
  });
});
