import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const SERVER = 'antigravity-gemini-web';
export async function configureGeminiWebMcp(home: string, enabled: boolean, command = process.execPath, build = __dirname) {
  const directory = path.join(home, '.gemini', 'config');
  const filename = path.join(directory, 'mcp_config.json');
  const runtime = path.join(home, '.gemini', 'antigravity', 'mcp', 'gemini-web');
  const entry = path.join(runtime, 'geminiWebMcp.js');
  let raw = '', config: any = { mcpServers: {} };
  try { raw = await fs.readFile(filename, 'utf8'); config = JSON.parse(raw); } catch (e: any) { if (e.code !== 'ENOENT') throw new Error('MCP config could not be parsed; it was left unchanged.'); }
  if (!config || typeof config !== 'object' || Array.isArray(config) || (config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)))) throw new Error('Invalid MCP config; it was left unchanged.');
  config.mcpServers ||= {};
  const existing = config.mcpServers[SERVER];
  if (existing && (!Array.isArray(existing.args) || existing.args[0] !== entry)) throw new Error('A different MCP server uses this name. Configuration left unchanged.');
  if (enabled) {
    const files = await Promise.all(['geminiWeb.js', 'geminiWebMcp.js'].map(async name => ({ name, contents: await fs.readFile(path.join(build, name)) })));
    await fs.mkdir(runtime, { recursive: true });
    for (const file of files) await fs.writeFile(path.join(runtime, file.name), file.contents);
    config.mcpServers[SERVER] = { command, args: [entry], env: { ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1' }, timeoutSeconds: 180 };
  } else { delete config.mcpServers[SERVER]; }
  await fs.mkdir(directory, { recursive: true });
  if (raw) await fs.writeFile(filename + '.gemini-web-backup', raw, { mode: 0o600 });
  const temporary = filename + `.gemini-web-${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temporary, filename);
  return { success: true, enabled, configPath: filename };
}
