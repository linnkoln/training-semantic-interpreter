'use strict';

// Internal empty state for tests of the current runtime storage contract.
// The user-facing oracle is in docs/testing/reference-data.
function legacyEmptyRuleLog() {
    return { version: 0, updatedAt: null, entries: [] };
}

module.exports = { legacyEmptyRuleLog };
