# 把开发副本同步到各 profile 并校正 bundles 顺序。
#
# 用法：
#   pwsh -File sync.ps1                        # 同步 quant / dev / desktop
#   pwsh -File sync.ps1 -Profiles quant,dev,desktop
#
# 逻辑统一交给 install.ps1（它区分普通 profile 的 pnpm 路径与 desktop 的手工链接路径）。
param(
    [string]$Profiles = 'quant,dev,desktop',
    [string]$DshHome = "$env:USERPROFILE\.dsh",
    [string]$Dsh = ''
)

$ErrorActionPreference = 'Stop'
$Package = 'dsh-tool-gate'
$installer = Join-Path $PSScriptRoot 'install.ps1'
$list = $Profiles -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }

foreach ($profile in $list) {
    $dir = Join-Path $DshHome "profiles\$profile"
    if (-not (Test-Path $dir)) {
        Write-Host "skip（profile 不存在）: $profile" -ForegroundColor Yellow
        continue
    }
    $extra = @{}
    if ($Dsh -ne '') { $extra['Dsh'] = $Dsh }
    & $installer -Profile $profile -DshHome $DshHome @extra | Out-Null

    $nmFile = Join-Path $dir "node_modules\$Package\lib\index.js"
    $mf = Join-Path $dir 'package.json'
    $j = Get-Content $mf -Raw | ConvertFrom-Json
    $bundles = @($j.dsh.profile.bundles)
    $pos = [array]::IndexOf($bundles, $Package)
    $ok = (Test-Path $nmFile) -and ((Get-Content $nmFile -Raw) -match 'ctx\.tools\[PATCHED\]')
    $inBundles = $bundles -contains $Package
    $color = if ($ok -and $inBundles) { 'Green' } else { 'Red' }
    Write-Host ("{0}: node_modules 为新版={1} bundles 含插件={2} 位置={3}" -f $profile, $ok, $inBundles, $pos) -ForegroundColor $color
}

Write-Host ''
Write-Host '提醒：补丁层在启动时加载 —— 普通 profile 重启对应 dsh 进程；桌面端要完全退出后重开。' -ForegroundColor Cyan
