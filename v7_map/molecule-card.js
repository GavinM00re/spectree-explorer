/* Depict the selected compound from its unchanged v7 SMILES and library name. */
(function (global) {
  "use strict";

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function fragmentImage(smiles) {
    return new Promise((resolve, reject) => {
      const canvas = document.createElement("canvas");
      canvas.width = 600; canvas.height = 440;
      // The existing v7 renderer needs a layout box to size its drawing canvas.
      canvas.style.cssText = "position:fixed;left:-10000px;top:0;width:600px;height:440px;pointer-events:none";
      canvas.setAttribute("aria-hidden", "true");
      document.body.append(canvas);
      const fail = error => { canvas.remove(); reject(error); };
      try {
        const drawer = new global.SmilesDrawer.Drawer({width:600, height:440, padding:32, bondThickness:1.4});
        global.SmilesDrawer.parse(smiles, tree => {
          try {
            drawer.draw(tree, canvas, "light", false);
            const {width, height} = canvas;
            const pixels = canvas.getContext("2d").getImageData(0, 0, width, height).data;
            let x0 = width, y0 = height, x1 = -1, y1 = -1;
            for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
              if (pixels[4 * (y * width + x) + 3] > 0) {
                x0 = Math.min(x0, x); x1 = Math.max(x1, x);
                y0 = Math.min(y0, y); y1 = Math.max(y1, y);
              }
            }
            canvas.remove();
            if (x1 < 0) throw new Error("No structure could be drawn.");
            resolve({canvas, x:x0, y:y0, width:x1-x0+1, height:y1-y0+1});
          } catch (error) { fail(error); }
        }, fail);
      } catch (error) { fail(error); }
    });
  }

  async function drawStructure(smiles, canvas) {
    if (!global.SmilesDrawer) throw new Error("Structure renderer unavailable.");
    if (!smiles) throw new Error("No structure supplied.");
    // Render every disconnected component, including any supplied counterions.
    const fragments = await Promise.all(smiles.split(".").map(fragmentImage));
    const columns = Math.ceil(Math.sqrt(fragments.length)), rows = Math.ceil(fragments.length / columns);
    const cellWidth = canvas.width / columns, cellHeight = canvas.height / rows, padding = 18;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    fragments.forEach((part, i) => {
      const scale = Math.min((cellWidth-2*padding)/part.width, (cellHeight-2*padding)/part.height, 3);
      const width = part.width * scale, height = part.height * scale;
      ctx.drawImage(part.canvas, part.x, part.y, part.width, part.height,
        (i%columns)*cellWidth+(cellWidth-width)/2, Math.floor(i/columns)*cellHeight+(cellHeight-height)/2, width, height);
    });
  }

  function mount(host, {k, library}) {
    if (!host || !Number.isInteger(k) || k < 0 || k >= library.id.length) return;
    const cid = String(library.id[k]), suppliedName = String(library.name[k] || "").trim();
    const name = suppliedName || `CID ${cid}`, smiles = String(library.smiles[k] || "").trim();
    const identifierOnly = !suppliedName || /^\d{2,7}-\d{2}-\d$/.test(suppliedName) || /^CID\s*\d+$/i.test(suppliedName);
    const card = element("section", "molecule-card");
    card.setAttribute("aria-label", "Selected molecule");
    card.append(element("div", "molecule-eyebrow", "SELECTED MOLECULE"));
    card.append(element("strong", "molecule-name", name));
    card.append(element("small", "molecule-identity", `${library.formula[k] || "Formula unavailable"} · CID ${cid}`));
    if (identifierOnly) card.append(element("p", "molecule-name-note", "A common name is not supplied in this library."));

    const frame = element("div", "molecule-structure");
    const canvas = element("canvas", "molecule-canvas");
    canvas.width = 480; canvas.height = 340;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", `Molecular structure of ${name}, PubChem CID ${cid}, from the v7 SMILES`);
    canvas.hidden = true;
    const status = element("p", "molecule-render-status", "Drawing structure…");
    status.setAttribute("role", "status");
    frame.append(canvas, status); card.append(frame);
    card.append(element("small", "molecule-source", "Name and structure supplied by the v7 library"));

    const details = element("details", "molecule-smiles");
    details.append(element("summary", "", "SMILES"), element("code", "", smiles || "No SMILES supplied."));
    card.append(details); host.replaceChildren(card);
    drawStructure(smiles, canvas).then(() => {
      if (!host.contains(card)) return;
      canvas.hidden = false; status.hidden = true;
      card.dataset.structureStatus = "ready";
    }).catch(() => {
      if (!host.contains(card)) return;
      canvas.hidden = true; status.textContent = "Structure preview unavailable. The stored SMILES is shown below.";
      details.open = true; card.dataset.structureStatus = "unavailable";
    });
    return card;
  }

  global.SpecTreeMolecule = {mount};
})(window);
