'use strict'

const { parentPort } = require('node:worker_threads')

parentPort.on('message', () => {
  // Deliberately never replies: simulates a locked/slow Secret Service.
})
