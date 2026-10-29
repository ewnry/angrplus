import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, execFile } from 'node:child_process';

export function quoteWindowsArgument(value: string): string {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}
export const ELEVATED_RESTART_HELPER = String.raw`param([Parameter(Mandatory=$true)][string]$RequestFile)
$ErrorActionPreference = 'Stop'
$request = Get-Content -LiteralPath $RequestFile -Raw -Encoding UTF8 | ConvertFrom-Json
function Write-Status([string]$state, [string]$message = '') {
  $value = @{ state=$state; message=$message; pid=$PID } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($request.statusFile, $value, (New-Object Text.UTF8Encoding($false)))
}
try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'The helper did not receive an elevated token.' }
  $all = @(Get-CimInstance Win32_Process)
  $ids = New-Object 'System.Collections.Generic.HashSet[int]'
  [void]$ids.Add([int]$request.parentPid)
  do {
    $changed = $false
    foreach ($entry in $all) { if ($ids.Contains([int]$entry.ParentProcessId) -and $ids.Add([int]$entry.ProcessId)) { $changed=$true } }
  } while ($changed)
  $appRoot = [IO.Path]::GetFullPath([IO.Path]::GetDirectoryName($request.exe)).TrimEnd('\') + '\'
  $owned = @($all | Where-Object { $ids.Contains([int]$_.ProcessId) -and $_.ProcessId -ne $request.parentPid -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($appRoot,[StringComparison]::OrdinalIgnoreCase) })
  Write-Status 'ready'
  $deadline = [DateTime]::UtcNow.AddSeconds(35)
  while (Get-Process -Id $request.parentPid -ErrorAction SilentlyContinue) {
    if ([DateTime]::UtcNow -ge $deadline) { throw 'The original Antigravity window did not close. Restart was cancelled.' }
    Start-Sleep -Milliseconds 200
  }
  foreach ($entry in $owned) {
    $current = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$entry.ProcessId) -ErrorAction SilentlyContinue
    if ($current -and $current.CreationDate -eq $entry.CreationDate -and $current.ExecutablePath -eq $entry.ExecutablePath) { Stop-Process -Id $current.ProcessId -Force -ErrorAction Stop }
  }
  $arguments = @{FilePath=$request.exe;WorkingDirectory=$request.cwd;PassThru=$true}
  if ($request.argumentLine) { $arguments.ArgumentList=$request.argumentLine }
  $child = Start-Process @arguments
  Start-Sleep -Milliseconds 800
  if ($child.HasExited) { throw 'The elevated Antigravity process exited before startup. See the application log.' }
  Write-Status 'started'
} catch {
  Write-Status 'failed' $_.Exception.Message
  Add-Type -AssemblyName System.Windows.Forms
  [void][System.Windows.Forms.MessageBox]::Show($_.Exception.Message,'Antigravity elevation failed')
  exit 1
}
`;
export const ELEVATION_LAUNCHER = String.raw`param([Parameter(Mandatory=$true)][string]$RequestFile)
$ErrorActionPreference='Stop'
$request=Get-Content -LiteralPath $RequestFile -Raw -Encoding UTF8 | ConvertFrom-Json
try {
  $child=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $request.helperArguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru
  if ($child.ExitCode -ne 0 -and -not (Test-Path -LiteralPath $request.statusFile)) { throw 'The elevation helper could not start.' }
} catch {
  $state=if ($_.Exception.NativeErrorCode -eq 1223) {'cancelled'} else {'failed'}
  $value=@{state=$state;message=$_.Exception.Message}|ConvertTo-Json -Compress
  [IO.File]::WriteAllText($request.statusFile,$value,(New-Object Text.UTF8Encoding($false)))
  exit 1
}
`;
interface ElevationHost {
  platform: string; exe: string; userData: string; cwd: string; args: string[]; parentPid: number;
  quit(): void;
  spawn?: typeof spawn;
  timeoutMs?: number;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
  scheduleQuit?: (quit: () => void) => void;
}
export async function requestElevatedRestart(host: ElevationHost): Promise<{success:boolean;error?:string;cancelled?:boolean}> {
  if (host.platform !== 'win32') return {success:false,error:'Desktop elevation is supported on Windows. On Linux, use sudo for individual commands instead of running the Electron app as root.'};
  const root=path.join(host.userData,'elevation');fs.mkdirSync(root,{recursive:true});
  const job=fs.mkdtempSync(path.join(root,'restart-'));
  const helper=path.join(job,'restart-elevated.ps1'),launcher=path.join(job,'request-uac.ps1'),requestFile=path.join(job,'request.json'),statusFile=path.join(job,'status.json');
  const args=[...host.args];if(!args.some(value=>value.startsWith('--user-data-dir')))args.push(`--user-data-dir=${host.userData}`);
  fs.writeFileSync(helper,ELEVATED_RESTART_HELPER);fs.writeFileSync(launcher,ELEVATION_LAUNCHER);
  fs.writeFileSync(requestFile,JSON.stringify({exe:host.exe,cwd:host.cwd,parentPid:host.parentPid,statusFile,argumentLine:args.map(quoteWindowsArgument).join(' '),helperArguments:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,'-RequestFile',requestFile].map(quoteWindowsArgument).join(' ')}));
  let launchError: Error | undefined;
  try {
    const child=(host.spawn||spawn)('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',launcher,'-RequestFile',requestFile],{detached:true,stdio:'ignore',windowsHide:true});
    child.once('error',error=>{launchError=error});child.unref();
  } catch(error){return{success:false,error:(error as Error).message}}
  const now=host.now||Date.now,wait=host.wait||((ms)=>new Promise(resolve=>setTimeout(resolve,ms))),deadline=now()+(host.timeoutMs||120000);
  while(now()<deadline){
    if(launchError)return{success:false,error:launchError.message};
    let status: {state:string;message?:string}|undefined;
    try{status=JSON.parse(fs.readFileSync(statusFile,'utf8'))}catch{}
    if(status?.state==='ready'){
      (host.scheduleQuit||((quit)=>{setTimeout(quit,300)}))(host.quit);
      return{success:true};
    }
    if(status?.state==='failed'||status?.state==='cancelled')return{success:false,cancelled:status.state==='cancelled',error:status.message||'Elevation was cancelled.'};
    await wait(200);
  }
  return{success:false,error:'UAC approval timed out. Antigravity was kept open.'};
}
let pending: Promise<{success:boolean;error?:string;cancelled?:boolean}>|undefined;
export function relaunchAsAdministrator(): Promise<{success:boolean;error?:string;cancelled?:boolean}> {
  if(pending)return pending;
  const {app}=require('electron');
  pending=requestElevatedRestart({platform:process.platform,exe:app.getPath('exe'),userData:app.getPath('userData'),cwd:process.cwd(),args:process.argv.slice(1),parentPid:process.pid,quit:()=>app.quit()}).finally(()=>{pending=undefined});
  return pending;
}

export async function checkAdministratorStatus(agentPid?: number): Promise<{success:boolean;isAdmin:boolean;agentIsAdmin:boolean|null;supported:boolean}> {
  if (process.platform !== 'win32') return {success:true,isAdmin:typeof process.getuid==='function'&&process.getuid()===0,agentIsAdmin:null,supported:false};
  const target=Number.isInteger(agentPid)&&Number(agentPid)>0 ? agentPid : 0;
  const script=String.raw`Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class AgyTokenProbe{[DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr OpenProcess(uint a,bool b,int c);[DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr h);[DllImport("advapi32.dll",SetLastError=true)]static extern bool OpenProcessToken(IntPtr p,uint a,out IntPtr t);[DllImport("advapi32.dll",SetLastError=true)]static extern bool GetTokenInformation(IntPtr t,int i,out int v,int s,out int r);public static int Elevated(int pid){IntPtr p=OpenProcess(0x1000,false,pid),t=IntPtr.Zero;if(p==IntPtr.Zero)return -1;try{if(!OpenProcessToken(p,8,out t))return -1;int v,r;return GetTokenInformation(t,20,out v,4,out r)?v:-1;}finally{if(t!=IntPtr.Zero)CloseHandle(t);CloseHandle(p);}}}'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$agent=[AgyTokenProbe]::Elevated(TARGET_PID)
@{success=$true;isAdmin=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);agentIsAdmin=$(if($agent -lt 0){$null}else{$agent -eq 1});supported=$true}|ConvertTo-Json -Compress`.replace('TARGET_PID',String(target));
  const output=await new Promise<string>((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',timeout:10000,windowsHide:true},(error,stdout)=>error?reject(error):resolve(stdout)));
  return JSON.parse(output.trim());
}

export function getAgentProcessId(): number | undefined {
  for (const [filename, cached] of Object.entries(require.cache || {})) {
    if (filename.replace(/\\/g,'/').endsWith('/dist/languageServer.js')) {
      try { return cached?.exports?.getLsProcess?.()?.pid; } catch { return undefined; }
    }
  }
  return undefined;
}
