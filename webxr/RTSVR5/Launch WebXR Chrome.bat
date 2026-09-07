@echo off
REM Dedicated Chrome user-data-dir + --no-sandbox for instant PCVR enterVR.
REM Safe to use while normal Chrome is still open (separate process).
cd /d "%~dp0"
node launch-webxr-profile.mjs %*
if errorlevel 2 pause
