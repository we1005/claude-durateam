/** Public state-store surface for the scheduler/doctor integration. */
export {
  SqliteStateStore,
  StateStoreError,
  StoreOwnershipError,
  STATE_SCHEMA_VERSION,
  assertStateFilePath,
} from "./sqlite.js";
export type {
  ArtifactRecordInput,
  GateRecord,
  OwnerInfo,
  SqliteStateStoreOptions,
  StateStoreErrorCode,
  StoredArtifact,
  StoredEvent,
} from "./sqlite.js";
