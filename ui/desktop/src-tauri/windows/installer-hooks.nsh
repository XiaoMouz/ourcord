!macro OurCordStopService
  Push $0
  Push $1
  StrCpy $1 30
  ${Do}
    nsExec::Exec /TIMEOUT=5000 '"$SYSDIR\sc.exe" stop OurCordDaemon'
    Pop $0
    ${If} $0 == 1060 ; service does not exist
    ${OrIf} $0 == 1062 ; service is already stopped
      ${ExitDo}
    ${EndIf}
    ${If} $0 != 0
    ${AndIf} $0 != 1061 ; service cannot yet accept another control
      SetErrorLevel 1
      Abort "Could not stop OurCordDaemon (sc.exe returned $0)."
    ${EndIf}
    IntOp $1 $1 - 1
    ${If} $1 == 0
      SetErrorLevel 1
      Abort "Timed out waiting for OurCordDaemon to stop."
    ${EndIf}
    Sleep 1000
  ${Loop}
  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro OurCordStopService
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Push $0
  nsExec::ExecToLog '"$INSTDIR\binaries\ourcord-service.exe" --configure-service'
  Pop $0
  ${If} $0 != 0
    SetErrorLevel 1
    Abort "Could not configure or start OurCordDaemon ($0)."
  ${EndIf}
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro OurCordStopService
  Push $0
  nsExec::ExecToLog '"$SYSDIR\sc.exe" delete OurCordDaemon'
  Pop $0
  ${If} $0 != 0
  ${AndIf} $0 != 1060 ; service does not exist
  ${AndIf} $0 != 1072 ; service is already marked for deletion
    SetErrorLevel 1
    Abort "Could not delete OurCordDaemon (sc.exe returned $0)."
  ${EndIf}
  Pop $0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
