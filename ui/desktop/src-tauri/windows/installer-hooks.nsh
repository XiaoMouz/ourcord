!macro NSIS_HOOK_PREINSTALL
  nsExec::ExecToLog 'sc.exe stop OurCordDaemon'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  nsExec::ExecToLog 'sc.exe create OurCordDaemon binPath= "$INSTDIR\\binaries\\ourcord-service.exe" start= delayed-auto DisplayName= "OurCord Network Service"'
  nsExec::ExecToLog 'sc.exe failure OurCordDaemon reset= 86400 actions= restart/5000/restart/15000/restart/60000'
  nsExec::ExecToLog 'sc.exe start OurCordDaemon'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog 'sc.exe stop OurCordDaemon'
  nsExec::ExecToLog 'sc.exe delete OurCordDaemon'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
