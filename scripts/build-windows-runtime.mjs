import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');const temp=fs.mkdtempSync(path.join(root,'.build-runtime-'));
try{
 const script=path.join(temp,'bundle.sh'),payload=path.join(temp,'payload');fs.mkdirSync(payload);
 execFileSync(process.execPath,[path.join(root,'scripts/build-unix-installer.mjs'),script],{stdio:'pipe'});
 const shell=fs.readFileSync(script,'utf8');const encoded=shell.split("cat <<'AGY_BASE64_PAYLOAD'\n")[1]?.split('\nAGY_BASE64_PAYLOAD')[0];if(!encoded)throw Error('Missing runtime payload');
 const archive=path.join(temp,'payload.tar.gz');fs.writeFileSync(archive,Buffer.from(encoded,'base64'));execFileSync('tar',['-xzf',archive,'-C',payload]);
 const output=path.join(root,'installer/runtime-patch.zip');if(fs.existsSync(output))fs.unlinkSync(output);
 const quote=s=>"'"+s.replaceAll("'","''")+"'";
 execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory(${quote(payload)},${quote(output)})`],{stdio:'pipe',windowsHide:true});
 console.log('Embedded compatibility runtime:',fs.statSync(output).size,'bytes');
}finally{if(path.dirname(temp)===root&&path.basename(temp).startsWith('.build-runtime-'))fs.rmSync(temp,{recursive:true,force:true})}
