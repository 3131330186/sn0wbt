@echo off
REM ============================================================
REM  一键起本地语音服务栈（已在跑的自动跳过）
REM    ACE-Step    127.0.0.1:8001   歌声链出歌（SVC 方案）
REM    GPT-SoVITS  127.0.0.1:9880   说话（克隆音色 TTS）
REM  关掉对应黑窗口 = 停该服务。
REM
REM  启动顺序有讲究（实踩 2026-11-06）：ACE-Step 刚启动时 DiT 常驻
REM  （约 8GB），此时如果 SoVITS 也在，第一首出歌必掉进共享显存慢 20
REM  倍、5 分钟必超时。所以顺序固定为：先 ACE-Step → 自动预热一首
REM  5 秒小歌（出完 DiT 自动卸回内存）→ 再起 SoVITS。
REM  ACESTEP_INIT_LLM=false：歌声链不用 LM，省 2GB 常驻显存。
REM ============================================================
setlocal
set "ACESTEP_OFFLOAD_DIT_TO_CPU=true"
set "ACESTEP_INIT_LLM=false"

REM ── ACE-Step 先起 ──
curl -s --max-time 2 http://127.0.0.1:8001/health >nul 2>&1
if errorlevel 1 start "ACE-Step :8001" /min cmd /c "cd /d D:\ACE-Step-portable && python_embeded\python.exe acestep\api_server.py --host 127.0.0.1 --port 8001 --download-source modelscope > acestep-api.log 2>&1"

REM 等 ACE-Step 就绪（最多 3 分钟），然后提交预热小歌
set /a N=0
:WAIT_ACE
curl -s --max-time 2 http://127.0.0.1:8001/health >nul 2>&1
if not errorlevel 1 goto ACE_UP
set /a N+=1
if %N% GEQ 18 goto ACE_MAYBE
timeout /t 10 /nobreak >nul
goto WAIT_ACE
:ACE_MAYBE
echo [ACE-Step] 3 分钟没就绪，跳过预热（首次出歌可能偏慢，属正常）
goto SOVITS
:ACE_UP
curl -s --max-time 10 -X POST http://127.0.0.1:8001/release_task -H "Content-Type: application/json" -d "{\"prompt\":\"pop\",\"lyrics\":\"la la la\",\"vocal_language\":\"en\",\"inference_steps\":4,\"audio_duration\":5,\"batch_size\":1}" >nul 2>&1
echo [ACE-Step] 预热小歌已提交（后台约 20 秒跑完，DiT 随即卸载）
timeout /t 25 /nobreak >nul

:SOVITS
curl -s --max-time 2 http://127.0.0.1:9880/docs >nul 2>&1
if errorlevel 1 (
  start "GPT-SoVITS :9880" /min cmd /c "cd /d D:\GPT-SoVITS-v3lora-20250228 && runtime\python.exe api_v2.py -a 127.0.0.1 -p 9880 > api_v2.log 2>&1"
  echo [GPT-SoVITS] 启动中...（首次加载模型约 30 秒）
) else (
  echo [GPT-SoVITS] 已在运行
)
echo.
echo 全部就绪后，控制台语音页状态卡会显示"歌声链在线"。
pause
endlocal
