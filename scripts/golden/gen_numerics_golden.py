"""Generates src/detection/__fixtures__/numerics.golden.json from scipy.

OFFLINE DEV TOOL ONLY. Not a runtime dependency and not run in CI: the committed JSON is the fixture.
Run: python scripts/golden/gen_numerics_golden.py
"""
import json
from pathlib import Path

from scipy import stats
from scipy.special import gammaln

out = {"generator": "scipy", "poisson_sf": [], "negbin_sf": [], "normal_isf": [], "gammaln": []}

# P(X >= k) for Poisson(mu) == scipy poisson.sf(k - 1, mu)
for k, mu in [(1, 0.1), (3, 0.5), (5, 0.8), (5, 2.0), (6, 2.0), (9, 1.09), (13, 1.92), (14, 2.79), (20, 8.7),
              (27, 11.4), (40, 3.2), (8, 40.0), (100, 60.0), (2, 0.01), (12, 0.5)]:
    out["poisson_sf"].append({"k": k, "mu": mu, "sf": float(stats.poisson.sf(k - 1, mu))})

# P(X >= k) for NB(r, q) == scipy nbinom(n=r, p=q).sf(k - 1)
for k, r, q in [(5, 0.5, 0.5), (5, 3.5, 0.8), (9, 12.25, 0.7), (13, 6.0, 0.9), (4, 0.07, 0.99), (20, 40.0, 0.6),
                (7, 2.5, 0.3), (1, 1.0, 0.5), (30, 15.5, 0.75), (6, 9.9, 0.88)]:
    out["negbin_sf"].append({"k": k, "r": r, "q": q, "sf": float(stats.nbinom(r, q).sf(k - 1))})

# z with upper tail p
for p in [0.5, 0.1, 0.05, 0.01, 1e-3, 1e-4, 1e-6, 1e-9, 1e-12, 1e-20]:
    out["normal_isf"].append({"p": p, "z": float(stats.norm.isf(p))})

for x in [0.1, 0.5, 1.0, 2.5, 7.3, 20.0, 150.5]:
    out["gammaln"].append({"x": x, "v": float(gammaln(x))})

dest = Path(__file__).resolve().parents[2] / "src" / "detection" / "__fixtures__" / "numerics.golden.json"
dest.parent.mkdir(parents=True, exist_ok=True)
dest.write_text(json.dumps(out, indent=2) + "\n")
print("wrote", dest)
