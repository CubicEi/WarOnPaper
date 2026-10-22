; Optional removal of per-user data on uninstall (NSIS).
!macro customUnInstall
  MessageBox MB_YESNO|MB_ICONQUESTION "同时删除 WarOnPaper 用户数据（%APPDATA%\WarOnPaper）？$\n$\n包含昵称与本地身份缓存。" IDNO skip_wop_data
  RmDir /r "$APPDATA\WarOnPaper"
  skip_wop_data:
!macroend
