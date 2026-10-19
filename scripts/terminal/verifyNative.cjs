'use strict';

// Run with Electron in RUN_AS_NODE mode to exercise its real native-module ABI.
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(process.argv[2] || '.');
const shell = process.argv[3] || 'powershell.exe';
const load = createRequire(path.join(root, 'package.json'));

async function verify() {
  const { SerialPort } = load('serialport');
  const ports = await SerialPort.list();
  const pty = load('node-pty');
  const terminal = pty.spawn(shell, ['-NoLogo', '-NoProfile'], {
    cwd: process.cwd(),
    env: process.env,
    cols: 100,
    rows: 25,
    ...(process.platform === 'win32' ? { useConptyDll: true } : {}),
  });
  let output = '';
  let phase = 0;
  let timer;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Persistent Shell validation timed out')), 20000);
      terminal.onExit(({ exitCode }) => reject(new Error(`Shell exited before verification (${exitCode})`)));
      terminal.onData((data) => {
        output += data;
        if (phase === 1 && output.includes('WOODY_FIRST=42')) {
          phase = 2;
          output = '';
          terminal.write('Write-Output ("WOODY_SECOND=" + ($global:woodyNativeCheck + 1))\r');
        } else if (phase === 2 && output.includes('WOODY_SECOND=43')) {
          resolve();
        }
      });
      phase = 1;
      terminal.write('$global:woodyNativeCheck=42; Write-Output ("WOODY_FIRST=" + $global:woodyNativeCheck)\r');
    });
    console.log(
      JSON.stringify(
        {
          ok: true,
          electron: process.versions.electron || null,
          node: process.versions.node,
          moduleRoot: root,
          serialNativeLoaded: true,
          ports: ports.map((port) => port.path),
          persistentShell: true,
          shell,
        },
        null,
        2
      )
    );
  } finally {
    clearTimeout(timer);
    terminal.kill();
  }
}
verify().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
