!ifndef AIONUI_INSTALLER_UPDATE_VERIFY_NSH
!define AIONUI_INSTALLER_UPDATE_VERIFY_NSH

Var /GLOBAL AionUiUninstallHadErrors
Var /GLOBAL AionUiUninstallLogResult
Var /GLOBAL AionUiVerifyResourceResult
Var /GLOBAL AionUiUpdatedAppExitWaitResult
Var /GLOBAL AionUiActiveMarkerExecResult
Var /GLOBAL AionUiActiveMarkerResult

!define AIONUI_ACTIVE_INSTALLER_MARKER "aionui-installer-active.marker"

; Install page progress, in permille of the whole install.
; NSIS moves its own bar (control 1004) after every script instruction, so it races
; ahead on cheap instructions and stands still during extraction and copying, which
; are one instruction each. The page therefore gets a second bar that only these
; macros move, and the status line (control 1006) names the step and the percentage.
; Weights follow a measured fresh install: extraction is about half of the time, the
; per-file verification log lines about a quarter.
!define AIONUI_PROGRESS_REMOVE_OLD 30
!define AIONUI_PROGRESS_EXTRACT_START 80
!define AIONUI_PROGRESS_EXTRACT_SPAN 620
!define AIONUI_PROGRESS_COPY 700
!define AIONUI_PROGRESS_REGISTER 740
!define AIONUI_PROGRESS_VERIFY 760
!define AIONUI_PROGRESS_VERIFY_STEP 17
!define AIONUI_PROGRESS_VERIFY_CORE 940
!define AIONUI_PROGRESS_DONE 1000

Var /GLOBAL AionUiProgressBar
Var /GLOBAL AionUiProgressText
Var /GLOBAL AionUiProgressPos
Var /GLOBAL AionUiProgressPercent
Var /GLOBAL AionUiProgressZh
Var /GLOBAL AionUiProgressEn
Var /GLOBAL AionUiProgressMessage
Var /GLOBAL AionUiExtractCallbackAddr
Var /GLOBAL AionUiExtractDone
Var /GLOBAL AionUiExtractTotal
Var /GLOBAL AionUiExtractSwap
Var /GLOBAL AionUiExtractStep
Var /GLOBAL AionUiExtractPos
Var /GLOBAL AionUiExtractLast
Var /GLOBAL AionUiVerifyPos

; Set the install page bar and status line. A no-op until the page has created its bar
; (silent installs, the uninstaller, or when creating the bar failed).
!macro AIONUI_PROGRESS _PERMILLE _ZH _EN
  !ifndef BUILD_UNINSTALLER
    StrCpy $AionUiProgressPos "${_PERMILLE}"
    StrCpy $AionUiProgressZh "${_ZH}"
    StrCpy $AionUiProgressEn "${_EN}"
    Call AionUiSetProgress
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
Function AionUiSetProgress
  ${If} $AionUiProgressBar == ""
  ${OrIf} $AionUiProgressBar == 0
    Return
  ${EndIf}
  SendMessage $AionUiProgressBar 0x0402 $AionUiProgressPos 0 ; PBM_SETPOS
  IntOp $AionUiProgressPercent $AionUiProgressPos / 10
  ${If} $LANGUAGE == 2052
    StrCpy $AionUiProgressMessage "$AionUiProgressZh  $AionUiProgressPercent%"
  ${Else}
    StrCpy $AionUiProgressMessage "$AionUiProgressEn  $AionUiProgressPercent%"
  ${EndIf}
  ${If} $AionUiProgressText != 0
    SendMessage $AionUiProgressText 0x000C 0 "STR:$AionUiProgressMessage" ; WM_SETTEXT
  ${EndIf}
FunctionEnd

; Runs on the page's UI thread, so the new bar belongs to a thread that pumps messages.
Function AionUiShowInstallProgress
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  StrCpy $AionUiProgressBar 0
  FindWindow $0 "#32770" "" $HWNDPARENT
  GetDlgItem $1 $0 1004
  GetDlgItem $AionUiProgressText $0 1006
  ${If} $1 != 0
    System::Call '*(i 0, i 0, i 0, i 0) p .r2'
    System::Call 'user32::GetWindowRect(p r1, p r2)'
    System::Call 'user32::MapWindowPoints(p 0, p r0, p r2, i 2)'
    System::Call '*$2(i .r3, i .r4, i .r5, i .r6)'
    System::Free $2
    IntOp $5 $5 - $3
    IntOp $6 $6 - $4
    ; WS_CHILD | WS_VISIBLE
    System::Call 'user32::CreateWindowExW(i 0, w "msctls_progress32", w "", i 0x50000000, i r3, i r4, i r5, i r6, p r0, p 0, p 0, p 0) p .r2'
    ${If} $2 != 0
      StrCpy $AionUiProgressBar $2
      ShowWindow $1 0 ; SW_HIDE
      SendMessage $AionUiProgressBar 0x0406 0 ${AIONUI_PROGRESS_DONE} ; PBM_SETRANGE32
      !insertmacro AIONUI_PROGRESS 0 "${AIONUI_MSG_PROGRESS_PREPARE_ZH}" "${AIONUI_MSG_PROGRESS_PREPARE_EN}"
    ${EndIf}
  ${EndIf}
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; Nsis7z calls this during extraction with the bytes done and the total.
Function AionUiExtractCallback
  Pop $AionUiExtractDone
  Pop $AionUiExtractTotal
  ; Accept either argument order.
  System::Int64Op $AionUiExtractDone > $AionUiExtractTotal
  Pop $AionUiExtractSwap
  ${If} $AionUiExtractSwap == 1
    StrCpy $AionUiExtractSwap $AionUiExtractDone
    StrCpy $AionUiExtractDone $AionUiExtractTotal
    StrCpy $AionUiExtractTotal $AionUiExtractSwap
  ${EndIf}
  ; 64-bit division: the payload can pass 2 GB, beyond IntOp.
  System::Int64Op $AionUiExtractTotal / ${AIONUI_PROGRESS_EXTRACT_SPAN}
  Pop $AionUiExtractStep
  ${If} $AionUiExtractStep == 0
    Return
  ${EndIf}
  System::Int64Op $AionUiExtractDone / $AionUiExtractStep
  Pop $AionUiExtractPos
  ${If} $AionUiExtractPos > ${AIONUI_PROGRESS_EXTRACT_SPAN}
    StrCpy $AionUiExtractPos ${AIONUI_PROGRESS_EXTRACT_SPAN}
  ${EndIf}
  IntOp $AionUiExtractPos $AionUiExtractPos + ${AIONUI_PROGRESS_EXTRACT_START}
  ${If} $AionUiExtractPos != $AionUiExtractLast
    StrCpy $AionUiExtractLast $AionUiExtractPos
    !insertmacro AIONUI_PROGRESS $AionUiExtractPos "${AIONUI_MSG_PROGRESS_EXTRACT_ZH}" "${AIONUI_MSG_PROGRESS_EXTRACT_EN}"
  ${EndIf}
FunctionEnd
!endif

; Inserted by the build script's patch of electron-builder's extractUsing7za, in place of
; its first Nsis7z::Extract. Same extraction into $OUTDIR, plus progress.
!macro AIONUI_EXTRACT_7Z_WITH_PROGRESS _FILE
  !insertmacro AIONUI_PROGRESS ${AIONUI_PROGRESS_EXTRACT_START} "${AIONUI_MSG_PROGRESS_EXTRACT_ZH}" "${AIONUI_MSG_PROGRESS_EXTRACT_EN}"
  StrCpy $AionUiExtractLast ${AIONUI_PROGRESS_EXTRACT_START}
  GetFunctionAddress $AionUiExtractCallbackAddr AionUiExtractCallback
  Nsis7z::ExtractWithCallback "${_FILE}" $AionUiExtractCallbackAddr
  !insertmacro AIONUI_PROGRESS ${AIONUI_PROGRESS_COPY} "${AIONUI_MSG_PROGRESS_COPY_ZH}" "${AIONUI_MSG_PROGRESS_COPY_EN}"
!macroend

; After the app running check: removing an earlier install, then unpacking the payload.
!macro AIONUI_PROGRESS_BEFORE_PAYLOAD
  !ifndef BUILD_UNINSTALLER
    ${If} ${FileExists} "$INSTDIR\${AIONUI_APP_EXECUTABLE_FILENAME}"
      !insertmacro AIONUI_PROGRESS ${AIONUI_PROGRESS_REMOVE_OLD} "${AIONUI_MSG_PROGRESS_REMOVE_OLD_ZH}" "${AIONUI_MSG_PROGRESS_REMOVE_OLD_EN}"
    ${Else}
      !insertmacro AIONUI_PROGRESS ${AIONUI_PROGRESS_REMOVE_OLD} "${AIONUI_MSG_PROGRESS_UNPACK_ZH}" "${AIONUI_MSG_PROGRESS_UNPACK_EN}"
    ${EndIf}
  !endif
!macroend

; After the payload is in place: the extraction log line, registry and shortcuts follow.
!macro AIONUI_SHOW_REGISTER_PROGRESS
  !insertmacro AIONUI_PROGRESS ${AIONUI_PROGRESS_REGISTER} "${AIONUI_MSG_PROGRESS_REGISTER_ZH}" "${AIONUI_MSG_PROGRESS_REGISTER_EN}"
!macroend

!ifndef BUILD_UNINSTALLER
!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW AionUiShowInstallProgress
!macroend
!endif

!macro AIONUI_BRING_UPDATED_INSTALLER_TO_FRONT
  ${If} ${isUpdated}
    BringToFront
    !insertmacro AIONUI_SLOG "event=updated-installer-foreground action=bring-to-front"
  ${EndIf}
!macroend

!macro AIONUI_WAIT_FOR_UPDATED_APP_EXIT
  ${If} ${isUpdated}
    !insertmacro AIONUI_SLOG "event=updated-app-exit-wait phase=start"
    StrCpy $AionUiUpdatedAppExitWaitResult "0"

    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "& { \
      $$ErrorActionPreference = 'SilentlyContinue'; \
      $$deadline = (Get-Date).AddSeconds(10); \
      $$target = [System.IO.Path]::GetFullPath((Join-Path '$INSTDIR' '${AIONUI_APP_EXECUTABLE_FILENAME}')); \
      do { \
        $$hits = @(Get-CimInstance -ClassName Win32_Process | Where-Object { \
          $$path = $$_.ExecutablePath; \
          if (-not $$path) { $$path = $$_.Path } \
          $$_.Name -ieq '${AIONUI_APP_EXECUTABLE_FILENAME}' -and $$path -and \
          [string]::Equals([System.IO.Path]::GetFullPath($$path), $$target, [System.StringComparison]::CurrentCultureIgnoreCase) \
        }); \
        if ($$hits.Count -eq 0) { exit 0 }; \
        Start-Sleep -Milliseconds 500; \
      } while ((Get-Date) -lt $$deadline); \
      exit 1 \
    }"`
    Pop $AionUiUpdatedAppExitWaitResult

    ${If} $AionUiUpdatedAppExitWaitResult != 0
      !insertmacro AIONUI_SLOG "event=updated-app-exit-wait phase=timeout action=stop"
      !insertmacro AIONUI_STOP_APP_PROCESSES
    ${EndIf}

    !insertmacro AIONUI_SLOG "event=updated-app-exit-wait phase=done result=$AionUiUpdatedAppExitWaitResult"
  ${EndIf}
!macroend

!macro AIONUI_RECORD_ACTIVE_INSTALLER_MARKER
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "& { \
    $$ErrorActionPreference = 'SilentlyContinue'; \
    $$marker = Join-Path $$env:TEMP '${AIONUI_ACTIVE_INSTALLER_MARKER}'; \
    if (-not (Test-Path -LiteralPath $$marker)) { Write-Output 'missing'; exit 0 }; \
    $$item = Get-Item -LiteralPath $$marker; \
    if ($$item.LastWriteTime -lt (Get-Date).AddHours(-2)) { Write-Output 'stale'; exit 0 }; \
    Write-Output 'active' \
  }"`
  Pop $AionUiActiveMarkerExecResult
  Pop $AionUiActiveMarkerResult
  ${If} $AionUiActiveMarkerResult == "active"
    !insertmacro AIONUI_SLOG "event=installer-active-marker state=active"
  ${ElseIf} $AionUiActiveMarkerResult == "stale"
    !insertmacro AIONUI_SLOG "event=installer-active-marker state=stale"
  ${Else}
    !insertmacro AIONUI_SLOG "event=installer-active-marker state=missing"
  ${EndIf}
!macroend

!macro AIONUI_WRITE_ACTIVE_INSTALLER_MARKER
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "& { \
    $$ErrorActionPreference = 'SilentlyContinue'; \
    $$marker = Join-Path $$env:TEMP '${AIONUI_ACTIVE_INSTALLER_MARKER}'; \
    Set-Content -LiteralPath $$marker -Encoding UTF8 -Value ('pid=' + $$PID + ';session=$AionUiSessionId;started=' + (Get-Date -Format o)) \
  }"`
  Pop $AionUiActiveMarkerResult
!macroend

!macro AIONUI_CLEAR_ACTIVE_INSTALLER_MARKER
  !ifndef BUILD_UNINSTALLER
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "& { \
      $$ErrorActionPreference = 'SilentlyContinue'; \
      Remove-Item -LiteralPath (Join-Path $$env:TEMP '${AIONUI_ACTIVE_INSTALLER_MARKER}') -Force \
    }"`
    Pop $AionUiActiveMarkerResult
  !endif
!macroend

!macro AIONUI_OVERRIDE_SINGLE_INSTANCE
!macroend

!macro AIONUI_OVERRIDE_APP_CANNOT_BE_CLOSED_MESSAGE
  !pragma warning disable 6030
  LangString appCannotBeClosed 1033 "${AIONUI_MSG_APP_CANNOT_BE_CLOSED_ZH}$\r$\n$\r$\n${AIONUI_MSG_BLOCK_SEPARATOR}$\r$\n$\r$\n${AIONUI_MSG_APP_CANNOT_BE_CLOSED_EN}"
  LangString appCannotBeClosed 2052 "${AIONUI_MSG_APP_CANNOT_BE_CLOSED_ZH}$\r$\n$\r$\n${AIONUI_MSG_BLOCK_SEPARATOR}$\r$\n$\r$\n${AIONUI_MSG_APP_CANNOT_BE_CLOSED_EN}"
  !pragma warning default 6030
!macroend

!macro AIONUI_INSTALLER_CUSTOM_HEADER
  !insertmacro AIONUI_OVERRIDE_SINGLE_INSTANCE
  !insertmacro AIONUI_OVERRIDE_APP_CANNOT_BE_CLOSED_MESSAGE
!macroend

!macro AIONUI_RELEASE_INSTALL_DIR_OUTDIR
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  StrCpy $AionUiCurrentOutDir "$PLUGINSDIR"
!macroend

; Resolve the machine's real native architecture (arm64 / x64 / x86) for diagnostics.
; Backed by IsWow64Process2 (via x64.nsh), so it reports the true hardware arch even when
; the installer runs under x86/x64 emulation. Replaces the old hardcoded "non-arm64" detail.
!macro AIONUI_DETECT_NATIVE_ARCH _OUT
  ${If} ${IsNativeARM64}
    StrCpy ${_OUT} "arm64"
  ${ElseIf} ${RunningX64}
    StrCpy ${_OUT} "x64"
  ${Else}
    StrCpy ${_OUT} "x86"
  ${EndIf}
!macroend

!macro AIONUI_INSTALLER_PREINIT
  !ifdef BUILD_UNINSTALLER
    StrCpy $AionUiSessionId ""
    StrCpy $AionUiIsUpdated "0"
    StrCpy $AionUiSessionLogResult ""
    StrCpy $AionUiSessionLogPath "$TEMP\${AIONUI_FALLBACK_LOG}"
    StrCpy $AionUiUninstallHadErrors "0"
    StrCpy $AionUiUninstallLogResult ""
    StrCpy $AionUiVerifyResourceResult ""
    StrCpy $AionUiUpdatedAppExitWaitResult ""
    StrCpy $AionUiActiveMarkerExecResult ""
    StrCpy $AionUiActiveMarkerResult ""
    StrCpy $AionUiStopResult ""
    StrCpy $AionUiLockerListZh ""
    StrCpy $AionUiLockerListEn ""
  !else
    !insertmacro AIONUI_RELEASE_INSTALL_DIR_OUTDIR
    !insertmacro AIONUI_SESSION_BEGIN
    !insertmacro AIONUI_SLOG "event=installer-outdir-release outDir=$AionUiCurrentOutDir instDir=$INSTDIR"
    ; Guard target/machine architecture as early as possible: this runs before customInit's
    ; registry heal/clear/repair, so a wrong-arch installer aborts without mutating an existing
    ; correct-arch install's registry or uninstaller state. (Sentry ELECTRON-3BX / code E1040)
    !insertmacro AIONUI_ASSERT_TARGET_ARCH
    !insertmacro AIONUI_BRING_UPDATED_INSTALLER_TO_FRONT
    !insertmacro AIONUI_RECORD_ACTIVE_INSTALLER_MARKER
    !insertmacro AIONUI_WRITE_ACTIVE_INSTALLER_MARKER
  !endif
!macroend

!macro AIONUI_VERIFY_REQUIRED_FILE _PATH _LABEL
  ${IfNot} ${FileExists} "${_PATH}"
    !insertmacro AIONUI_LOG_EVENT "verify-required-file missing label=${_LABEL} path=${_PATH}"
    !insertmacro AIONUI_FAIL_UX \
      "${AIONUI_E_CORE_APP_FILES_INCOMPLETE}" \
      "verify-required-file missing label=${_LABEL} path=${_PATH}" \
      "${AIONUI_MSG_VERIFY_REQUIRED_FILE_ZH} ${_LABEL}" \
      "${AIONUI_MSG_VERIFY_REQUIRED_FILE_EN} ${_LABEL}" \
      "${AIONUI_MSG_VERIFY_REQUIRED_FILE_ACTION_ZH}" \
      "${AIONUI_MSG_VERIFY_REQUIRED_FILE_ACTION_EN}" \
      "verify-required-file missing label=${_LABEL} path=${_PATH}" \
      "verify-required-file missing label=${_LABEL} path=${_PATH}"
  ${Else}
    !insertmacro AIONUI_LOG_EVENT "verify-required-file ok label=${_LABEL} path=${_PATH}"
  ${EndIf}
  IntOp $AionUiVerifyPos $AionUiVerifyPos + ${AIONUI_PROGRESS_VERIFY_STEP}
  !insertmacro AIONUI_PROGRESS $AionUiVerifyPos "${AIONUI_MSG_PROGRESS_VERIFY_ZH}" "${AIONUI_MSG_PROGRESS_VERIFY_EN}"
!macroend

!macro AIONUI_VERIFY_CORE_APP_FILES
  StrCpy $AionUiVerifyPos ${AIONUI_PROGRESS_VERIFY}
  !insertmacro AIONUI_PROGRESS $AionUiVerifyPos "${AIONUI_MSG_PROGRESS_VERIFY_ZH}" "${AIONUI_MSG_PROGRESS_VERIFY_EN}"
  !insertmacro AIONUI_LOG_EVENT "verify-install start instDir=$INSTDIR"
  !insertmacro AIONUI_VERIFY_REQUIRED_FILE "$INSTDIR\Woody.exe" "Woody.exe"
  !insertmacro AIONUI_VERIFY_REQUIRED_FILE "$INSTDIR\ffmpeg.dll" "ffmpeg.dll"
  !insertmacro AIONUI_VERIFY_REQUIRED_FILE "$INSTDIR\libEGL.dll" "libEGL.dll"
  !insertmacro AIONUI_VERIFY_REQUIRED_FILE "$INSTDIR\libGLESv2.dll" "libGLESv2.dll"
  !insertmacro AIONUI_VERIFY_REQUIRED_FILE "$INSTDIR\d3dcompiler_47.dll" "d3dcompiler_47.dll"
  !insertmacro AIONUI_VERIFY_REQUIRED_FILE "$INSTDIR\dxcompiler.dll" "dxcompiler.dll"
  !insertmacro AIONUI_VERIFY_REQUIRED_FILE "$INSTDIR\dxil.dll" "dxil.dll"
  !insertmacro AIONUI_VERIFY_REQUIRED_FILE "$INSTDIR\vk_swiftshader.dll" "vk_swiftshader.dll"
  !insertmacro AIONUI_VERIFY_REQUIRED_FILE "$INSTDIR\vulkan-1.dll" "vulkan-1.dll"
  !insertmacro AIONUI_VERIFY_REQUIRED_FILE "$INSTDIR\resources\app.asar" "resources\app.asar"
!macroend

!macro AIONUI_VERIFY_BUNDLED_AIONCORE_RESOURCES _RUNTIME_KEY
  !insertmacro AIONUI_PROGRESS ${AIONUI_PROGRESS_VERIFY_CORE} "${AIONUI_MSG_PROGRESS_VERIFY_CORE_ZH}" "${AIONUI_MSG_PROGRESS_VERIFY_CORE_EN}"
  InitPluginsDir
  File "/oname=$PLUGINSDIR\verify-bundled-aioncore-install.ps1" "${PROJECT_DIR}\resources\windows\support\verify-bundled-aioncore-install.ps1"
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\verify-bundled-aioncore-install.ps1" -InstallDir "$INSTDIR" -RuntimeKey "${_RUNTIME_KEY}" -LogPath "$AionUiSessionLogPath"`
  Pop $AionUiVerifyResourceResult

  ${If} $AionUiVerifyResourceResult != 0
    !insertmacro AIONUI_FAIL_UX \
      "${AIONUI_E_BUNDLED_AIONCORE_INCOMPLETE}" \
      "event=session-end result=fail code=${AIONUI_E_BUNDLED_AIONCORE_INCOMPLETE} detail=bundled-aioncore-incomplete runtime=${_RUNTIME_KEY} result=$AionUiVerifyResourceResult" \
      "${AIONUI_MSG_BUNDLED_AIONCORE_INCOMPLETE_ZH}" \
      "${AIONUI_MSG_BUNDLED_AIONCORE_INCOMPLETE_EN}" \
      "${AIONUI_MSG_BUNDLED_AIONCORE_INCOMPLETE_ACTION_ZH}" \
      "${AIONUI_MSG_BUNDLED_AIONCORE_INCOMPLETE_ACTION_EN}" \
      "bundled-aioncore-incomplete runtime=${_RUNTIME_KEY} result=$AionUiVerifyResourceResult instDir=$INSTDIR" \
      "bundled-aioncore-incomplete runtime=${_RUNTIME_KEY} result=$AionUiVerifyResourceResult instDir=$INSTDIR"
  ${EndIf}
!macroend

!macro customInstall
  !insertmacro AIONUI_VERIFY_CORE_APP_FILES
  !insertmacro AIONUI_VERIFY_BUNDLED_AIONCORE_RESOURCES "${AIONUI_RUNTIME_KEY}"
  !insertmacro AIONUI_LOG_EVENT "verify-install ok instDir=$INSTDIR"
  !insertmacro AIONUI_CLEAR_ACTIVE_INSTALLER_MARKER
  !insertmacro AIONUI_SESSION_SUCCESS
  !insertmacro AIONUI_PROGRESS ${AIONUI_PROGRESS_DONE} "${AIONUI_MSG_PROGRESS_DONE_ZH}" "${AIONUI_MSG_PROGRESS_DONE_EN}"
!macroend

!endif
