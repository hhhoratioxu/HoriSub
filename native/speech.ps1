$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$request = [Console]::In.ReadLine() | ConvertFrom-Json
$speakers = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $installed = @($speakers.GetInstalledVoices() | Where-Object {
        $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'zh-*' -and $_.VoiceInfo.Name -match '^Microsoft '
    })
    if ($request.op -eq 'voices') {
        $choices = @($installed | ForEach-Object { @{
            id = $_.VoiceInfo.Name
            name = $_.VoiceInfo.Name
            locale = $_.VoiceInfo.Culture.Name
        } })
        $json = ConvertTo-Json -InputObject $choices -Compress
        [Console]::WriteLine($json)
        exit 0
    }
    if ($request.op -ne 'speak') { exit 2 }
    $choice = $null
    if ($request.voice) {
        $choice = $installed | Where-Object { $_.VoiceInfo.Name -eq $request.voice } | Select-Object -First 1
    } else {
        $choice = $installed | Where-Object { $_.VoiceInfo.Culture.Name -eq $request.locale } | Select-Object -First 1
        if (!$choice) { $choice = $installed | Select-Object -First 1 }
    }
    if (!$choice) { exit 3 }
    $speakers.SelectVoice($choice.VoiceInfo.Name)
    $speakers.Rate = [int][Math]::Round([Math]::Max(-5, [Math]::Min(5, ($request.rate - 1) * 10)))
    $speakers.Volume = [int][Math]::Round([Math]::Max(0, [Math]::Min(100, $request.volume * 100)))
    $speakers.Speak([string]$request.text)
    [Console]::WriteLine('ok')
} finally { $speakers.Dispose() }
