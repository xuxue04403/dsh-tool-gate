# dsh-tool-gate —— 安装 / 卸载脚本
#
# 用法：
#   pwsh -File .\install.ps1 -Profile quant
#   pwsh -File .\install.ps1 -Profile desktop          # 桌面客户端用的 profile
#   pwsh -File .\install.ps1 -Profile dev -DshHome D:\dsh-home
#   pwsh -File .\install.ps1 -Profile quant -Uninstall
#
# 做的事：复制到 <profile>/vendor/dsh-tool-gate → 写进 dsh.profile.bundles
#   - 普通 profile：用 `dsh plugin add file:...` 让 pnpm 建依赖
#   - desktop profile：CLI 明确拒绝管理它（"managed exclusively by the Electron application"），
#     所以手工建 node_modules 链接，完全不动 pnpm 依赖树
param(
    [Parameter(Mandatory = $true)][string]$Profile,
    [string]$DshHome = '',
    [string]$Dsh = '',
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$Package = 'dsh-tool-gate'
$src = $PSScriptRoot
$isDesktop = ($Profile -eq 'desktop')

function Get-DshCli {
    if ($Dsh -and (Test-Path $Dsh)) { return $Dsh }
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'),
        (Join-Path $env:PROGRAMFILES 'DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'),
        (Join-Path ${env:ProgramFiles(x86)} 'DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd')
    )
    $found = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    if ($found) { return $found }
    # 排除本仓库自己的路由脚本，避免递归
    $own = Join-Path $env:USERPROFILE '.dsh\bin'
    $cmd = Get-Command dsh -CommandType Application -ErrorAction SilentlyContinue |
        Where-Object { (Split-Path -Parent $_.Source) -ne $own } |
        Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    return $null
}

if ($DshHome -eq '') {
    $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
}
$profileDir = Join-Path $DshHome "profiles\$Profile"

if (-not (Test-Path $profileDir)) {
    Write-Host "找不到 profile: $profileDir" -ForegroundColor Red
    Write-Host "先建一个（用内置模板）：dsh --profile $Profile --from-default-profile web --dump-config > `$null" -ForegroundColor Yellow
    exit 1
}

$manifest = Join-Path $profileDir 'package.json'
$vendor = Join-Path $profileDir "vendor\$Package"
$link = Join-Path $profileDir "node_modules\$Package"
$base = '@deepseek-ai/dsh-base'

function Read-Manifest {
    Get-Content $manifest -Raw | ConvertFrom-Json
}

function Write-Manifest($json) {
    $json | ConvertTo-Json -Depth 12 | Set-Content $manifest -Encoding utf8
}

if ($Uninstall) {
    if (-not $isDesktop) {
        $cli = Get-DshCli
        if ($cli) { & $cli plugin --profile $Profile remove $Package *> $null }
    }
    if (Test-Path $link) { (Get-Item $link).Delete() }
    $j = Read-Manifest
    $j.dsh.profile.bundles = @($j.dsh.profile.bundles | Where-Object { $_ -ne $Package })
    Write-Manifest $j
    if (Test-Path $vendor) { Remove-Item $vendor -Recurse -Force }
    Write-Host "$Package 已从 profile '$Profile' 卸载（重启后生效）。" -ForegroundColor Green
    exit 0
}

# 1. 复制到 profile 内的 vendor/（file: 依赖指向 profile 外会静默不加载）
New-Item -ItemType Directory -Force $vendor | Out-Null
foreach ($item in @('package.json', 'cordis.patch.yml', 'lib', 'README.md', 'LICENSE', 'examples')) {
    $from = Join-Path $src $item
    if (-not (Test-Path $from)) { continue }
    $to = Join-Path $vendor $item
    if (Test-Path $to) { Remove-Item $to -Recurse -Force }
    Copy-Item $from $to -Recurse -Force
}

# 2. 接入 profile
if ($isDesktop) {
    New-Item -ItemType Directory -Force (Join-Path $profileDir 'node_modules') | Out-Null
    if (Test-Path $link) { (Get-Item $link).Delete() }
    New-Item -ItemType Junction -Path $link -Target $vendor | Out-Null
} else {
    $cli = Get-DshCli
    if (-not $cli) {
        Write-Host '找不到 dsh CLI，请用 -Dsh 指定 dsh.cmd 的完整路径。' -ForegroundColor Red
        exit 1
    }
    & $cli plugin --profile $Profile add "file:vendor/$Package" *> $null
    # pnpm 对 file: 依赖是「复制」，且 spec 不变时不会重新复制 → 已装过必须先摘掉，否则拿到的是旧代码
    if (Test-Path (Join-Path $link 'lib\index.js')) {
        & $cli plugin --profile $Profile remove $Package *> $null
    }
    & $cli plugin --profile $Profile add "file:vendor/$Package" *> $null
    if (-not (Test-Path (Join-Path $link 'lib\index.js'))) {
        Write-Host "安装失败：$link 不存在。" -ForegroundColor Red
        Write-Host "手动排查：dsh plugin --profile $Profile add file:vendor/$Package" -ForegroundColor Yellow
        exit 1
    }
}

if (-not (Test-Path (Join-Path $link 'lib\index.js'))) {
    Write-Host "安装失败：$link\lib\index.js 不存在。" -ForegroundColor Red
    exit 1
}

# 3. 写进 bundles（紧跟 dsh-base）
$j = Read-Manifest
if (-not $j.dependencies.PSObject.Properties[$Package]) {
    $j.dependencies | Add-Member -NotePropertyName $Package -NotePropertyValue "file:vendor/$Package"
}
$others = @($j.dsh.profile.bundles | Where-Object { $_ -ne $Package -and $_ -ne $base })
if (@($j.dsh.profile.bundles) -contains $base) {
    $j.dsh.profile.bundles = @($base, $Package) + $others
} else {
    $j.dsh.profile.bundles = @($Package) + $others
}
Write-Manifest $j

Write-Host "$Package 已装到 profile '$Profile'。" -ForegroundColor Green
Write-Host ''
Write-Host '下一步：' -ForegroundColor Cyan
if ($isDesktop) {
    Write-Host '  1) 完全退出并重开 DeepSeek Harness（桌面端只认 profiles/desktop，重启才加载新插件）'
} else {
    Write-Host "  1) 重启 dsh：dsh --profile $Profile"
}
Write-Host '  2) 项目根放规则：.dsh/tool-gate.json（改规则即时生效，不用重启）'
Write-Host '  3) 会话里调用 tool_gate_status 自检'
