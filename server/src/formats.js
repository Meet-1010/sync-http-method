'use strict';

// Patch formats and the choice of an update live in shared/ so that the client can
// compute patches for writes with the same code.
module.exports = require('../../shared/formats');
