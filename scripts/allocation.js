#!/usr/bin/env node
'use strict';

const { main } = require('./lib/allocation/commands');

main().then(code => { process.exitCode = code; }).catch(() => {
  // Native errors and private task material must never reach this fallback.
  process.stderr.write('ECC allocation could not finish recording its result.\n');
  process.exitCode = 4;
});
