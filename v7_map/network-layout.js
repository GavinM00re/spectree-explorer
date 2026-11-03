"use strict";

// Deterministic, dependency-free positions for the real v7 associations.
// Cytoscape owns rendering, panning, zooming, selection and viewport fitting.
(function (global) {
  const TECH = {
    IR: {name: "Infrared", label: "IR", color: "#d79a38", x: -390, y: -340},
    MS: {name: "Mass spectrometry", label: "MS", color: "#4b8ddb", x: 370, y: -320},
    "1H": {name: "Proton NMR", label: "¹H NMR", color: "#e46b67", x: 420, y: 340},
    "13C": {name: "Carbon NMR", label: "¹³C NMR", color: "#a77dde", x: -210, y: 420},
  };
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
  const LIBRARY_COLOR = "#4ab7a5";
  const CORE_COLOR = "#9eacba";
  const LIBRARY_CENTER = {x: -650, y: 20};
  const SECTIONS = [
    {id: "library", label: "Compound library", x: -650, y: 20},
    {id: "model", label: "Learned answer model", x: -115, y: -155},
    {id: "observation", label: "Observed answer", x: -180, y: 70},
    {id: "router", label: "Next-question selection", x: 100, y: 145},
    {id: "posterior", label: "Probability update", x: 10, y: -5},
    {id: "stop", label: "Stopping check", x: 160, y: -70},
    {id: "bank", label: "Question bank", x: -90, y: 180},
    {id: "fit", label: "Model fitting", x: 65, y: -220},
    {id: "output", label: "Ranked candidates", x: 240, y: 80},
  ];
  const CONNECTIONS = [
    ["library", "model", "lookup"], ["library", "posterior", "prior"],
    ["model", "posterior", "likelihoods"], ["observation", "posterior", "answer"],
    ["posterior", "stop", "posterior"], ["stop", "router", "continue"],
    ["posterior", "router", "top 256"], ["router", "bank", "select"],
    ["bank", "observation", "question"], ["fit", "model", "fitted tables"],
    ["stop", "output", "stop"],
  ];

  // Same categorization and first-seen ordering as the viewer's question inspector.
  function familyOf(question) {
    const id = question.id;
    if (question.tech === "IR") return "IR features";
    if (question.tech === "MS") return id.startsWith("MS_top5_") ? "Top-five fragment peaks"
      : id.startsWith("MS_lossrank_") ? "Ranked neutral losses" : "Molecular ion & patterns";
    if (question.tech === "13C") return id.startsWith("C2_") ? "Multiple peaks in a window"
      : id.startsWith("C_w") ? "Chemical-shift windows" : "Signal counts & features";
    return id.startsWith("H3_") ? "Three-proton signals" : id.startsWith("Hs_") ? "Singlets in a window"
      : id.startsWith("H_w") ? "Chemical-shift windows" : "Integration & splitting";
  }

  function familyList(meta) {
    const families = [];
    for (const question of meta.questions) {
      const name = familyOf(question);
      let family = families.find(item => item.tech === question.tech && item.name === name);
      if (!family) {
        family = {id: `family-${families.length}`, tech: question.tech, name, questions: []};
        families.push(family);
      }
      family.questions.push(question);
    }
    return families;
  }

  function disk(index, spacing, phase = 0, innerRadius = 0) {
    const angle = index * GOLDEN_ANGLE + phase;
    const radius = Math.sqrt(index + 1) * spacing + innerRadius;
    return {x: Math.cos(angle) * radius, y: Math.sin(angle) * radius};
  }

  function node(id, label, position, data, classes) {
    return {group: "nodes", data: {id, label, color: CORE_COLOR, fill: CORE_COLOR,
      ...data, class: classes}, position, classes};
  }

  function edge(source, target, kind, data = {}, classes = kind) {
    return {group: "edges", data: {id: `e-${kind}-${source}-${target}`, source, target,
      kind, type: kind, label: "", ...data, class: classes}, classes};
  }

  function build(meta, library, options = {}) {
    const expandedChunks = options.expandedChunks || new Set();
    const includeLibrary = options.includeLibrary !== false;
    const trace = options.trace || null;
    const elements = [];
    const families = familyList(meta);
    const traced = new Map();
    if (trace) trace.steps.forEach((step, index) => traced.set(step.q, {step: index, answer: step.a,
      p1: step.p1, targetRank: step.targetRank}));

    for (const section of SECTIONS) {
      const count = section.id === "library" || section.id === "posterior" ? meta.N
        : section.id === "bank" ? meta.Q : section.id === "fit" ? meta.fitCompounds : undefined;
      const color = section.id === "library" ? LIBRARY_COLOR : CORE_COLOR;
      elements.push(node(section.id, section.label, {x: section.x, y: section.y},
        {kind: "section", section: section.id, count, color, fill: color, size: section.id === "posterior" ? 26 : 20},
        `section${section.id === "library" ? " library-hub" : ""}`));
    }
    for (const [source, target, label] of CONNECTIONS) {
      elements.push(edge(source, target, "architecture-link", {label, relation: label, color: "#a1adb9"}));
    }

    for (const [tech, style] of Object.entries(TECH)) {
      const techniqueFamilies = families.filter(family => family.tech === tech);
      const total = techniqueFamilies.reduce((count, family) => count + family.questions.length, 0);
      elements.push(node(`tech-${tech}`, style.label, {x: style.x, y: style.y},
        {kind: "tech", tech, section: "bank", count: total, color: style.color, fill: style.color, size: 24}, "tech"));
      elements.push(edge(`tech-${tech}`, "bank", "technique-link", {tech, color: style.color}));

      const maxFamily = Math.max(...techniqueFamilies.map(family => family.questions.length), 1);
      const orbit = techniqueFamilies.length === 1 ? 40 : 52 + Math.sqrt(maxFamily) * 6.1;
      techniqueFamilies.forEach((family, familyIndex) => {
        const angle = -Math.PI / 2 + familyIndex * Math.PI * 2 / techniqueFamilies.length;
        const center = {x: style.x + Math.cos(angle) * orbit, y: style.y + Math.sin(angle) * orbit};
        elements.push(node(family.id, family.name, center, {kind: "family", family: family.id,
          tech, section: "bank", count: family.questions.length, color: style.color, fill: style.color, size: 13}, "family"));
        elements.push(edge(family.id, `tech-${tech}`, "family-link", {tech, color: style.color}));

        family.questions.forEach((question, index) => {
          const offset = disk(index, 9.1, angle + .7, 11);
          const traceData = traced.get(question.index);
          const classes = `question${traceData ? " trace-step" : ""}`;
          elements.push(node(`q-${question.index}`, question.id,
            {x: center.x + offset.x, y: center.y + offset.y},
            {kind: "question", q: question.index, tech, family: family.id, section: "bank",
              color: style.color, fill: style.color, size: traceData ? 11 : 6, ...(traceData || {})}, classes));
          elements.push(edge(`q-${question.index}`, family.id, "question-link", {tech, color: style.color}));
          elements.push(edge(`q-${question.index}`, "model", "model-link",
            {tech, relation: "uses learned answer model", color: style.color}, "model-link secondary"));
        });
      });
    }

    if (includeLibrary) {
      const chunkSize = meta.chunks.size;
      const chunkCount = Math.ceil(meta.N / chunkSize);
      // Expanding a chunk grows its local node cloud. Group positions remain stable.
      for (let chunk = 0; chunk < chunkCount; chunk++) {
        const kfrom = chunk * chunkSize;
        const kto = Math.min(kfrom + chunkSize, meta.N);
        const offset = disk(chunk, 16.2, .42, 25);
        const center = {x: LIBRARY_CENTER.x + offset.x, y: LIBRARY_CENTER.y + offset.y};
        const expanded = expandedChunks.has(chunk);
        elements.push(node(`chunk-${chunk}`, `Compounds ${kfrom + 1}–${kto}`, center,
          {kind: "library-chunk", chunk, kfrom, kto, count: kto - kfrom, section: "library", expanded,
            color: LIBRARY_COLOR, fill: LIBRARY_COLOR, size: expanded ? 15 : 8},
          `library-chunk${expanded ? " chunk-expanded" : ""}`));
        elements.push(edge(`chunk-${chunk}`, "library", "library-link", {color: LIBRARY_COLOR}));
        if (!expanded) continue;
        for (let k = kfrom; k < kto; k++) {
          const local = disk(k - kfrom, 4.8, chunk * .53, 9);
          const name = library.name[k] || `CID ${library.id[k]}`;
          elements.push(node(`mol-${k}`, name, {x: center.x + local.x, y: center.y + local.y},
            {kind: "compound", k, chunk, cid: library.id[k], name, formula: library.formula[k],
              section: "library", color: LIBRARY_COLOR, fill: LIBRARY_COLOR, size: 3.5}, "compound"));
          elements.push(edge(`mol-${k}`, `chunk-${chunk}`, "compound-link", {color: LIBRARY_COLOR}));
        }
      }
    }

    if (trace) {
      for (let index = 1; index < trace.steps.length; index++) {
        const previous = trace.steps[index - 1], current = trace.steps[index];
        elements.push(edge(`q-${previous.q}`, `q-${current.q}`, "trace-link",
          {step: index, sourceStep: index - 1, targetStep: index, relation: "next selected question",
            color: "#f3c85d", label: String(index + 1)}, "trace-link"));
      }
    }
    return elements;
  }

  global.SpecTreeNetwork = {build, familyOf, familyList};
})(window);
