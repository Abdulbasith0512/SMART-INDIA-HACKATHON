# M4.1 - Evidence corpus, sanitiser, trust rules and ingestion

Scope of this milestone: how evidence gets INTO the system safely. Retrieval, ranking, bundles and any LLM use are
later milestones (M4.2+) and are deliberately absent. Nothing here changes M1-M3 or the frozen M3 detector.

Evidence is **data**. It is never an instruction to the system, the detector or a model.

## 1. What exists

| Piece | Where | Purpose |
|---|---|---|
| Synthetic development corpus | `data/evidence/corpus/docs/*.json` (60 documents, 148 chunks) | Fictional documents that exercise every filter, status, class and failure path. Generated from `src/evidence/devcorpus/specs.ts`. |
| Manifest + corpus hash | `data/evidence/corpus/manifest.json` | Deterministic record of every document's effective status, hashes and scan result. |
| Sanitiser | `src/evidence/ingest/sanitize.ts` | Turns any input into inert plain text. |
| Injection scanner | `src/evidence/ingest/inject.ts` | Quarantines text that tries to instruct a reader or model. |
| Trust rules | `src/evidence/ingest/trust.ts` | Categorical source trust and fail-closed effective status. |
| Document format | `src/evidence/ingest/document.ts` | Strict schema; keeps synthetic documents unmistakably synthetic. |
| Chunker | `src/evidence/ingest/chunk.ts` | The chunk is the unit of retrieval and of citation. |
| Ingestion engine | `src/evidence/ingest/ingest.ts` | Idempotent, store-agnostic, runs against Supabase and PGlite. |
| SSRF-safe fetcher | `src/evidence/net/fetcher.ts` (+ `url.ts`, `ip.ts`) | Curator-run retrieval of allow-listed real sources. |
| Link checker | `src/evidence/net/linkcheck.ts` | Detects changed or missing sources and quarantines them. |
| Allow-list | `data/evidence/allowlist.json` | **Ships empty.** A curator adds domains deliberately. |
| Migration | `supabase/migrations/20261007070000_m4_1_source_hash.sql` | Adds `evidence_versions.source_hash` (additive; M1-M3 untouched). |

## 2. The synthetic corpus is not evidence

Every development document is fictional: the publisher contains "Synthetic", the citation starts with `SYNTHETIC`,
URLs use the reserved `.invalid` TLD, the licence says "SYNTHETIC", and each abstract is labelled
`[SYNTHETIC TEST DOCUMENT]`. The schema **rejects** a synthetic document that names a real-looking publisher, URL,
licence or fetched-source hash, and rejects a real document that uses a reserved host. No real WHO/ICMR/NCDC (or any
other) document, URL, citation or licence is included, imitated or implied.

The corpus covers: all eight issuer classes, all six evidence kinds, all five geography levels, English/Hindi/Odia,
every lifecycle status (current, superseded + its successor, withdrawn, historical, draft, quarantined), an expired
current document, a conflicting pair, a near-duplicate and an exact-duplicate, two keyword-stuffed distractors, and
eight adversarial fixtures that the scanner must quarantine. The Hindi and Odia samples exercise tokenisation and
metadata only; **no native speaker has reviewed them** and no translation quality is claimed.

Because the corpus, its queries and its judgments are written by the same team, results on it show that the
pipeline works and stays safe, **not** that retrieval or summaries will be good on real evidence.

## 3. Safety properties (each is a test)

1. **Plain text only.** The sanitiser removes markup, `<script>`/`<style>`/`<iframe>`/`<svg>` blocks, comments, hidden
   elements, control characters, zero-width and bidirectional controls, Unicode tag characters, variation selectors and
   private-use characters; decodes entities and re-strips what they reveal; normalises to NFC. It is idempotent and
   its output always satisfies the database CHECK constraints (fuzzed with 2,000 inputs, and 300 more pushed through
   the real constraints).
2. **Concealment is a signal.** Hidden elements, bidi controls, tag characters and heavy invisible-character use
   quarantine a document outright; what was hidden is scanned too.
3. **Declarations cannot raise safety.** A document declared `current` and `trusted` is still quarantined if the
   scanner blocks it. Unverified or unreviewed sources never become `current`.
4. **Real sources need three things:** an allow-listed domain whose entry permits the document's class, a recorded
   `source_content_hash`, and a curator review. Missing any one leaves the document `draft` with trust `unreviewed`.
5. **Idempotent and immutable.** Re-running changes nothing. Changed content is a **new version** (new
   `version_label` required); history is kept; reusing a label for different content, or reverting to older content,
   is refused. Chunks and version content are immutable in the database.
6. **The database wins once an item exists.** Ingestion may lower trust or quarantine; it never raises trust or
   releases a quarantine unless the curator passes `--release`. `withdrawn` is terminal. `is_synthetic` is immutable.
7. **Nothing is deleted.** There is no delete path in ingestion.
8. **Reproducible.** The corpus hash is the SHA-256 of the canonical manifest. It covers every document, the
   effective decisions and the sanitiser/scanner/trust-rule versions, and is independent of file order. A golden hash
   is pinned in `manifest.test.ts`; changing any document or rule changes it and requires a deliberate update.

## 4. Network fetcher (curator tool, never reachable from the browser)

HTTPS only, standard port, no credentials, DNS names only (no IP literals in any encoding), host must be on the
allow-list. DNS is resolved once per hop and **every** answer must be a public unicast address; the socket then
connects to that exact validated address (SNI/Host carry the name), so DNS rebinding cannot swap in a private one.
Blocked: loopback, private, link-local (incl. cloud metadata), CGNAT, multicast, reserved, documentation, Teredo,
6to4/NAT64 embeddings of blocked IPv4, IPv4-mapped IPv6, ULA, and anything unparseable. Redirects are manual (max 3),
re-validated per hop, https only, and must stay inside the same allow-list entry. Limits: status 200, `text/html`,
`text/plain` or `application/xhtml+xml`, no `Content-Encoding` (zip-bomb defence), 2 MB, 15 s total. There is no
"allow private" switch. Tests inject a fake DNS and transport; **no test opens a socket and no real site was contacted.**

The browser build cannot import any of this (an isolation test enforces it).

## 5. Link checking

`npm run evidence:linkcheck` re-fetches real sources and compares the sanitised-source hash with the stored
`source_hash`. Changed content (or content that now trips the scanner), HTTP 404/410, a domain that left the
allow-list, or a redirect off-domain -> **quarantine** (`--apply`). Ambiguous failures (403/429/5xx, DNS or network
errors) are only **reported**, because they may be transient. Synthetic documents are skipped.

## 6. Commands

```
npm run evidence:build                      render docs/*.json + manifest.json from the generator
npm run evidence:build -- --check           fail if committed files drift from the generator
npm run evidence:verify                     offline checks (no DB, no network)
npm run evidence:ingest -- --dry-run        show what would change
npm run evidence:ingest                     apply (service role); records a corpus snapshot only if DB == manifest
npm run evidence:ingest -- --activate       also mark that snapshot active
npm run evidence:ingest -- --release        curator override: raise trust / release quarantined items
npm run evidence:fetch -- <https-url>       fetch ONE allow-listed source; prints hash, scan verdict and a preview
npm run evidence:linkcheck [-- --apply]     check real sources
npm run verify:m41                          live end-to-end check (ingests, checks, then removes everything it created)
```

## 7. Adding a real document (curator procedure; deferred - nothing real is shipped)

1. Add the publisher's domain to `data/evidence/allowlist.json` with the issuer classes you accept for it.
2. `npm run evidence:fetch -- <url>`; read the scanner verdict; copy `source_content_hash`.
3. Author a document file: curator-written abstract and short **verbatim** excerpts (not the full text), the correct
   `source_class`, `licence`, `verification_basis`, `curator_reviewed`, and the source hash. Verify licence terms
   yourself; the tooling does not.
4. `npm run evidence:build -- --check` is for the synthetic corpus only; for real documents use
   `npm run evidence:ingest -- --dry-run`, then ingest.

## 8. Known limits (stated, not hidden)

- The injection scanner is a heuristic first line of defence, not a guarantee. It is English-centric; one
  best-effort Hindi override pattern is included **without native review**; Odia injection phrasing is **not
  covered**. It will over-quarantine some legitimate text (e.g. "do not ignore the guidelines"). Real defences are
  structural: plain-text-only storage, evidence passed as data, constrained JSON output and deterministic validators
  (M4.5), and human review.
- Zero-width joiners are legitimate in some Indic conjuncts but are disallowed by the M4.0 database constraint, so the
  sanitiser removes them (counted separately; may alter rendering of rare conjuncts).
- Text such as `a < b and c > d` can look like a tag to the database constraint and is stripped by the sanitiser.
- `canonical_id` is unique per document **edition** by ingestion convention (the schema has no unique index);
  editions are linked by `supersedes`. Conflict tagging (same-question / position) is not stored yet and will need an
  additive migration in M4.3.
- The 60-document corpus is smaller than the ~300-chunk figure in the plan (148 chunks); enough to exercise every path.
- Link checking and fetching were fixture-tested only; behaviour against real servers (TLS, odd headers, rate
  limits) is unverified until a curator runs them.
- Live ingestion of the synthetic corpus into the shared project is exercised and cleaned up by `verify:m41`; the
  persistent live ingest is planned for M4.8.
