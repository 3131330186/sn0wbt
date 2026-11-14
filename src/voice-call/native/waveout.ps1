# waveOut helper entry (called from src/voice-call/bridge.js).
# ASCII only on purpose. Actions: list | play
param(
    [string]$Action = "",
    [string]$WavPath = "",
    [int]$DeviceId = -1,
    [string]$Device = ""
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

Add-Type -Path (Join-Path $PSScriptRoot 'waveout.cs') | Out-Null

if ($Action -eq 'list') {
    [Console]::Out.Write([WaveOutUtil]::ListDevices())
    exit 0
}

if ($Action -eq 'play') {
    if (-not (Test-Path -LiteralPath $WavPath)) {
        [Console]::Error.WriteLine("wav not found: $WavPath")
        exit 2
    }
    $r = [WaveOutUtil]::PlayFile($DeviceId, $WavPath)
    if ($r -ne 0) {
        [Console]::Error.WriteLine("waveout play failed: code $r")
        exit 3
    }
    exit 0
}

if ($Action -eq 'endpoints') {
    [Console]::Out.Write([WaveOutUtil]::ListRenderEndpoints())
    exit 0
}

if ($Action -eq 'loop') {
    if ([string]::IsNullOrWhiteSpace($Device)) {
        [Console]::Error.WriteLine("device name required for loopback capture")
        exit 2
    }
    # Blocks streaming s16le mono to stdout until the process is killed.
    $r = [WaveOutUtil]::LoopCapture($Device)
    if ($r -ne 0) {
        [Console]::Error.WriteLine("loopback capture failed: code $r")
        exit 3
    }
    exit 0
}

[Console]::Error.WriteLine("unknown action: $Action")
exit 1
