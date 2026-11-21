@echo off
setlocal EnableDelayedExpansion

REM ============================================================
REM  Animation Editor - start server and open browser
REM ============================================================

cd /d "%~dp0"

set "SERVER_JS=server.js"
set "PORT_FILE=port.txt"
set "LOG_FILE=server.log"
set "HOST=http://localhost:"

title Animation Editor

echo.
echo  ============================================
echo   Animation Editor
echo  ============================================
echo.

if not exist "%SERVER_JS%" (
    echo  [ERROR] %SERVER_JS% not found in:
    echo          %CD%
    echo.
    pause
    exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
    echo  [ERROR] Node.js not found in PATH.
    echo          Install: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

REM --- clean previous state ---
if exist "%PORT_FILE%" del "%PORT_FILE%" >nul 2>nul
if exist "%LOG_FILE%"  del "%LOG_FILE%"  >nul 2>nul

echo  [i] Starting server...
start "Animation Editor Server" cmd /c "cd /d ""%~dp0"" && node ""%SERVER_JS%"" > ""%LOG_FILE%"" 2>&1"

echo  [i] Waiting for server to be ready...
set /a WAIT_COUNT=0

:WAIT_LOOP
set /a WAIT_COUNT+=1
if !WAIT_COUNT! GTR 40 (
    echo.
    echo  [ERROR] Server did not start within 20 seconds.
    echo          See "%LOG_FILE%" for details.
    echo.
    if exist "%LOG_FILE%" (
        echo  ---- server.log ----
        type "%LOG_FILE%"
        echo  -------------------
        echo.
    )
    pause
    exit /b 1
)

REM ~500ms sleep via timeout (portable, no ping / no chcp issues)
timeout /t 1 /nobreak >nul 2>&1

if not exist "%PORT_FILE%" goto :WAIT_LOOP

set /p PORT=<"%PORT_FILE%"
if "!PORT!"=="" goto :WAIT_LOOP

set "URL=%HOST%!PORT!/"

echo  [+] Server started on port !PORT!.
echo.
echo  [i] Opening !URL!
start "" "!URL!"

exit /b 0