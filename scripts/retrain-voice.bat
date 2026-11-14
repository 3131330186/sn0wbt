@echo off
chcp 936 >nul
setlocal
REM ============================================================
REM  真声重训一键入口（唱歌音色"不像人"的根治手段）
REM  流程：录音 ≥10 分钟放进一个文件夹 → 双击本脚本 → 等 1.5~2 小时
REM  实际执行：scripts\train-rvc-realvoice.mjs（质检→备料→切片→提特征→训练→索引）
REM ============================================================
set "REC=%USERPROFILE%\Desktop\真声录音"
if not "%~1"=="" set "REC=%~1"

REM ── 找运行器：有 Node.js 用 node；没有用 QQ Agent.exe（ELECTRON_RUN_AS_NODE）──
where node >nul 2>&1
if %errorlevel%==0 (
  set "RUNNER=node"
  set "ELECTRON_RUN_AS_NODE="
) else (
  set "ELECTRON_RUN_AS_NODE=1"
  set "RUNNER=%~dp0..\..\..\QQ Agent.exe"
)

echo 录音文件夹：%REC%
if not exist "%REC%" (
  echo [X] 文件夹不存在。把录音（wav/mp3/m4a 都行，共 ≥10 分钟）放进一个文件夹，
  echo     然后把文件夹拖到本 bat 上，或按《RVC音色重训教程》操作。
  pause
  exit /b 1
)

echo 开始重训（训练约 1.5~2 小时，本窗口保持开着别关）...
"%RUNNER%" "%~dp0train-rvc-realvoice.mjs" "%REC%"
echo.
echo 全部结束（或中途报错）。按提示切换模型名后重启 QQ Agent 生效。
pause
