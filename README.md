# SpecTree Explorer

SpecTree identifies small molecules from mass spectrometry, FTIR, ¹H NMR and ¹³C NMR. At each step it asks the spectral question that best separates the leading candidates, and it stops once one structure passes 99.9% probability.

This repository is a static, browser-only build of the SpecTree v7 model:

- **Guided demo** (`v7_map/?demo`) walks through identifying caffeine (PubChem CID 2519) in 17 questions. Any library compound works with `v7_map/?cid=<CID>`.
- **Model map** (`v7_map/`) is an interactive Cytoscape.js network of all 645 questions, the model components, and the 105,328-compound library.
- **Decision-path atlas** (`v7_map/paths.html`) is a radial tree of 1,524,318 decision states covering every library compound's stored reading.

## Run locally

Any static file server works, for example:

```bash
python -m http.server 8000
```

Then open <http://localhost:8000/>. Opening `index.html` directly from disk does not work, because the model loads in a web worker.

## Host on GitHub Pages

Settings → Pages → Deploy from branch → `main` / root. The `.nojekyll` file keeps the data folders served as-is.

## Data and limits

The demo readings are simulated spectra generated for each library compound (test-stream draw 0). They are not new experimental measurements. Probabilities are model outputs, not a calibration study. The candidate library is derived from PubChemLite.

## Third-party code

- [Cytoscape.js](https://js.cytoscape.org/) 3.33.1, MIT (`v7_map/vendor/CYTOSCAPE-LICENSE`)
- [SmilesDrawer](https://github.com/reymond-group/smilesDrawer) 1.2.0, MIT (`v7_map/vendor/SMILES-DRAWER-LICENSE`)
