@echo off
setlocal
set "PY=%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
if not exist "%PY%" set "PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not exist "%PY%" set "PY=python"
"%PY%" "%~dp0native_host.py"
