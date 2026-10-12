'use strict';

class AllocationError extends Error {
  constructor(code, exitCode, safeMessage) {
    super(safeMessage);
    this.name = 'AllocationError';
    this.code = code.startsWith('ECC_ALLOCATION_') ? code : `ECC_ALLOCATION_${code}`;
    this.exitCode = exitCode;
  }
}

function fail(code, message, exitCode = 2) { throw new AllocationError(code, exitCode, message); }

module.exports = { AllocationError, fail };
