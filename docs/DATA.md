# Data and scientific scope

This release contains the complete SpecTree v7 candidate library and its stored simulated test readings. It does not claim a v7 experimental test-set accuracy.

| Item | Coverage |
| --- | --- |
| Candidate compounds | 105,328 |
| Questions | 645: MS 330, IR 16, proton NMR 168, carbon NMR 131 |
| Molecule chunks | 106; 1,000 entries each except the final 328 |
| Stored path-tree states | 1,524,318 |
| Stored path-tree edges | 1,524,317 |
| Terminal states | 105,327; one state includes two identical complete reading histories |
| Maximum path depth | 60 |

## Provenance

The library is derived from PubChemLite. Compound IDs, names, formulae, and SMILES come from the supplied v7 library. Identifier-only names are retained; common names are not guessed. A structure depiction is generated locally from that record's SMILES.

The model metadata records the source build as **2026-10-29 18:29**. Its decompressed SHA-256 is:

`725bab536a9054bf01a8d13867fe39800ef30e72097a3879635c333b7fe666cb`

The full tree binary SHA-256 is:

`236675cdf51c0250d6f200dec5356528a821e87c47a2c9659638b5f316bea846`

Inspect `v7_map/data/meta.json` for question wording, answer options, units, model settings, layout, and provenance. Inspect `v7_map/data/path_tree_all/schema.json` and `validation.json` for the tree schema and independent export audit.

## What the demonstrations mean

Each example uses its stored noisy test-stream draw 0. Choosing another example loads another existing reading; it does not run a new chemical simulation. The example's source compound and the model's predicted leader are separate identities and may disagree.

Mass plots show stored m/z and relative-intensity peaks. Proton NMR plots show signal centers with integral, multiplicity, and coupling tables. Carbon NMR plots show stored peak positions at equal display heights. IR is shown as categorical band observations, not a continuous measured spectrum.

The supplied caffeine example reaches caffeine as leader after 17 answers with about 99.97% model probability under all-techniques evidence. This is one reproducible example, not a population accuracy estimate.

## Limits

- Model probabilities are not measured experimental accuracy or a calibration study.
- The candidate library may not include a real unknown. The best library match does not prove identity.
- The full path view covers stored readings, not all possible noisy answer combinations.
- The model's spectra do not establish stereochemical configuration such as distinguishing enantiomers.
- The 75,706-compound fit cohort is separate from the 105,328-compound candidate library.
- Source records are preserved even when a supplied name, formula, or structure has a discrepancy.

The existing independent tree audit checked 2,240,592 original answer edges, all 106 source chunks, and 25 canonical traces. These are software and export-consistency checks. They do not establish experimental identification performance.
