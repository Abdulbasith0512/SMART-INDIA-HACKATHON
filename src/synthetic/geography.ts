// Deterministic SYNTHETIC Odisha geography for development and tests.
// District and block names are real public place names, but administrative codes (SYN-...), the
// two localities per block, weights and everything else are fictional. NOT authoritative LGD data.
import { deterministicUuid } from "./prng";
import type { RegionType } from "../lib/supabase/database.types";

export interface SyntheticRegion {
  id: string;
  name: string;
  name_local: Record<string, string>;
  region_type: RegionType;
  parent_region_id: string | null;
  administrative_code: string;
  is_synthetic: true;
  active: true;
}

interface BlockSpec { code: string; name: string; weight: number }
interface DistrictSpec {
  code: string;
  name: string;
  local: { hi: string; or: string };
  blocks: BlockSpec[];
}

const DISTRICTS: DistrictSpec[] = [
  {
    code: "KHO", name: "Khordha", local: { hi: "खोर्धा", or: "ଖୋର୍ଦ୍ଧା" },
    blocks: [
      { code: "BAL", name: "Balianta", weight: 1.0 },
      { code: "BLP", name: "Balipatna", weight: 0.9 },
      { code: "BAN", name: "Banapur", weight: 0.8 },
      { code: "JAT", name: "Jatni", weight: 1.6 },
    ],
  },
  {
    code: "CTC", name: "Cuttack", local: { hi: "कटक", or: "କଟକ" },
    blocks: [
      { code: "ATH", name: "Athagarh", weight: 1.0 },
      { code: "BAR", name: "Baramba", weight: 0.6 },
      { code: "NIA", name: "Niali", weight: 0.8 },
      { code: "TAN", name: "Tangi-Choudwar", weight: 1.0 },
    ],
  },
  {
    code: "PUR", name: "Puri", local: { hi: "पुरी", or: "ପୁରୀ" },
    blocks: [
      { code: "BRA", name: "Brahmagiri", weight: 0.8 },
      { code: "KAK", name: "Kakatpur", weight: 0.7 },
      { code: "NIM", name: "Nimapara", weight: 1.1 },
      { code: "SAT", name: "Satyabadi", weight: 1.0 },
    ],
  },
  {
    code: "GAN", name: "Ganjam", local: { hi: "गंजाम", or: "ଗଞ୍ଜାମ" },
    blocks: [
      { code: "ASK", name: "Aska", weight: 1.2 },
      { code: "BHA", name: "Bhanjanagar", weight: 1.0 },
      { code: "CHH", name: "Chhatrapur", weight: 1.3 },
      { code: "DIG", name: "Digapahandi", weight: 0.9 },
    ],
  },
];

export const COUNTRY_CODE = "SYN-IN";
export const STATE_CODE = "SYN-OD";

const rid = (code: string) => deterministicUuid("jansanket-region", code);

export interface SyntheticBlock {
  region: SyntheticRegion;
  weight: number;
  districtCode: string;
  localityIds: string[];
}

export interface SyntheticGeography {
  regions: SyntheticRegion[]; // parents always precede children
  blocks: SyntheticBlock[];
  byCode: Map<string, SyntheticRegion>;
}

export function generateGeography(): SyntheticGeography {
  const regions: SyntheticRegion[] = [];
  const blocks: SyntheticBlock[] = [];
  const mk = (
    code: string, name: string, type: RegionType, parent: string | null, local: Record<string, string> = {},
  ): SyntheticRegion => {
    const r: SyntheticRegion = {
      id: rid(code), name, name_local: local, region_type: type,
      parent_region_id: parent, administrative_code: code, is_synthetic: true, active: true,
    };
    regions.push(r);
    return r;
  };

  const country = mk(COUNTRY_CODE, "India", "country", null, { hi: "भारत", or: "ଭାରତ" });
  const state = mk(STATE_CODE, "Odisha", "state", country.id, { hi: "ओडिशा", or: "ଓଡ଼ିଶା" });

  for (const d of DISTRICTS) {
    const district = mk(`${STATE_CODE}-${d.code}`, d.name, "district", state.id, d.local);
    for (const b of d.blocks) {
      const block = mk(`${STATE_CODE}-${d.code}-${b.code}`, b.name, "block", district.id);
      const localityIds = ["A", "B"].map((suffix, i) =>
        mk(`${STATE_CODE}-${d.code}-${b.code}-L${i + 1}`, `${b.name} Locality ${suffix}`, "locality", block.id).id,
      );
      blocks.push({ region: block, weight: b.weight, districtCode: d.code, localityIds });
    }
  }
  return { regions, blocks, byCode: new Map(regions.map((r) => [r.administrative_code, r])) };
}
