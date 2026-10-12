<#
.SYNOPSIS
  Извлекает клиентские бандлы DSH из app.asar для повторного извлечения строк.

.DESCRIPTION
  app.asar — файл-архив. Его начало:
    [u32 = 4][u32 = длина JSON + 4][u32 = длина JSON][JSON-оглавление][данные]
  Смещения файлов в оглавлении отсчитываются от конца оглавления. Скрипт читает
  оглавление, находит все <пакет>/lib/client.js у пакетов @deepseek-ai и
  распаковывает их в -Dest, сохраняя структуру каталогов.

  Результат подаётся в tools/extract-english.mjs.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\extract-bundles.ps1 -Dest "$env:TEMP\dsh-bundles"
  node tools\extract-english.mjs "$env:TEMP\dsh-bundles" --write
#>
param(
  [string]$Asar = (Join-Path $env:LOCALAPPDATA "Programs\DeepSeek Harness\resources\app.asar"),
  [Parameter(Mandatory = $true)][string]$Dest,
  [string]$Filter = '^/dsh/node_modules/@deepseek-ai/[^/]+/lib/client\.js$'
)

if (-not (Test-Path $Asar)) { Write-Error "не найден архив: $Asar"; exit 1 }

# --- оглавление -------------------------------------------------------------
$fs = [System.IO.File]::OpenRead($Asar)
try {
  $head = New-Object byte[] 16
  $null = $fs.Read($head, 0, 16)
  $jsonLen = [BitConverter]::ToUInt32($head, 12)
  $jsonBytes = New-Object byte[] $jsonLen
  $read = 0
  while ($read -lt $jsonLen) {
    $n = $fs.Read($jsonBytes, $read, $jsonLen - $read)
    if ($n -le 0) { break }
    $read += $n
  }
  $dataBase = 16 + $jsonLen
  $tree = [System.Text.Encoding]::UTF8.GetString($jsonBytes) | ConvertFrom-Json

  # --- обход дерева: каталог — это узел с полем files -----------------------
  $entries = New-Object System.Collections.Generic.List[object]
  function Walk([object]$node, [string]$prefix) {
    foreach ($p in $node.PSObject.Properties) {
      $path = if ($prefix) { "$prefix/$($p.Name)" } else { "/$($p.Name)" }
      $child = $p.Value
      if ($null -ne $child.size) { $script:entries.Add([pscustomobject]@{ Path = $path; Offset = [int64]$child.offset; Size = [int64]$child.size }) }
      elseif ($null -ne $child.files) { Walk $child.files $path }
    }
  }
  Walk $tree.files ""

  $selected = $entries | Where-Object { $_.Path -match $Filter }
  if (-not $selected) { Write-Error "в архиве нет файлов по фильтру: $Filter"; exit 1 }
  Write-Output "файлов к извлечению: $(($selected | Measure-Object).Count)"

  # --- извлечение -----------------------------------------------------------
  $prefixLen = '/dsh/node_modules/@deepseek-ai/'.Length
  $buffer = New-Object byte[] 1MB
  $count = 0
  foreach ($entry in $selected) {
    $target = Join-Path $Dest ($entry.Path.Substring($prefixLen))
    $dir = Split-Path $target -Parent
    if (-not (Test-Path $dir)) { $null = New-Item -ItemType Directory -Path $dir -Force }
    $null = $fs.Seek($dataBase + $entry.Offset, 'Begin')
    $out = [System.IO.File]::Create($target)
    try {
      $left = $entry.Size
      while ($left -gt 0) {
        $want = [int][Math]::Min($buffer.Length, $left)
        $n = $fs.Read($buffer, 0, $want)
        if ($n -le 0) { break }
        $out.Write($buffer, 0, $n)
        $left -= $n
      }
    } finally { $out.Close() }
    $count++
  }
  Write-Output "извлечено $count файл(ов) в $Dest"
  Write-Output "далее: node tools/extract-english.mjs `"$Dest`" --write"
} finally { $fs.Close() }
