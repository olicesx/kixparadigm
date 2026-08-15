# ensure-vision-bridge.ps1 — dsh-vision-bridge 加固自检/自愈脚本（幂等）
#
# 背景（2026-08 加固）：dsh-vision-bridge 的加载链是
#   loader require.resolve('dsh-vision-bridge') ← ~/.dsh/profiles/web/node_modules/
#   的 junction → 插件源码目录
# 本脚本确保：
#   1. junction 存在且指向 ~/.dsh/profiles/web/plugins/dsh-vision-bridge（DSH_HOME 内源码，
#      不依赖 npm 全局目录；npm -g prune / 重装 node 均不影响）
#   2. package.json 的 exports 声明 ./package.json（缺失会导致 client-modules 注册表
#      require.resolve('<name>/package.json') 抛 ERR_PACKAGE_PATH_NOT_EXPORTED，
#      客户端半永远进不了 __DSH_BOOT__ —— 2026-08 实测根因）
#   3. 全链路解析验证（verify-vision-bridge-resolution.cjs）
#
# 用法：pwsh -NoProfile -File .\ensure-vision-bridge.ps1        # 自检+修复+验证
#       pwsh -NoProfile -File .\ensure-vision-bridge.ps1 -DryRun # 只报告不修改
#
# 注意：本脚本只修复文件层；dsh web 需重启后 client 半才会注册进 boot 清单。

param(
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

$homeDsh   = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profile   = Join-Path $homeDsh 'profiles\web'
$source    = Join-Path $profile 'plugins\dsh-vision-bridge'
$junction  = Join-Path $profile 'node_modules\dsh-vision-bridge'
$verifyJs  = Join-Path $PSScriptRoot 'verify-vision-bridge-resolution.cjs'
$EXPECTED  = [System.IO.Path]::GetFullPath($source)

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    OK: $msg" -ForegroundColor Green }
function Write-Warn($msg){ Write-Host "    !!: $msg" -ForegroundColor Yellow }

Write-Step "dsh-vision-bridge 加固检查 (DryRun=$DryRun)"

# 0. 前置
if (-not (Test-Path $source)) { Write-Warn "源码目录缺失: $source"; exit 1 }
if (-not (Test-Path "$source\package.json")) { Write-Warn "package.json 缺失"; exit 1 }

# 1. junction 检查
if (Test-Path $junction) {
    $item = Get-Item $junction -Force
    if ($item.LinkType -ne 'Junction') {
        Write-Warn "存在但不是 junction: $junction（将删除重建）"
        if (-not $DryRun) { Remove-Item $junction -Force }
    } elseif ([System.IO.Path]::GetFullPath($item.Target) -ne $EXPECTED) {
        Write-Warn "junction 指向错误: $($item.Target)（期望 $EXPECTED，将重指）"
        if (-not $DryRun) { Remove-Item $junction -Force }
    } else {
        Write-Ok "junction 正确: $junction -> $($item.Target)"
    }
} else {
    Write-Warn "junction 缺失: $junction"
    if (-not $DryRun) {
        New-Item -ItemType Junction -Path $junction -Target $source | Out-Null
        Write-Ok "已创建 junction -> $source"
    }
}

# 2. exports 声明检查（client 半注册的硬前提）
$pkg = Get-Content "$source\package.json" -Raw | ConvertFrom-Json
if ($pkg.exports.'./package.json') {
    Write-Ok "exports 含 ./package.json"
} else {
    Write-Warn "exports 缺 ./package.json —— client 半无法注册（ERR_PACKAGE_PATH_NOT_EXPORTED）"
    if (-not $DryRun) {
        # 简单文本级修复（保持其余内容不动）
        $raw = Get-Content "$source\package.json" -Raw
        $raw = $raw -replace '("\./client"\s*:\s*"\./client\.js",)', "`$1`n    `"./package.json`": `"./package.json`","
        Set-Content -Path "$source\package.json" -Value $raw -Encoding UTF8
        Write-Ok "已补 exports './package.json'（如仍未生效请人工核对 JSON）"
    }
}

# 3. v2 行为标记检查（client.js 应为提交时转换；缺标记 = 退回 v1 粘贴即转）
$client = Get-Content "$source\client.js" -Raw
if ($client -match '__visionWrapped') {
    Write-Ok "client.js 为 v2（提交时转换，__visionWrapped 标记存在）"
} else {
    Write-Warn "client.js 缺 v2 标记 __visionWrapped —— 当前为 v1 粘贴即转行为"
}

# 4. 全链路验证（node 直读，走与 dsh loader 相同的 createRequire 路径）
if (Test-Path $verifyJs) {
    if ($DryRun) {
        Write-Ok "验证脚本就绪: $verifyJs（DryRun 不执行）"
    } else {
        Write-Step "运行全链路验证"
        & node $verifyJs
        if ($LASTEXITCODE -ne 0) { Write-Warn "验证失败（exit $LASTEXITCODE）"; exit $LASTEXITCODE }
        Write-Ok "全链路验证通过"
    }
} else {
    Write-Warn "验证脚本缺失: $verifyJs"
}

Write-Step "完成。提醒：client.js 变更经 no-cache 直出，刷新页面即生效（无需重启）；若页面行为仍异常再重启 dsh web。"
