'use strict';

const primitives = require('./validation-primitives');
const evidence = require('./evidence-validation');

module.exports = {
  ...require('./policy-validation'), ...require('./operation-validation'),
  ...evidence, canonicalDigest: primitives.canonicalDigest, normalizeIdentity: primitives.identity,
};
