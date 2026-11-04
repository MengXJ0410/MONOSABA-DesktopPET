@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo [错误] 找不到 npm，请先安装 Node.js 20+。
  pause
  exit /b 1
)

if not exist "node_modules\electron" (
  echo [提示] 还没有安装依赖。
  echo 请先在本目录运行：npm install
  pause
  exit /b 1
)

:choose
echo.
echo ==========================================
echo   MONOSABA DesktopPET 打包
echo ==========================================
echo   首次打开时默认显示：
echo     [1] 希罗（黑红）
echo     [2] 艾玛（白粉）
echo.
set "CHOICE="
set /p "CHOICE=请输入 1 或 2（直接回车默认 1）："
if not defined CHOICE set "CHOICE=1"
set "CHOICE=%CHOICE: =%"

if "%CHOICE%"=="1" (
  set "VITE_DEFAULT_CHARACTER=hiro"
  set "DEFAULT_NAME=希罗"
  goto build
)
if "%CHOICE%"=="2" (
  set "VITE_DEFAULT_CHARACTER=ema"
  set "DEFAULT_NAME=艾玛"
  goto build
)

echo 无效选择，请重新输入。
goto choose

:build
echo.
echo 正在打包，默认人物：%DEFAULT_NAME%
echo 注意：只影响首次启动；已经使用过的电脑会保留上次选择。
echo.
if not defined ELECTRON_MIRROR set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
if not defined ELECTRON_BUILDER_BINARIES_MIRROR set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
if not defined NODE_OPTIONS (set "NODE_OPTIONS=--use-system-ca") else (set "NODE_OPTIONS=%NODE_OPTIONS% --use-system-ca")
if "%VITE_DEFAULT_CHARACTER%"=="ema" (
  echo exe 图标：艾玛
) else (
  echo exe 图标：希罗
)
echo.
call npm run build:win
if errorlevel 1 goto failed

echo.
echo ==========================================
echo   打包完成
echo ==========================================
dir /b "dist\*-portable.exe" >nul 2>nul
if not errorlevel 1 (
  dir /b "dist\*-portable.exe"
) else (
  echo 没找到 portable exe，请检查 dist 目录。
)
echo.
echo 输出目录：%CD%\dist
pause
exit /b 0

:failed
echo.
echo [失败] 打包没有完成，请查看上面的错误信息。
pause
exit /b 1
