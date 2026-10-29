import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

interface Candidate { file: string; size: number; mtime: number; group: string }
const previews = new Map<string, { at: number; files: Candidate[] }>();
const inside = (root: string, file: string) => { const relative = path.relative(root,file); return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative); };
export async function inspectStorage(geminiRoot: string, userData: string, now = Date.now()) {
  const groups = [
    { name: 'Conversation databases', root: path.join(geminiRoot,'conversations'), clean: false },
    { name: 'Chat files and attachments', root: path.join(geminiRoot,'brain'), clean: false },
    { name: 'Logs', root: path.join(userData,'logs'), clean: true },
    { name: 'Crash reports', root: path.join(geminiRoot,'crashes'), clean: true },
    { name: 'Web cache', root: path.join(userData,'Cache'), clean: false },
    { name: 'Code cache', root: path.join(userData,'Code Cache'), clean: false },
  ];
  let visited = 0, partial = false; const files: Candidate[] = [];
  const rows: any[] = [];
  for (const group of groups) {
    let bytes = 0, count = 0, reclaimable = 0;
    const walk = async (dir: string, depth: number) => {
      if (depth > 16 || visited >= 30000) { partial = true; return; }
      let entries;
      try { const stat = await fs.lstat(dir); if (stat.isSymbolicLink()) return; entries = await fs.readdir(dir,{ withFileTypes:true }); } catch { return; }
      for (const entry of entries) {
        if (++visited > 30000) { partial = true; return; }
        const file = path.resolve(dir,entry.name); if (!inside(group.root,file) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { await walk(file,depth+1); continue; }
        if (!entry.isFile()) continue;
        try {
          const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) continue;
          bytes += stat.size; count++;
          if (group.clean && stat.mtimeMs < now-7*86400000 && files.length < 2000) { reclaimable += stat.size; files.push({file,size:stat.size,mtime:stat.mtimeMs,group:group.name}); }
        } catch { partial = true; }
      }
    };
    await walk(path.resolve(group.root),0);
    rows.push({ name:group.name,bytes,count,reclaimable,clean:group.clean });
  }
  for (const [id, preview] of previews) if (now-preview.at > 10*60000) previews.delete(id);
  const id = randomUUID(); previews.set(id,{at:now,files});
  return { success:true, id, rows, partial, candidates:files.length, reclaimable:files.reduce((sum,item)=>sum+item.size,0),
    preview:files.slice(0,30).map(item=>({group:item.group,name:path.basename(item.file),bytes:item.size})) };
}
export async function cleanStorage(id: string, trash: (file: string)=>Promise<void>, now = Date.now()) {
  const preview = previews.get(id); previews.delete(id);
  if (!preview || now-preview.at > 10*60000) throw new Error('Preview expired. Scan storage again.');
  let removed = 0, skipped = 0, bytes = 0;
  for (const item of preview.files) {
    try {

      for (let current = path.dirname(item.file);; current=path.dirname(current)) {
        if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Linked directory');
        if (path.dirname(current) === current) break;
      }
      const stat=await fs.lstat(item.file);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size!==item.size || stat.mtimeMs!==item.mtime || stat.mtimeMs>=now-7*86400000) {skipped++;continue;}
      await trash(item.file); removed++; bytes+=item.size;
    } catch { skipped++; }
  }
  return {success:true,removed,skipped,bytes};
}
