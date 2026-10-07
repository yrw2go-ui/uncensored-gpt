@echo off
rem Starts the LoRA Studio local trainer on http://127.0.0.1:8676
cd /d "%~dp0"
set PY=ai-toolkit\venv\Scripts\python.exe
if not exist %PY% set PY=python
%PY% server.py --toolkit ai-toolkit %*
