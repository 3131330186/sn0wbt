; ── QQ Agent 自定义安装：覆盖升级保护 + 旧版数据迁移 ──
; 本 include 在 electron-builder 主脚本早期被插入，nsDialogs/LogicLib 可能尚未加载，自己引（有防重复保护）
!include nsDialogs.nsh
!include LogicLib.nsh
!include MUI2.nsh
;
; 【为什么需要 This 文件里的备份逻辑】
; electron-builder 的卸载器模板（uninstaller.nsh）在删除阶段会执行
;     RMDir /r $INSTDIR        ← 递归删掉整个安装目录
; 而覆盖安装的流程是「先跑旧版卸载器，再铺新文件」（installSection.nsh 先调 uninstallOldVersion）。
; 本项目的用户数据恰好就在 $INSTDIR 里面：
;     $INSTDIR\data                            ← 配置 / 记忆 / 聊天记录 / 表情包 / 遥测 ID
;     $INSTDIR\resources\app\snowluma\config   ← SnowLuma 登录态 + OneBot 令牌
; 所以「覆盖升级」会把数据一起删掉。修法：在旧版卸载器跑之前先备份，装完再还原。
;
; 【完整流程】
;   1. 双击安装包 → .onInit 阶段（customInit）先查注册表「上次装到哪」
;   2. 查到了 → 先关掉正在运行的 QQ Agent（否则 data/logs 里的文件被占用复制不全），
;      再把上面两个目录整体备份到 $LOCALAPPDATA\QQ Agent\upgrade-backup
;   3. 迁移页：自动检测到的展示「将直接覆盖升级，数据已备份」，也可手动指定别的旧版目录
;   4. 目录页会预填上次的安装路径（electron-builder 从注册表 ReadRegStr InstallLocation
;      赋值给 $INSTDIR），直接「下一步」就等于覆盖安装
;   5. 安装段：旧版卸载器先跑（把 $INSTDIR 整个删掉）→ 再铺新文件
;   6. customInstall：把第 2 步的备份 robo 回 $INSTDIR → 数据零丢失，再把手动指定的目录并进来
;
; 数据目录约定：应用根目录/data（见 electron/main.js resolveDataDir，exe 旁边）。
; asar 已关闭（开源式分发，文件平铺可改），程序文件在 resources/app/ 下。
;
; ⚠️ 本 include 对安装包和卸载器各编译一遍；页面函数在卸载器里无人引用，
; NSIS「警告即错误」会把 warning 6010 炸成构建失败——页面相关代码只给安装器（!ifndef 包住）。
; ⚠️ Var 也必须放 !ifndef 里：卸载器那份编译不会展开 customInstall/customInit，
;    变量声明了却没人用 → warning 6001「not referenced」也会炸构建（本次实测踩到）。
;    反过来 customInstall 虽然在 !ifndef 之外，但它只在安装器里被 !insertmacro，
;    宏体不展开就不会引用变量，所以照样安全。

; ── 递归复制工具 ────────────────────────────────────────────────
; 用 robocopy 而不是 NSIS 自带 CopyFiles：
;   ① /R:0 /W:0 永不重试、永不弹「是否重试」对话框 —— 文件被占用时不会把安装卡死
;   ② 明确的递归语义（/E 含空目录）
;   ③ 退出码 0~7 都算成功，>7 才是真失败
!macro ROBOTREE SRC DST
  nsExec::ExecToLog '"$SYSDIR\robocopy.exe" "${SRC}" "${DST}" /E /R:0 /W:0 /NFL /NDL /NJH /NJS /NP'
  Pop $R9
  ${If} $R9 > 7
    DetailPrint "⚠ 复制失败（robocopy 返回 $R9）：${SRC}"
  ${EndIf}
!macroend

!ifndef BUILD_UNINSTALLER

Var OldDataDir        ; 用户手动指定的旧版目录（压缩包版迁移用）
Var DetectedDir       ; 注册表检测到的上次安装目录
Var BackupDir         ; 升级备份落点
Var BackupData        ; "1" = data/ 备份成功
Var BackupLogin       ; "1" = SnowLuma 登录态备份成功

Function OnOldDirChange
  ${NSD_GetText} $1 $OldDataDir
FunctionEnd

Function OnBrowseOldDir
  nsDialogs::SelectFolderDialog "选择旧版 QQ Agent 所在的文件夹（里面有 assets、electron、node_modules 等）" "$PROGRAMFILES"
  Pop $0
  ${If} $0 != ""
    ${NSD_SetText} $1 $0
    StrCpy $OldDataDir $0
  ${EndIf}
FunctionEnd

Function AskOldVersionPage
  !insertmacro MUI_HEADER_TEXT "旧版本数据迁移" "检测到已安装会自动覆盖升级并保留数据。"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${If} $DetectedDir != ""
    ${NSD_CreateLabel} 0 0 100% 54u "检测到本机已安装 QQ Agent：$\r$\n$DetectedDir$\r$\n$\r$\n将直接覆盖升级。你的用户数据（配置 / 记忆 / 聊天记录 / 表情包 / 登录状态）已在安装前自动备份，装完会原样放回，不会丢失。$\r$\n$\r$\n如果还想从别的位置并入数据（例如压缩包版），可在下面指定；不需要就留空，直接点「下一步」。"
    Pop $0
  ${Else}
    ${NSD_CreateLabel} 0 0 100% 54u "如果你的电脑上已经有旧版本的 QQ Agent（比如压缩包版），在下面选择它所在的文件夹：$\r$\n$\r$\n安装完成后，会自动把旧版里的用户数据（配置 / 记忆 / 聊天记录 / 表情包 / 登录状态）迁移到新安装位置，无缝接管。$\r$\n$\r$\n没有旧版本的话，直接点「下一步」。"
    Pop $0
  ${EndIf}

  ${NSD_CreateDirRequest} 0 86u 78% 14u "$OldDataDir"
  Pop $1
  ${NSD_OnChange} $1 OnOldDirChange

  ${NSD_CreateButton} 80% 86u 20% 14u "浏览…"
  Pop $2
  ${NSD_OnClick} $2 OnBrowseOldDir

  nsDialogs::Show
FunctionEnd

; ⚠️ electron-builder 只提供 customWelcomePage（目录页之前）和 customPageAfterChangeDir
; （目录页之后）两个页面钩子。Kondius 要求询问在"选定安装位置"前面 → 用 welcome 钩子，
; 迁移页会排在欢迎页之后、安装模式/目录页之前。

!macro customWelcomePage
  Page custom AskOldVersionPage
!macroend

!endif ; BUILD_UNINSTALLER

; ── 覆盖升级：跑卸载器之前先把数据备份出来 ──────────────────────
; 时机：.onInit（远早于 install 段里的 uninstallOldVersion），此刻旧文件都还在。
!macro customInit
  StrCpy $DetectedDir ""
  StrCpy $BackupDir ""
  StrCpy $BackupData "0"
  StrCpy $BackupLogin "0"

  ; 1) 找上次安装位置。
  ; ⚠️ electron-builder 写的键是 "Software\<APP_GUID>"（GUID 由 appId 哈希而来，
  ;    见 multiUser.nsh: !define INSTALL_REGISTRY_KEY "Software\${APP_GUID}"），
  ;    **不是** "Software\<appId>"。本次实测踩过：读 appId 那个键永远读不到，
  ;    结果是「检测不到旧版 → 不备份 → 覆盖升级照样删数据」。
  ;    用 ${APP_GUID} 还能自动跟随 appId 变化，不必手抄那串 GUID。
  ReadRegStr $DetectedDir HKCU "Software\${APP_GUID}" "InstallLocation"
  ${If} $DetectedDir == ""
    ReadRegStr $DetectedDir HKLM "Software\${APP_GUID}" "InstallLocation"
  ${EndIf}

  ; 诊断痕迹：无论检测结果如何都留一笔，方便事后确认 customInit 到底跑没跑、
  ; 以及它读到的旧安装目录是什么（排查「升级没备份」时这一步最省事）
  CreateDirectory "$LOCALAPPDATA\QQ Agent\upgrade-backup"
  FileOpen $R8 "$LOCALAPPDATA\QQ Agent\upgrade-backup\_last-customInit.txt" w
  FileWrite $R8 "customInit ran$\r$\nDetectedDir=$DetectedDir$\r$\n"
  FileClose $R8

  ; 2) 查到了就立刻备份（放在持久目录而不是 $PLUGINSDIR：
  ;    万一安装中途崩了，用户还能自己从那儿把数据捞回来）
  ${If} $DetectedDir != ""
    StrCpy $BackupDir "$LOCALAPPDATA\QQ Agent\upgrade-backup"

    ; 先关掉正在运行的 QQ Agent。必须在复制之前做：
    ; 程序开着时 data\logs\*.log 是打开状态，不关就会复制不全
    nsExec::Exec '"$SYSDIR\taskkill.exe" /IM "QQ Agent.exe" /F /T'
    Pop $R9
    Sleep 600

    ; ⚠️ 备份是否成功必须靠「目标目录里真的有东西」来判定，
    ;    不能假设 robocopy 一定成功 —— 否则失败时静默丢数据
    ${If} ${FileExists} "$DetectedDir\data\*.*"
      CreateDirectory "$BackupDir\data"
      !insertmacro ROBOTREE "$DetectedDir\data" "$BackupDir\data"
      ${If} ${FileExists} "$BackupDir\data\*.*"
        StrCpy $BackupData "1"
        DetailPrint "已备份旧版用户数据：$DetectedDir\data → $BackupDir\data"
      ${Else}
        ${IfNot} ${Silent}
          MessageBox MB_OK|MB_ICONSTOP "备份旧版用户数据失败：$\r$\n$DetectedDir\data$\r$\n$\r$\n继续安装可能丢失聊天记录与配置。建议先关掉 QQ Agent 再重试，或先把该文件夹手动复制出来。"
        ${EndIf}
      ${EndIf}
    ${EndIf}

    ${If} ${FileExists} "$DetectedDir\resources\app\snowluma\*.*"
      ; 整目录备份（程序+登录态）：安装包永不自带 SnowLuma，还原整目录 =
      ; 升级后免重新下载 SnowLuma、免重新扫码。以后若政策改为自带，
      ; customInstall 的"目标已存在则跳过"条件会自动让位给包内版本。
      CreateDirectory "$BackupDir\snowluma"
      !insertmacro ROBOTREE "$DetectedDir\resources\app\snowluma" "$BackupDir\snowluma"
      ${If} ${FileExists} "$BackupDir\snowluma\*.*"
        StrCpy $BackupLogin "1"
        DetailPrint "已备份 SnowLuma（整目录含登录态）：→ $BackupDir\snowluma"
      ${EndIf}
    ${EndIf}

    ; ── 用户自己加的插件/技能（实踩：升级把测试者放的插件挤没了）──
    ; 安装包不带 plugins/skills（出厂为空），但用户往里放的第三方件在
    ; 旧版卸载器 RMDir /r $INSTDIR 时会一起没 —— 和 data 同款：先备份后还原。
    ${If} ${FileExists} "$DetectedDir\resources\app\plugins\*.*"
      CreateDirectory "$BackupDir\plugins"
      !insertmacro ROBOTREE "$DetectedDir\resources\app\plugins" "$BackupDir\plugins"
      ${If} ${FileExists} "$BackupDir\plugins\*.*"
        DetailPrint "已备份用户插件：$DetectedDir\resources\app\plugins"
      ${EndIf}
    ${EndIf}
    ${If} ${FileExists} "$DetectedDir\resources\app\skills\*.*"
      CreateDirectory "$BackupDir\skills"
      !insertmacro ROBOTREE "$DetectedDir\resources\app\skills" "$BackupDir\skills"
      ${If} ${FileExists} "$BackupDir\skills\*.*"
        DetailPrint "已备份用户技能：$DetectedDir\resources\app\skills"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro customInstall
  ; ① 还原「覆盖升级」自动备份（原机数据，优先级最高）
  ${If} $BackupData == "1"
  ${AndIf} ${FileExists} "$BackupDir\data\*.*"
    CreateDirectory "$INSTDIR\data"
    !insertmacro ROBOTREE "$BackupDir\data" "$INSTDIR\data"
    DetailPrint "已还原用户数据：$BackupDir\data → $INSTDIR\data"
  ${EndIf}
  ${If} $BackupLogin == "1"
  ${AndIf} ${FileExists} "$BackupDir\snowluma\*.*"
    ; 目标已存在 = 新安装包自带了 SnowLuma（政策若变）→ 以包内为准，不还原
  ${AndIfNot} ${FileExists} "$INSTDIR\resources\app\snowluma\*.*"
    CreateDirectory "$INSTDIR\resources\app\snowluma"
    !insertmacro ROBOTREE "$BackupDir\snowluma" "$INSTDIR\resources\app\snowluma"
    DetailPrint "已还原 SnowLuma（程序+登录态，免重新下载/扫码）"
  ${EndIf}

  ; ② 用户手动指定的旧版目录（压缩包用户）：显式选择优先，覆盖上面的还原
  ${If} $OldDataDir != ""
  ${AndIf} ${FileExists} "$OldDataDir\data\*.*"
    CreateDirectory "$INSTDIR\data"
    !insertmacro ROBOTREE "$OldDataDir\data" "$INSTDIR\data"
    DetailPrint "已迁移旧版本用户数据：$OldDataDir\data"
  ${EndIf}
  ; SnowLuma 登录态 + OneBot 令牌一并带走，免重新扫码
  ${If} $OldDataDir != ""
  ${AndIf} ${FileExists} "$OldDataDir\snowluma\config\*.*"
    CreateDirectory "$INSTDIR\resources\app\snowluma\config"
    !insertmacro ROBOTREE "$OldDataDir\snowluma\config" "$INSTDIR\resources\app\snowluma\config"
    DetailPrint "已迁移 SnowLuma 登录状态"
  ${EndIf}

  ; ③ 用户自己加的插件/技能：升级备份还原 + 手动迁移路径同款
  ${If} ${FileExists} "$BackupDir\plugins\*.*"
    CreateDirectory "$INSTDIR\resources\app\plugins"
    !insertmacro ROBOTREE "$BackupDir\plugins" "$INSTDIR\resources\app\plugins"
    DetailPrint "已还原用户插件（升级前备份的）"
  ${EndIf}
  ${If} ${FileExists} "$BackupDir\skills\*.*"
    CreateDirectory "$INSTDIR\resources\app\skills"
    !insertmacro ROBOTREE "$BackupDir\skills" "$INSTDIR\resources\app\skills"
    DetailPrint "已还原用户技能（升级前备份的）"
  ${EndIf}
  ${If} $OldDataDir != ""
  ${AndIf} ${FileExists} "$OldDataDir\resources\app\plugins\*.*"
    CreateDirectory "$INSTDIR\resources\app\plugins"
    !insertmacro ROBOTREE "$OldDataDir\resources\app\plugins" "$INSTDIR\resources\app\plugins"
    DetailPrint "已迁移旧版本用户插件"
  ${EndIf}
  ${If} $OldDataDir != ""
  ${AndIf} ${FileExists} "$OldDataDir\resources\app\skills\*.*"
    CreateDirectory "$INSTDIR\resources\app\skills"
    !insertmacro ROBOTREE "$OldDataDir\resources\app\skills" "$INSTDIR\resources\app\skills"
    DetailPrint "已迁移旧版本用户技能"
  ${EndIf}

  ; ④ 全新安装保证目录存在（包里不带，收包人往这儿放自己的插件/技能；
  ;    plugin-loader 对空目录/缺失目录本来就安全）
  CreateDirectory "$INSTDIR\resources\app\plugins"
  CreateDirectory "$INSTDIR\resources\app\skills"
!macroend

; ── 卸载保护：用户自己加的插件/技能在删除前抢救出来 ─────────────
; 卸载器模板随后会 RMDir /r $INSTDIR，用户往 resources\app\plugins、
; skills 里放的东西会一起没 —— 先备份到持久目录，卸载完告知位置。
; （本宏只被卸载器编译展开，不引用任何 Var，不会触发 6001 警告）
!macro customUnInstall
  ; ── 用户数据（聊天记录/配置/记忆/API Key）：卸载 = RMDir /r 全没了 ──
  ; 静默卸载（升级流程）不问也不备 —— 升级时新安装器已备过一份；
  ; 只有用户手动卸载（非静默）才弹窗问。
  ${IfNot} ${Silent}
  ${AndIf} ${FileExists} "$INSTDIR\data\*.*"
    MessageBox MB_YESNO|MB_ICONQUESTION "卸载将删除 QQ Agent 的全部用户数据（聊天记录 / 配置 / 记忆 / API Key）。$\r$\n$\r$\n卸载前先备份一份吗？$\r$\n（备份到 $LOCALAPPDATA\QQ Agent\upgrade-backup\data-uninstall，数据大可能要几分钟）" IDYES DoUninstDataBackup
    Goto AfterUninstDataBackup
    DoUninstDataBackup:
    CreateDirectory "$LOCALAPPDATA\QQ Agent\upgrade-backup\data-uninstall"
    !insertmacro ROBOTREE "$INSTDIR\data" "$LOCALAPPDATA\QQ Agent\upgrade-backup\data-uninstall"
    DetailPrint "已备份用户数据（卸载保护）"
    AfterUninstDataBackup:
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\resources\app\plugins\*.*"
    CreateDirectory "$LOCALAPPDATA\QQ Agent\upgrade-backup\plugins"
    !insertmacro ROBOTREE "$INSTDIR\resources\app\plugins" "$LOCALAPPDATA\QQ Agent\upgrade-backup\plugins"
    DetailPrint "已备份用户插件到：$LOCALAPPDATA\QQ Agent\upgrade-backup\plugins"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\resources\app\skills\*.*"
    CreateDirectory "$LOCALAPPDATA\QQ Agent\upgrade-backup\skills"
    !insertmacro ROBOTREE "$INSTDIR\resources\app\skills" "$LOCALAPPDATA\QQ Agent\upgrade-backup\skills"
    DetailPrint "已备份用户技能到：$LOCALAPPDATA\QQ Agent\upgrade-backup\skills"
  ${EndIf}
  ${IfNot} ${Silent}
  ${AndIf} ${FileExists} "$LOCALAPPDATA\QQ Agent\upgrade-backup\plugins\*.*"
    MessageBox MB_OK|MB_ICONINFORMATION "卸载前已把你添加的插件/技能备份到：$\r$\n$LOCALAPPDATA\QQ Agent\upgrade-backup$\r$\n$\r$\n重装或升级后，可从那里把插件放回安装目录的 resources\\app\\plugins（技能放 skills）。"
  ${EndIf}
!macroend
