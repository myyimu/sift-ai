@echo off
rem =====================================================================
rem Sift native messaging host launcher (ADR-002, approved 2026-08-26).
rem
rem Chrome launches this file via CreateProcess (cmd.exe /c) when the
rem Sift extension calls chrome.runtime.connectNative. The only job of
rem this wrapper is to set ELECTRON_RUN_AS_NODE=1 so that Sift.exe runs
rem as a plain Node process loading resources\host-main.js, where the
rem real native host loop lives (packages/host contract, unchanged).
rem
rem Why a wrapper at all: the packaged exe's GUI (Chromium) bootstrap
rem unconditionally writes 2 junk bytes (0d 0a) to stdout BEFORE any
rem user code runs, which corrupts the length-prefixed frame stream.
rem Under ELECTRON_RUN_AS_NODE the stdio is byte-clean (validated by
rem the E-03 spike, evidence in ADR-002).
rem
rem Hard constraints (do not relax):
rem   - ASCII only: cmd.exe parses this file in an OEM code page; any
rem     non-ASCII byte can break line structure (empirically confirmed).
rem   - Every path fully double-quoted ("%~dp0..." expands with the
rem     trailing backslash included).
rem   - Fail closed: host-main.js self-validates origin + --parent-window
rem     + non-TTY stdio and exits non-zero on mismatch. This wrapper
rem     never validates anything itself and never writes to stdout.
rem   - cmd.exe writes nothing to the stdout pipe (verified: the byte
rem     stream reaching the browser is exactly the host's frames).
rem Exit code: the last command's exit code propagates to Chrome.
rem =====================================================================
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0Sift.exe" "%~dp0resources\host-main.js" %*
