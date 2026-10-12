'use strict';

const { createAllocationStore } = require('../../../scripts/lib/state-store');
let store;
process.exitCode = 1;
process.on('message', async message => {
  try {
    if (message.action === 'open') store = await createAllocationStore({ dbPath: message.dbPath });
    else if (message.action === 'claim') store.claimInitial(message.input);
    else if (message.action === 'launch') store.claimOperationLaunch(message.input);
    else throw new Error('Unknown fixture action.');
    if (process.connected) process.send({ id: message.id, ok: true });
  } catch (error) {
    if (process.connected) process.send({ id: message.id, ok: false, code: error.code || 'ERROR' });
  }
});
process.on('disconnect', () => {
  if (store) store.close(); process.exitCode = 0;
});
process.send({ ready: true });
