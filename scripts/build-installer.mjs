import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as asar from '@electron/asar';
import { planRuntimePatch } from './runtime-patch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const ASSETS = path.join(ROOT, 'assets');
const INSTALLER_DIR = path.join(ROOT, 'installer');
const TEMP_BUILD = path.join(ROOT, '.build-tmp');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function copyRecursive(src, dest, filter) {
  ensureDir(dest);
  for (const item of fs.readdirSync(src)) {
    const srcPath = path.join(src, item);
    const destPath = path.join(dest, item);
    if (filter && !filter(srcPath, item)) continue;
    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
      copyRecursive(srcPath, destPath, filter);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

async function build() {
  console.log('[1/5] Checking vanilla app.asar source...');
  const appData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE, 'AppData', 'Local');
  const baseArg = process.argv.indexOf('--base-resources');
  const buildResources = baseArg >= 0 ? path.resolve(process.argv[baseArg + 1]) : path.join(appData, 'Programs', 'antigravity', 'resources');
  const vanillaCandidate = path.join(buildResources, 'app.asar.vanilla_backup');
  const activeAsar = path.join(buildResources, 'app.asar');

  let baseAsar = fs.existsSync(vanillaCandidate) ? vanillaCandidate : activeAsar;
  if (!fs.existsSync(baseAsar)) {
    throw new Error('Could not find base app.asar or app.asar.vanilla_backup at ' + baseAsar);
  }
  const activeVersion = JSON.parse(asar.extractFile(activeAsar, 'package.json').toString()).version;
  const baseVersion = JSON.parse(asar.extractFile(baseAsar, 'package.json').toString()).version;
  if (activeVersion !== baseVersion) throw new Error(`Stale vanilla backup (${baseVersion}); installed Antigravity is ${activeVersion}. Refresh the clean backup before building.`);

  console.log(`Using base ASAR: ${baseAsar}`);

  if (fs.existsSync(TEMP_BUILD)) {
    fs.rmSync(TEMP_BUILD, { recursive: true, force: true });
  }
  ensureDir(TEMP_BUILD);
  ensureDir(INSTALLER_DIR);

  console.log('[2/5] Preparing and extracting base ASAR...');
  const inputDir = path.join(TEMP_BUILD, 'input');
  ensureDir(inputDir);
  const inputAsar = path.join(inputDir, 'app.asar');
  fs.copyFileSync(baseAsar, inputAsar);

  const resourcesDir = path.dirname(baseAsar);
  const resourcesUnpacked = path.join(resourcesDir, 'app.asar.unpacked');
  const inputUnpacked = path.join(inputDir, 'app.asar.unpacked');
  if (fs.existsSync(resourcesUnpacked)) {
    try {
      fs.symlinkSync(resourcesUnpacked, inputUnpacked, 'junction');
    } catch {
      copyRecursive(resourcesUnpacked, inputUnpacked);
    }
  }

  const unpackedDir = path.join(TEMP_BUILD, 'asar_content');
  asar.extractAll(inputAsar, unpackedDir);

  console.log('[3/5] Applying Antigravity+ modifications and patches...');

  const targetModelPatch = path.join(unpackedDir, 'dist', 'modelPatch');
  ensureDir(targetModelPatch);
  copyRecursive(DIST, targetModelPatch, (src, name) => {
    return !name.endsWith('.ts') && !name.endsWith('.map') && !name.includes('__tests__');
  });

  if (fs.existsSync(ASSETS)) {
    const targetAssets = path.join(unpackedDir, 'assets');
    ensureDir(targetAssets);
    copyRecursive(ASSETS, targetAssets);
  }

  const readVendorFile = (relPath) => fs.readFileSync(path.join(unpackedDir, relPath), 'utf8');
  const readBuildFile = (relPath) => fs.readFileSync(path.join(DIST, relPath), 'utf8');
  const runtimePatches = planRuntimePatch(readVendorFile, readBuildFile);

  for (const [relPath, patchedContent] of runtimePatches) {
    const fullPath = path.join(unpackedDir, relPath);
    fs.writeFileSync(fullPath, patchedContent, 'utf8');
    console.log(`  Patched: ${relPath}`);
  }

  console.log('[4/5] Packing patched app.asar & compressing with GZip...');
  const patchedAsarPath = path.join(TEMP_BUILD, 'app.asar');
  await asar.createPackage(unpackedDir, patchedAsarPath);

  if (!process.argv.includes('--package-only') && fs.existsSync(activeAsar)) {
    try {
      fs.copyFileSync(patchedAsarPath, activeAsar);
      console.log(`  Updated active ASAR directly at: ${activeAsar}`);
    } catch (e) {
      console.log(`  Could not copy to active ASAR (${e.message}), will rely on setup installer.`);
    }
  }

  const asarBuffer = fs.readFileSync(patchedAsarPath);
  const gzBuffer = zlib.gzipSync(asarBuffer, { level: 9 });
  const gzPath = path.join(INSTALLER_DIR, 'app.asar.gz');
  fs.writeFileSync(gzPath, gzBuffer);
  console.log(`  Patched ASAR size: ${(asarBuffer.length / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  GZipped size: ${(gzBuffer.length / 1024 / 1024).toFixed(2)} MB`);

  execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-windows-runtime.mjs')], { stdio: 'inherit' });
  console.log('[5/5] Compiling standalone 1-click Installer.exe with csc.exe...');
  const cscPath = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
  const sourceCs = path.join(INSTALLER_DIR, 'Installer.cs');
  const outExe = path.join(ROOT, 'AntigravityPlus_Setup.exe');

  const cscArgs = [
    '/target:exe',
    '/platform:anycpu',
    '/optimize+',
    '/r:System.dll',
    '/r:System.IO.Compression.dll',
    '/r:System.Drawing.dll',
    '/r:System.Windows.Forms.dll',
    '/r:System.Web.Extensions.dll',
    `/resource:${gzPath},AppAsarGz`,
    `/resource:${path.join(INSTALLER_DIR, "runtime-patch.zip")},RuntimePatchZip`,
    `/out:${outExe}`,
  ];

  const icoPath = path.join(ASSETS, 'icon.ico');
  if (fs.existsSync(icoPath)) {
    cscArgs.push(`/win32icon:${icoPath}`);
  }

  if (fs.existsSync(outExe)) {
    try {
      fs.unlinkSync(outExe);
    } catch {
      const oldExe = outExe + '.old_' + Date.now();
      try {
        fs.renameSync(outExe, oldExe);
      } catch {}
    }
  }

  cscArgs.push(sourceCs);

  execFileSync(cscPath, cscArgs, { stdio: 'inherit' });

  console.log(`\n======================================================`);
  console.log(`[SUCCESS] Standalone installer built successfully:`);
  console.log(`  ${outExe} (${(fs.statSync(outExe).size / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`======================================================\n`);

  try {
    fs.rmSync(TEMP_BUILD, { recursive: true, force: true });
  } catch {

  }
}

build().catch((err) => {
  console.error('[BUILD ERROR]', err);
  process.exit(1);
});
