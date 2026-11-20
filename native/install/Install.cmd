@echo off
"%~dp0engine\runtime\node.exe" "%~dp0installer.mjs" install %*
if errorlevel 1 (
  echo If the ONNX Runtime dependency is missing, install the official Microsoft x64 runtime then retry.
  echo https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist
)
pause
