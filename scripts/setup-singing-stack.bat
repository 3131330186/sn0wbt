@echo off
chcp 936 >nul
setlocal
REM ============================================================
REM  歌声链 · demucs 环境自动安装（人声分离组件）
REM  自动完成：下载 Python 3.10 → 静默装到本目录 → 建 venv
REM            → 装 CUDA torch（约 2.5GB）→ 装 demucs
REM  全程走国内可达源；需要联网，约 10~25 分钟。
REM ============================================================
set TOOLKIT=D:\SVC-toolkit
set PYVER=3.10.11

if exist "%TOOLKIT%\venv\Scripts\demucs.exe" (
  echo [OK] demucs 环境已装好，无需重复安装。
  pause
  exit /b 0
)

echo [1/5] 建目录 %TOOLKIT% ...
mkdir "%TOOLKIT%" 2>nul

echo [2/5] 下载 Python %PYVER% 安装包（约 29MB）...
if not exist "%TEMP%\py310-installer.exe" (
  curl -L --max-time 600 -o "%TEMP%\py310-installer.exe" "https://www.python.org/ftp/python/%PYVER%/python-%PYVER%-amd64.exe"
  if errorlevel 1 (
    echo [X] Python 下载失败 —— 手动去 python.org 下载 3.10.11 安装包，
    echo     安装时勾选安装到 %TOOLKIT%\py310 后重跑本脚本。
    pause
    exit /b 1
  )
) else (
  echo     已有安装包，跳过下载。
)

echo [3/5] 静默安装 Python 到 %TOOLKIT%\py310 ...
if not exist "%TOOLKIT%\py310\python.exe" (
  "%TEMP%\py310-installer.exe" /quiet InstallAllUsers=0 TargetDir="%TOOLKIT%\py310" Include_pip=1 Include_launcher=0 PrependPath=0 Include_test=0
  if errorlevel 1 (
    echo [X] Python 安装失败。
    pause
    exit /b 1
  )
) else (
  echo     已存在，跳过。
)

echo [4/5] 建虚拟环境 ...
if not exist "%TOOLKIT%\venv\Scripts\python.exe" (
  "%TOOLKIT%\py310\python.exe" -m venv "%TOOLKIT%\venv"
) else (
  echo     venv 已存在，跳过。
)

echo [5/5] 安装 CUDA torch（约 2.5GB，10~20 分钟，别关窗口）+ demucs ...
"%TOOLKIT%\venv\Scripts\python.exe" -m pip install --upgrade pip -q -i https://pypi.tuna.tsinghua.edu.cn/simple
if errorlevel 1 goto PIPFAIL
"%TOOLKIT%\venv\Scripts\python.exe" -m pip install torch==2.5.1 torchvision==0.20.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cu121
if errorlevel 1 goto PIPFAIL
"%TOOLKIT%\venv\Scripts\python.exe" -m pip install demucs -i https://pypi.tuna.tsinghua.edu.cn/simple
if errorlevel 1 goto PIPFAIL

echo.
echo [OK] demucs 环境装好了。下一步按《歌声链安装指南》生成语料 + 训练。
pause
exit /b 0

:PIPFAIL
echo.
echo [X] pip 安装失败 —— 网络问题。重跑本脚本会从断点继续
echo     （已装好的包会跳过）。多次失败就把报错贴给维护者。
pause
exit /b 1
