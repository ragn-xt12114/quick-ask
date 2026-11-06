/**
 * Current database schema version.
 *
 * Kept in a dependency-free module so `tools/seed-history.mjs` can import it
 * through Node 24 type stripping without pulling in the migration runtime.
 * Keep in sync with the highest entry in `MIGRATIONS`; a unit test enforces it.
 */
export const SCHEMA_VERSION = 2
