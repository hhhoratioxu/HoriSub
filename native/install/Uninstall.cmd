@echo off
if not "%~1"=="" goto arguments
choice /C YN /N /M "Also delete downloaded HoriSub models? [Y/N] "
if errorlevel 2 goto keep
"%~dp0engine\runtime\node.exe" "%~dp0installer.mjs" uninstall --purge-models
goto done
:keep
"%~dp0engine\runtime\node.exe" "%~dp0installer.mjs" uninstall
goto done
:arguments
"%~dp0engine\runtime\node.exe" "%~dp0installer.mjs" uninstall %*
:done
pause
