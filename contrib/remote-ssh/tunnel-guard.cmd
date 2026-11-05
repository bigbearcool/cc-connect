@echo off
rem Optional reverse tunnel for contrib/remote-ssh (Windows host).
rem remote 127.0.0.1:%REMOTE_PORT% -> this host 127.0.0.1:%LOCAL_PROXY_PORT% (your local HTTP proxy). Reconnects forever.
rem Usage: set SSH_HOST=devbox & set LOCAL_PROXY_PORT=7890 & tunnel-guard.cmd
rem Hide the window / autostart it with Task Scheduler (see README.md).
if "%SSH_HOST%"=="" echo set SSH_HOST & exit /b 2
if "%LOCAL_PROXY_PORT%"=="" echo set LOCAL_PROXY_PORT & exit /b 2
if "%REMOTE_PORT%"=="" set "REMOTE_PORT=17897"
:loop
echo [%date% %time%] tunnel: connecting %SSH_HOST%
C:\Windows\System32\OpenSSH\ssh.exe -N -T -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=20 -o ServerAliveCountMax=3 -o ConnectTimeout=10 -R 127.0.0.1:%REMOTE_PORT%:127.0.0.1:%LOCAL_PROXY_PORT% %SSH_HOST%
echo [%date% %time%] tunnel: exited code %errorlevel%, retry in 10s
timeout /t 10 /nobreak >nul
goto loop
