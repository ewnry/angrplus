import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface PluginManifest { id: string; name: string; version: string; enabled: boolean; main?: string; renderer?: string; css?: string; patch?: string; }
export interface DiscoveredPlugin { directory: string; manifest: PluginManifest; }
export function pluginDirectory(): string { return path.join(os.homedir(), '.gemini', 'antigravity', 'plugins'); }
export function pluginFile(directory: string, relative: string): string {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw new Error('Plugin path must be relative');
  const root = fs.realpathSync(directory), file = fs.realpathSync(path.resolve(root, relative));
  if (!file.startsWith(root + path.sep) || !fs.statSync(file).isFile()) throw new Error('Plugin file must be inside its directory');
  return file;
}
export function discoverPlugins(root = pluginDirectory()): DiscoveredPlugin[] {
  if (!fs.existsSync(root)) return [];
  const result: DiscoveredPlugin[] = [], ids = new Set<string>();
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'plus-plugin.json'), 'utf8')) as PluginManifest;
      if (!manifest || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(manifest.id) || typeof manifest.name !== 'string' || typeof manifest.version !== 'string' || typeof manifest.enabled !== 'boolean') throw new Error('Invalid manifest');
      if (ids.has(manifest.id)) throw new Error('Duplicate plugin id');
      for (const field of ['main','renderer','css','patch'] as const) if (manifest[field] !== undefined) pluginFile(directory, manifest[field]!);
      ids.add(manifest.id); result.push({directory, manifest});
    } catch (error) { console.error('[Antigravity+ plugins]', entry.name, error); }
  }
  return result;
}
