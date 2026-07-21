// Frozen at Phase 0B. Any breaking change to a schema in this package bumps
// the major version and requires architecture-lead approval (STAFFING.md).
export const CONTRACTS_VERSION = "1.4.0"; // 1.4: EXECUTION E3 proxied model inference (additive)
export const PROTOCOL_VERSION = 1;

// V2 is introduced alongside the frozen legacy surface. Consumers opt into
// V2-prefixed schemas; legacy protocol and schema exports remain unchanged.
export const V2_CONTRACTS_VERSION = "2.0.0";
export const V2_PROTOCOL_VERSION = 2;
