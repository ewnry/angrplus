& {
    param([string[]]$LoaderArgs = @())
    $ErrorActionPreference = 'Stop'
    if ($env:OS -ne 'Windows_NT') { throw 'Use curl -fsSL https://ag.rak.wtf | bash on Linux/macOS.' }
    $release = '2.1.13'
    $expectedHash = 'RUNTIME_SHA256'
    $candidates = @($env:ANTIGRAVITY_RESOURCES, (Join-Path $env:LOCALAPPDATA 'Programs\antigravity\resources'), (Join-Path $env:ProgramFiles 'antigravity\resources'))
    $resources = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $_ 'app.asar')) } | Select-Object -First 1
    if (-not $resources) { throw 'Antigravity not found. Install Antigravity first, or set ANTIGRAVITY_RESOURCES to its resources folder.' }
    $resources = [IO.Path]::GetFullPath($resources).TrimEnd('\')
    $runtime = Join-Path ([IO.Path]::GetDirectoryName($resources)) 'Antigravity.exe'
    if (-not (Test-Path -LiteralPath $runtime)) { throw 'Installed Antigravity runtime not found.' }
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    $downloadDir = Join-Path $tempRoot ('AntigravityPlus-' + [Guid]::NewGuid().ToString('N'))
    $previousTls = [Net.ServicePointManager]::SecurityProtocol
    $payload = @{ Ready = $false }
    function Initialize-Payload {
        if ($payload.Ready) { return }
        Write-Host "  Downloading patch modules... " -ForegroundColor DarkGray -NoNewline
        New-Item -ItemType Directory -Path $downloadDir | Out-Null
        $archive = Join-Path $downloadDir 'runtime.zip'
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -UseBasicParsing -Uri "https://ag.rak.wtf/runtime-patch.zip?release=$release" -OutFile $archive
        if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expectedHash) { throw 'Patch checksum mismatch. No application files changed.' }
        Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $downloadDir 'payload')
        $payload.Ready = $true
        Write-Host "done" -ForegroundColor Green
    }
    function Invoke-PatchRuntime([string]$Action) {
        Initialize-Payload
        $script = Join-Path $downloadDir 'payload\scripts\deploy.mjs'
        # Windows paths cannot contain double quotes; both paths end in a filename/directory name.
        $start = New-Object Diagnostics.ProcessStartInfo
        $start.FileName = $runtime
        $start.Arguments = '--no-warnings "' + $script + '" --resources "' + $resources + '" ' + $Action
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1'
        $start.EnvironmentVariables['ELECTRON_NO_ASAR'] = '1'
        $start.EnvironmentVariables.Remove('NODE_OPTIONS')
        $start.EnvironmentVariables.Remove('NODE_PATH')
        $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
        $process = [Diagnostics.Process]::Start($start)
        $outputTask = $process.StandardOutput.ReadToEndAsync(); $errorTask = $process.StandardError.ReadToEndAsync()
        if ($Action -eq '--check' -and -not $process.WaitForExit(30000)) { $process.Kill(); throw 'Compatibility check timed out. No application files changed.' }
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) { $detail = $errorTask.Result + $outputTask.Result; if ($detail -match 'UNSUPPORTED_RUNTIME|UNSUPPORTED_LAYOUT|BINARY_NOT_SUPPORTED') { throw ('This Antigravity version is too new or incompatible. Wait for a patch update. No application files changed.' + [Environment]::NewLine + $detail) }; throw $detail }
    }

    function Draw-Loader {
        Write-Host ''
        Write-Host (@('                ####         #    ','              ########      ###   ','            ############ ######## ','           ##############   ###   ','           ##############    #    ','          ################        ','         ##################       ','         ##################       ','        ########    ########      ','        ######         #####      ','       #####            #####     ','      #####              #####    ','     #####                #####   ','   #####                    ##### ','   ###                        ### ') -join [Environment]::NewLine) -ForegroundColor Cyan
        Write-Host ''; Write-Host '  Antigravity+' -ForegroundColor White
        Write-Host '  Antigravity, but better. - by @unixmk' -ForegroundColor DarkGray
        $stream = [IO.File]::OpenRead((Join-Path $resources 'app.asar')); $reader = New-Object IO.BinaryReader($stream)
        try {
            if ($reader.ReadUInt32() -ne 4) { throw 'Invalid ASAR.' }
            $size = $reader.ReadUInt32(); $null = $reader.ReadUInt32(); $length = $reader.ReadUInt32()
            if ($length -gt 67108864 -or ($length + 8) -gt $size) { throw 'Invalid ASAR header.' }
            $text = [Text.Encoding]::UTF8.GetString($reader.ReadBytes($length)); $entry = ($text | ConvertFrom-Json).files.'package.json'
            if ([long]$entry.size -lt 1 -or [long]$entry.size -gt 1048576 -or (8L + $size + [long]$entry.offset + [long]$entry.size) -gt $stream.Length) { throw 'Invalid ASAR package entry.' }
            $stream.Position = 8L + $size + [long]$entry.offset
            $version = ([Text.Encoding]::UTF8.GetString($reader.ReadBytes([int]$entry.size)) | ConvertFrom-Json).version
        } finally { $reader.Dispose(); $stream.Dispose() }
        Write-Host ''; Write-Host ('  Status     ' + $(if ($text.Contains('"modelPatch"') -or $text.Contains('"customPreload.js"')) { 'Patched' } else { 'Original' })) -ForegroundColor DarkGray
        Write-Host ('  Version    ' + $version) -ForegroundColor DarkGray
        $backup = (Test-Path -LiteralPath (Join-Path $resources 'app.asar.vanilla_backup')) -or (Test-Path -LiteralPath (Join-Path $resources '.antigravity-model-patch\state.json'))
        Write-Host ('  Backup     ' + $(if ($backup) { 'Available' } else { 'None' })) -ForegroundColor DarkGray
        Write-Host ('  Process    ' + $(if (@(App-Processes).Count) { 'Running' } else { 'Stopped' })) -ForegroundColor DarkGray
    }
    function App-Processes { @(Get-Process -Name Antigravity -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -eq $runtime } catch { $false } }) }
    function Close-App {
        $running = @(App-Processes)
        if (-not $running.Count) { return }
        Write-Host '  Closing Antigravity... ' -ForegroundColor DarkGray -NoNewline
        foreach ($appProcess in $running) { $null = $appProcess.CloseMainWindow() }
        foreach ($appProcess in $running) { if (-not $appProcess.WaitForExit(3000) -and $appProcess.Path -eq $runtime) { $appProcess.Kill(); $null = $appProcess.WaitForExit(3000) } }
        Write-Host 'done' -ForegroundColor Green
    }
    function Run-Action([string]$Action) {
        if ($Action -eq 'status') { Draw-Loader; return }
        if ($Action -eq 'restart') { Close-App; Start-Process -FilePath $runtime -WindowStyle Hidden; return }
        Initialize-Payload
        Write-Host '  Checking compatibility... ' -ForegroundColor DarkGray -NoNewline
        Invoke-PatchRuntime '--check'; Write-Host 'done' -ForegroundColor Green
        if ($Action -eq 'check') { return }
        Close-App
        if ($Action -eq 'restore') { Write-Host '  Restoring original... ' -ForegroundColor DarkGray -NoNewline; Invoke-PatchRuntime '--restore' }
        else { Write-Host '  Applying patch... ' -ForegroundColor DarkGray -NoNewline; Invoke-PatchRuntime '' }
        Write-Host 'done' -ForegroundColor Green
        Write-Host ''; Write-Host $(if ($Action -eq 'restore') { '  Antigravity restored.' } else { '  Antigravity+ installed successfully.' }) -ForegroundColor Green
    }

    try {
        [Net.ServicePointManager]::SecurityProtocol = $previousTls -bor [Net.SecurityProtocolType]::Tls12
        $action = 'menu'
        foreach ($flag in @('check','install','restore','status','restart')) { if ($LoaderArgs -contains "--$flag") { $action = $flag; break } }
        if ($LoaderArgs -contains '-CheckOnly') { $action = 'check' }
        if ($action -ne 'menu') { Run-Action $action; return }
        do {
            Clear-Host; Draw-Loader; Write-Host ''
            @('  1  Install / update patch','  2  Restore original','  3  Restart Antigravity','  4  Telegram (@unixmk)','','  0  Exit','') | ForEach-Object { Write-Host $_ -ForegroundColor Cyan }
            $choice = Read-Host '  >'
            if ([string]::IsNullOrEmpty($choice) -or $choice -eq '0') { break }
            try {
                switch ($choice) {
                    '1' { Run-Action 'install' }
                    '2' { if ((Read-Host '  Restore original? [y/N]') -match '^(y|yes)$') { Run-Action 'restore' } }
                    '3' { Run-Action 'restart' }
                    '4' { Start-Process 'https://t.me/unixmk' }
                    default { Write-Host '  Unknown option.' -ForegroundColor DarkGray }
                }
            } catch { Write-Host $_.Exception.Message -ForegroundColor Red }
            $null = Read-Host '  Press Enter to continue'
        } while ($true)
    } finally {
        [Net.ServicePointManager]::SecurityProtocol = $previousTls
        $resolvedDownload = [IO.Path]::GetFullPath($downloadDir)
        if ($resolvedDownload.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolvedDownload).StartsWith('AntigravityPlus-')) {
            if (Test-Path -LiteralPath $resolvedDownload) { Remove-Item -LiteralPath $resolvedDownload -Recurse -Force }
        }
    }
} -LoaderArgs $args
