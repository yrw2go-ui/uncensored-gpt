@echo off
rem Installs ostris/ai-toolkit next to this script for LoRA Studio local training.
rem Needs: git, Python 3.10+ (3.12 recommended), an NVIDIA GPU with recent drivers.
setlocal
cd /d "%~dp0"
if "%TORCH_INDEX%"=="" set TORCH_INDEX=https://download.pytorch.org/whl/cu130
if not exist ai-toolkit git clone --depth 1 https://github.com/ostris/ai-toolkit.git || goto :error
cd ai-toolkit
git submodule update --init --recursive || goto :error
if not exist venv python -m venv venv || goto :error
call venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install --no-cache-dir torch torchvision torchaudio --index-url %TORCH_INDEX% || goto :error
pip install -r requirements.txt || goto :error
echo.
echo Done. Start the trainer with start.bat
echo For FLUX.1 [dev], also run: ai-toolkit\venv\Scripts\huggingface-cli login
pause
exit /b 0
:error
echo Setup failed. See the error above.
pause
exit /b 1
