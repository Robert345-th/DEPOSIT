@echo off
REM ============================================================
REM  Zambike Gold Bot - Auto Start Script (minimized windows)
REM ============================================================

echo Starting real account MT5 (minimized)...
start /min "" "C:\Program Files\MetaTrader 5 EXNESS\terminal64.exe"

echo Starting demo account MT5 (minimized)...
start /min "" "C:\Users\user\Desktop\MetaTrader 5 EXNESS demo\terminal64.exe"

echo Waiting 25 seconds for both MT5 terminals to fully load...
timeout /t 25 /nobreak

echo Starting REAL account bot (minimized window, stays open)...
start /min "Zambike Real Bot" cmd /k python "C:\TradingBots\zambike_gold_bot_real.py"

echo Starting DEMO account bot (minimized window, stays open)...
start /min "Zambike Demo Bot" cmd /k python "C:\TradingBots\zambike_gold_bot_demo.py"

exit
