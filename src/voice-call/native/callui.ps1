# QQ 通话窗口 UIA 自动化（Phase 3 自动接听）。
# ASCII-only 注释；中文窗口/按钮名直接写在正则里（PS5.1 源文件需 UTF-8 BOM 或
# 系统码页兼容 —— 本文件经 ZCode 写出为 UTF-8，PS5.1 读取中文串依赖 BOM；
# 若探测发现匹配失败优先怀疑编码，见 AGENTS.md 编码坑）。
param([string]$Action = "")
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class U32 {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr child, string cls, string title);
    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
}
'@

# 主动激活 Chromium 渲染树：向 Chrome_RenderWidgetHostHWND 发 WM_GETOBJECT(OBJID_CLIENT)
function Wake-ChromiumAccessibility($window) {
    $hwnd = $window.Current.NativeWindowHandle
    $WM_GETOBJECT = 0x003D
    $OBJID_CLIENT = [IntPtr](-4)
    $prev = [IntPtr]::Zero
    $hits = 0
    while ($true) {
        $child = [U32]::FindWindowEx([IntPtr]$hwnd, $prev, 'Chrome_RenderWidgetHostHWND', $null)
        if ($child -eq [IntPtr]::Zero) { break }
        [U32]::SendMessage($child, $WM_GETOBJECT, [IntPtr]::Zero, $OBJID_CLIENT) | Out-Null
        $hits++
        $prev = $child
    }
    return $hits
}

function Get-QqPids {
    @(Get-Process -Name 'QQ' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
}

# 在 QQ 进程的顶层窗口里找通话窗口（标题含「语音通话」）
function Find-CallWindow {
    $qqPids = Get-QqPids
    if ($qqPids.Count -eq 0) { return $null }
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $ct = [System.Windows.Automation.AutomationElement]::ControlTypeProperty
    $win = [System.Windows.Automation.ControlType]::Window
    $cond = New-Object System.Windows.Automation.PropertyCondition($ct, $win)
    $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
    foreach ($w in $windows) {
        try {
            if ($qqPids -notcontains $w.Current.ProcessId) { continue }
            if ($w.Current.Name -match '语音通话') { return $w }
        } catch { }
    }
    return $null
}

# 枚举窗口内控件（探测用）：类型|名称，限 60 条
function Dump-Tree($window) {
    $all = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition)
    $lines = @()
    $i = 0
    foreach ($el in $all) {
        if ($i -ge 60) { $lines += '...(truncated)'; break }
        try {
            $n = $el.Current.Name
            if ($n) { $lines += "$($el.Current.ControlType.ProgrammaticName)|$n" ; $i++ }
        } catch { }
    }
    return $lines
}

# 在通话窗口里找匹配按钮并 Invoke；返回 "clicked:<name>" / "notfound" / "found-noinvoke:<name>"
function Invoke-Button($window, $pattern) {
    $all = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($el in $all) {
        try {
            $n = $el.Current.Name
            if (-not $n -or $n -notmatch $pattern) { continue }
            $inv = $null
            if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$inv)) {
                $inv.Invoke()
                return "clicked:$n"
            }
            $leg = $null
            if ($el.TryGetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern, [ref]$leg)) {
                try { $leg.DoDefaultAction(); return "clicked-legacy:$n" } catch { }
            }
            return "found-noinvoke:$n"
        } catch { }
    }
    return "notfound"
}

switch ($Action) {
    'detect' {
        $qqPids = Get-QqPids
        if ($qqPids.Count -eq 0) { [Console]::Out.WriteLine('NO-QQ-PROCESS'); exit 0 }
        $w = Find-CallWindow
        if ($null -eq $w) {
            [Console]::Out.WriteLine("NO-CALL-WINDOW qqPids=$($qqPids -join ',')")
            exit 0
        }
        $hits = Wake-ChromiumAccessibility $w
        Start-Sleep -Milliseconds 1200
        [Console]::Out.WriteLine("CALL-WINDOW pid=$($w.Current.ProcessId) title=$($w.Current.Name) wakeHits=$hits")
        Dump-Tree $w | ForEach-Object { [Console]::Out.WriteLine($_) }
        exit 0
    }
    'answer' {
        $w = Find-CallWindow
        if ($null -eq $w) { [Console]::Out.WriteLine('NO-CALL-WINDOW'); exit 0 }
        $r = Invoke-Button $w '^(接听|接受|接听语音)$'
        [Console]::Out.WriteLine($r)
        exit 0
    }
    'hangup' {
        $w = Find-CallWindow
        if ($null -eq $w) { [Console]::Out.WriteLine('NO-CALL-WINDOW'); exit 0 }
        $r = Invoke-Button $w '^(挂断|拒绝|退出通话)$'
        [Console]::Out.WriteLine($r)
        exit 0
    }
    default {
        [Console]::Error.WriteLine("unknown action: $Action")
        exit 1
    }
}
