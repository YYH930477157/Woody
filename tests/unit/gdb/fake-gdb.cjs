'use strict';
const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  const match = /^(\d+)(.*)$/.exec(line);
  if (!match) return;
  const [, token, command] = match;
  if (command === '-hang') return;
  if (command === '-bad') process.stdout.write(`${token}^error,msg="No symbol found"\n`);
  else if (command === '-overflow') process.stdout.write('x'.repeat(300000));
  else if (command === '-exec-run')
    process.stdout.write(`${token}^running\n*stopped,reason="breakpoint-hit",frame={func="main"}\n`);
  else if (command === '-slow') setTimeout(() => process.stdout.write(`${token}^done,value="slow"\n`), 40);
  else process.stdout.write(`${token}^done,value="42"\n`);
});
