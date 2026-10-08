// Public surface of the M4.4 evidence bundle.
export { buildBundle } from "./build";
export type { BuildInput, SignalIdentity } from "./build";
export { bundleHashOf, canonicalBundleJson, snakeKeys, HASH_EXCLUDED_FIELDS } from "./canonical";
export { FALLBACK_OPENING, FALLBACK_VERSION, FORBIDDEN_FALLBACK_WORDING, ownWording, renderExtractive, validateFallback } from "./fallback";
export type { CitationMetadata, ExtractiveFallback, MetadataResolver, RenderedFallback } from "./fallback";
export { buildBundleForSignal, bundleSignal } from "./pipeline";
export { loadCitationMetadata, loadSignalIdentity, loadStoredBundle, mirrorTargets, persistBundle, plannedItems, verifyStoredBundle } from "./persist";
export type { PersistResult, VerifyReport } from "./persist";
export { FACET_LABEL, SYNDROME_LABEL, whyRelevant } from "./reasons";
export { BUNDLE_SCHEMA_VERSION } from "./types";
export type { BundleItem, EvidenceBundle } from "./types";
