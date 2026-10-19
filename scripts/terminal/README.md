# Native runtime verification

Use the **target Electron executable**, not the build host's Node executable:

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& .\node_modules\electron\dist\electron.exe .\scripts\terminal\verifyNative.cjs . 'C:\Program Files\PowerShell\7\pwsh.exe'
```

For a packaged build, run `out\win-unpacked\Woody.exe` and pass the absolute path
of `out\win-unpacked\resources\app.asar` as the module root. The script actually
loads SerialPort, enumerates ports, starts a PTY shell, and verifies a variable
persists across separate command inputs. It does not open a real serial device.
Remove `ELECTRON_RUN_AS_NODE` before launching the normal desktop application.
