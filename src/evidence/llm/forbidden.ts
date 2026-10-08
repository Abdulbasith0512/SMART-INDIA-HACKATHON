// Deterministic forbidden-content scanner: the SECURITY BOUNDARY for model output.
//
// The prompt asks the model not to diagnose, not to confirm outbreaks, not to give advice and not to follow instructions
// found in passages. None of that is trusted: every model-authored string (statement text, uncertainty, missing-evidence
// note) is scanned here, and every anchor quote is scanned for steering content. The rules are deliberately CONSERVATIVE:
// they will sometimes refuse harmless wording (the retry and then the extractive fallback exist for exactly that), and
// they are not a proof that no harmful sentence can be phrased - they are one layer of a defence that also requires
// verbatim anchors and supported numbers and names. Rules are plain regular expressions over a folded text (NFKC, lower
// case, invisible characters removed) so obfuscation by zero-width characters or compatibility forms does not hide a word.
import { foldForScan, hasHiddenCharacters, hasNonLatinLetters } from "./normalize";
import type { FailureCategory } from "./types";

export interface Finding {
  rule: string;
  category: FailureCategory;
}

/** Disease and pathogen names. A statement may mention one only if its own anchors do, and never as the signal's cause. */
export const DISEASE_TERMS = [
  "cholera", "typhoid", "paratyphoid", "dysentery", "shigell\\w*", "salmonell\\w*", "campylobacter\\w*", "giardia\\w*", "amoeb\\w*", "rotavirus\\w*",
  "norovirus\\w*", "e\\.? ?coli", "escherichia", "hepatitis(?: [a-e])?", "dengue", "malaria", "chikungunya", "zika", "measles", "rubella", "mumps",
  "varicella", "chickenpox", "smallpox", "monkeypox", "mpox", "influenza", "flu", "covid\\S*", "coronavirus\\w*", "sars", "mers", "tuberculosis", "tb",
  "pneumonia", "pertussis", "whooping cough", "diphtheria", "polio\\w*", "meningitis", "meningococc\\w*", "leptospiros\\w*", "scrub typhus",
  "rickettsi\\w*", "nipah", "ebola", "anthrax", "plague", "rabies", "tetanus", "brucellosis", "encephalitis", "leishmaniasis", "kala-azar", "filariasis",
  "scabies", "legionell\\w*", "listeri\\w*", "cryptosporidi\\w*", "hantavirus\\w*", "lassa", "marburg", "yellow fever",
] as const;
const DISEASE = `(?:${DISEASE_TERMS.join("|")})`;
/** Outbreak vocabulary, treated as terminology that must be supported by anchors. */
export const OUTBREAK_WORDS = "outbreaks?|epidemics?|pandemics?";
const OB = `(?:${OUTBREAK_WORDS})`;
export const DISEASE_RE = new RegExp(`\\b${DISEASE}\\b`, "g");
export const OUTBREAK_RE = new RegExp(`\\b${OB}\\b`, "g");

const SENT = "[^.!?;\\n]"; // stays inside one sentence

interface Rule {
  id: string;
  category: FailureCategory;
  re: RegExp;
  /** Also applied to anchor quotes (steering content). Medical and wording rules apply to model-authored text only. */
  anchors?: boolean;
  /** Applied to the original (not folded) text, because case or exact characters matter. */
  raw?: boolean;
}
const rx = (source: string, flags = ""): RegExp => new RegExp(source, flags);

const RULES: Rule[] = [
  // ---- steering: instructions, roles, tools, code, secrets (the model was hijacked, or is trying to act) ----
  { id: "override.ignore-instructions", category: "forbidden_instruction_override", anchors: true, re: rx(`\\b(?:ignore|disregard|forget|override|bypass|skip)\\b${SENT}{0,40}\\b(?:previous|prior|above|earlier|preceding|all|any|your|these|those|the)\\b${SENT}{0,30}\\b(?:instructions?|prompts?|rules?|guidelines?|directives?|messages?|context|constraints?|safeguards?)\\b`) },
  { id: "override.new-instructions", category: "forbidden_instruction_override", anchors: true, re: rx("\\b(?:new|updated|revised|real|actual|hidden) (?:system )?(?:instructions?|orders?|directives?)\\b") },
  { id: "override.persona", category: "forbidden_instruction_override", anchors: true, re: rx("\\b(?:from now on|you are now|you will now|you must now|act as (?:a|an|if)|acting as (?:a|an)|pretend (?:to be|that|you)|role-?play|jailbreak|developer mode|do anything now|dan mode)\\b") },
  { id: "role.line-start", category: "forbidden_role_manipulation", anchors: true, re: rx("(?:^|[.!?]\\s+)(?:system|assistant|developer|human)\\s*:") },
  { id: "role.system-message", category: "forbidden_role_manipulation", anchors: true, re: rx("\\b(?:system|developer) (?:message|prompt|instructions?|role)\\b") },
  { id: "role.chat-tokens", category: "forbidden_role_manipulation", anchors: true, re: rx("<\\s*\\|?\\s*(?:im_start|im_end|system|user|assistant|endoftext|eot_id|start_header_id|end_header_id)\\b[^>]*>|\\[/?inst\\]|<</?sys>>|#{2,}\\s*(?:system|instruction|human|assistant)\\b") },
  { id: "tool.markup", category: "forbidden_tool_call", anchors: true, re: rx("<\\s*/?\\s*(?:tool_calls?|tool_use|tool_result|function_calls?|invoke|functions?|antml[:\\w-]*)\\b") },
  { id: "tool.names", category: "forbidden_tool_call", anchors: true, re: rx("\\b(?:function_call|tool_calls?|tool_use|tool_choice)\\b") },
  { id: "tool.json", category: "forbidden_tool_call", anchors: true, re: rx('"\\s*(?:name|tool|function)\\s*"\\s*:\\s*"[^"]{1,60}"\\s*,\\s*"\\s*(?:arguments|parameters|args|input)\\s*"') },
  { id: "tool.call-request", category: "forbidden_tool_call", anchors: true, re: rx("\\b(?:call|invoke|use|run|execute|trigger)\\s+(?:the\\s+|a\\s+|this\\s+)?(?:tool|function|plugin|web ?search|browser|search engine)\\b") },
  { id: "code.fence", category: "forbidden_code_execution", anchors: true, re: rx("```|~~~") },
  { id: "code.script", category: "forbidden_code_execution", anchors: true, re: rx("<\\s*script\\b|javascript:|\\bon(?:error|load|click)\\s*=") },
  { id: "code.call", category: "forbidden_code_execution", anchors: true, re: rx("\\b(?:eval|exec|popen|spawn|subprocess|child_process|require|__import__)\\(|\\bsystem\\(") },
  { id: "code.shell", category: "forbidden_code_execution", anchors: true, re: rx("\\b(?:rm\\s+-rf|sudo\\s|chmod\\s|wget\\s|curl\\s+-|powershell|cmd\\.exe|bash\\s+-c|npm\\s+install|pip\\s+install|import\\s+(?:os|sys|subprocess)\\b|os\\.system)") },
  { id: "code.run-request", category: "forbidden_code_execution", anchors: true, re: rx(`\\b(?:run|execute|launch)\\b${SENT}{0,30}\\b(?:code|script|command|commands|shell|program|binary|payload)\\b`) },
  { id: "secret.request", category: "forbidden_secret_request", anchors: true, re: rx(`\\b(?:reveal|show|print|output|display|leak|share|send|exfiltrat\\w*|disclose|repeat|tell me)\\b${SENT}{0,40}\\b(?:system prompt|your instructions|hidden instructions|api[ _-]?keys?|secrets?|passwords?|credentials?|tokens?|private keys?|environment variables?)\\b`) },
  { id: "secret.material", category: "forbidden_secret_request", anchors: true, re: rx("\\b(?:api[_ -]?key|secret[_ -]?key|service[_ -]?role|anon[_ -]?key|bearer\\s+[a-z0-9._-]{8,}|sk-[a-z0-9]{10,}|aiza[a-z0-9_-]{20,}|eyj[a-z0-9_-]{10,})") },

  // ---- links, markup, encoded payloads (nothing the system did not render itself may appear) ----
  { id: "url.scheme", category: "forbidden_url", anchors: true, re: rx("\\b(?:https?|ftp|file|sftp|ssh):/{1,2}|\\bwww\\.|\\bdata:[a-z]+/") },
  { id: "url.domain", category: "forbidden_url", anchors: true, re: rx("\\b[a-z0-9][a-z0-9-]*(?:\\.[a-z0-9-]+)*\\.(?:com|org|net|gov|edu|int|info|io|co|in|uk|ly|me|xyz|ru|cn|app|dev|ai|biz|tk)\\b(?:/\\S*)?") },
  { id: "markdown.inline-link", category: "forbidden_markdown_link", anchors: true, re: rx("\\[[^\\]]*\\]\\([^)]*\\)") },
  { id: "markdown.reference-link", category: "forbidden_markdown_link", anchors: true, re: rx("\\[[^\\]]+\\]\\s*\\[[^\\]]*\\]|^\\s*\\[[^\\]]+\\]:\\s*\\S+|<(?:https?|mailto):[^>]+>") },
  { id: "image.markup", category: "forbidden_image", anchors: true, re: rx("!\\[[^\\]]*\\]|<\\s*img\\b|\\bdata:image/") },
  { id: "html.tag", category: "forbidden_html", anchors: true, re: rx("<\\s*/?\\s*[a-z][a-z0-9-]*(?:\\s[^>]*)?/?\\s*>") },
  { id: "blob.base64", category: "forbidden_encoded_blob", anchors: true, raw: true, re: rx("[A-Za-z0-9+/]{40,}={0,2}") },
  { id: "blob.hex", category: "forbidden_encoded_blob", anchors: true, raw: true, re: rx("\\b[0-9a-fA-F]{32,}\\b") },
  { id: "blob.mention", category: "forbidden_encoded_blob", anchors: true, re: rx("\\b(?:base64|rot13|hex-encoded|decode (?:this|the following))\\b") },

  // ---- outbreak confirmation (the system never says a signal is real) ----
  { id: "outbreak.assert-verb", category: "forbidden_outbreak_confirmation", re: rx(`\\b(?:confirm\\w*|prov(?:e|es|ed|en|ing)|establish(?:ed|es)?|declar\\w*)\\b${SENT}{0,60}\\b(?:${OB}|real|genuine)\\b`) },
  { id: "outbreak.assert-state", category: "forbidden_outbreak_confirmation", re: rx(`\\b${OB}\\b${SENT}{0,60}\\b(?:confirm\\w*|prov(?:e|es|ed|en)|established|declared|underway|ongoing|occurring|taking place|real|genuine)\\b`) },
  { id: "outbreak.there-is", category: "forbidden_outbreak_confirmation", re: rx(`\\b(?:there (?:is|are|was|were|has been|have been)|this (?:is|constitutes|represents)|these (?:are|constitute)|we (?:have|are (?:facing|seeing))|it (?:is|was))\\b${SENT}{0,20}\\b(?:outbreak|epidemic|pandemic)\\b`) },
  { id: "outbreak.signal-is-real", category: "forbidden_outbreak_confirmation", re: rx(`\\b(?:signal|cluster|reports?|alarm)\\b${SENT}{0,20}\\b(?:is|are)\\b${SENT}{0,10}\\b(?:real|true|genuine|confirmed|valid|verified|substantiated)\\b|\\bnot (?:a )?(?:false alarm|false positive)\\b|\\b(?:confirmed|verified|validated) (?:signal|cluster|cases?|event)\\b|\\bcases? (?:are|were|have been) confirmed\\b`) },

  // ---- diagnosis and disease causation ----
  { id: "diagnosis.word", category: "forbidden_diagnosis", re: rx("\\bdiagnos\\w*|\\bdifferential\\b|\\bprognos\\w*") },
  { id: "diagnosis.patient", category: "forbidden_diagnosis", re: rx("\\bpatients?\\b") },
  { id: "diagnosis.cue-then-disease", category: "forbidden_diagnosis", re: rx(`\\b(?:likely|probably|possibly|presumably|suspected|suspect|consistent with|compatible with|suggestive of|suggests?|indicates?|indicative of|points? to|represents?|caused by|due to|diagnosed|confirmed|positive for|attributable to|source of|cause of|explained by|reveals?|cases? of|outbreak of|epidemic of|infection with|infected with|suffering from|ill with)\\b${SENT}{0,40}\\b${DISEASE}\\b`) },
  { id: "diagnosis.this-is-disease", category: "forbidden_diagnosis", re: rx(`\\b(?:this|these|the (?:signal|cluster|reports?|illness|cases?|pattern|increase))\\b${SENT}{0,25}\\b(?:is|are|was|were)\\b${SENT}{0,25}\\b${DISEASE}\\b`) },

  // ---- treatment, medical and response advice ----
  { id: "treatment.terms", category: "forbidden_treatment_advice", re: rx("\\b(?:treat(?:s|ed|ing|ment|ments)?|therap\\w*|medicat\\w*|medicines?|drugs?|prescri\\w*|dos(?:e|es|age|ing)|antibiotics?|antimicrobials?|antivirals?|antidiarrh\\w*|oral rehydration|ors|rehydrat\\w*|vaccin\\w*|immuni[sz]\\w*|cures?|cured|curative|remed(?:y|ies)|tablets?|capsules?|syrup|paracetamol|ibuprofen|zinc|hospitali[sz]\\w*|admitted|quarantin\\w*|isolat(?:e|es|ed|ing|ion)|chlorinat\\w*|disinfect\\w*|sanitis\\w*|evacuat\\w*|lockdown|clos(?:e|ed|ing|ure) (?:the |all )?(?:schools?|markets?|wells?|facilit\\w+|borders?)|boil(?:ed|ing)? (?:the )?water)\\b") },
  { id: "overclaim.certainty", category: "forbidden_overclaim", re: rx("\\b(?:prov(?:es|ed|en)|definitive(?:ly)?|conclusive(?:ly)?|undoubted(?:ly)?|certainly|with certainty|guarantee[sd]?|without (?:a )?doubt|beyond (?:a )?doubt|clearly shows?|obviously|undeniabl\\w+|irrefutabl\\w+)\\b") },

  // ---- instructions addressed to the reader ----
  { id: "instruction.second-person", category: "forbidden_instruction", re: rx("\\b(?:you|your|yours|yourself|we|our|ours|let's|lets)\\b") },
  { id: "instruction.imperative", category: "forbidden_instruction", re: rx("(?:^|[.!?;:]\\s+)(?:please\\s+)?(?:ensure|make sure|isolate|quarantine|close|shut|dispatch|deploy|notify|alert|issue|declare|start|begin|initiate|give|administer|prescribe|treat|boil|chlorinate|disinfect|vaccinate|avoid|use|take|call|contact|verify|report|investigate|check|review|do not|don't|never|always|remember|note that|consider|ask|tell|send|collect|inform|advise|recommend|follow|proceed|go|stay|keep|wash|drink|eat|seek)\\b") },
];

// "should / must / recommended" is acceptable only as REPORTED speech about a source ("the guidance states that ... should ...").
const ADVICE_MODAL = rx("\\b(?:should|must|ought to|need to|needs to|have to|has to|is advised to|are advised to|advis(?:e|ed|es) (?:that|to)|recommend\\w*|urge\\w*|require[sd]? (?:that|to))\\b");
const ATTRIBUTION = rx("\\baccording to\\b|\\b(?:the |this |these |both |each )?(?:guidance|guidelines?|documents?|sources?|passages?|protocols?|definitions?|case definitions?|reports?|texts?|references?|manuals?|polic(?:y|ies)|standards?)\\b[^.!?;\\n]{0,30}\\b(?:states?|say|says|describes?|specif\\w+|notes?|lists?|defines?|provides?|outlines?|explains?|requires?|advises?|recommends?)\\b");
// Causal connectives: allowed only when the point's own anchors use the same connective (the source says it, not the model).
const CAUSAL = /\b(?:caus(?:e|es|ed|ing|al|ality)|because|due to|owing to|result(?:s|ed|ing)? (?:from|in)|lead(?:s|ing)? to|led to|attribut\w+|responsible for|trigger(?:s|ed)?|contribut\w+ to|stems? from|arises? from|as a result of|therefore|hence|consequently|thus|explains?|explained by|implies|implying|so that)\b/g;

const CITATION_TOKEN = /\[e\d+\]/g;

export interface ScanContext {
  /** Folded text of this point's own anchors; enables the source-bound exceptions (causal wording). */
  anchorText?: string;
}

function run(rules: readonly Rule[], folded: string, original: string): Finding[] {
  const out: Finding[] = [];
  for (const r of rules) if (r.re.test(r.raw ? original : folded)) out.push({ rule: r.id, category: r.category });
  return out;
}

/** Scan a model-authored string (statement text, uncertainty or missing-evidence note). */
export function scanModelText(text: string, ctx: ScanContext = {}): Finding[] {
  const findings: Finding[] = [];
  if (hasHiddenCharacters(text)) findings.push({ rule: "unicode.hidden", category: "hidden_unicode" });
  if (hasNonLatinLetters(text)) findings.push({ rule: "unicode.non-latin", category: "non_english_text" });
  const folded = foldForScan(text).replace(CITATION_TOKEN, " ");
  findings.push(...run(RULES, folded, text));
  if (ADVICE_MODAL.test(folded) && !ATTRIBUTION.test(folded)) findings.push({ rule: "instruction.advice-modal", category: "forbidden_instruction" });
  const anchors = ctx.anchorText ?? "";
  for (const m of folded.matchAll(CAUSAL)) {
    if (!anchors.includes(m[0])) {
      findings.push({ rule: "causal.not-in-source", category: "unsupported_causal_claim" });
      break;
    }
  }
  return findings;
}

/** Scan an anchor quote. Anchors are evidence text, so only steering and markup rules apply (a quote may contain medical words). */
export function scanAnchor(quote: string): Finding[] {
  const folded = foldForScan(quote).replace(CITATION_TOKEN, " ");
  return run(RULES.filter((r) => r.anchors), folded, quote);
}

/** Every rule id, for tests and the mutation report. */
export const RULE_IDS: readonly string[] = [...RULES.map((r) => r.id), "instruction.advice-modal", "causal.not-in-source", "unicode.hidden", "unicode.non-latin"];
export const SCAN_RULE_COUNT = RULES.length;
