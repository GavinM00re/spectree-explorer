(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const fmt = value => Number(value).toLocaleString("en-US");
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
  const pct = p => p < .0001 ? `${(p * 100).toFixed(5)}%` : `${(p * 100).toFixed(2)}%`;
  const answerText = (q, a) => `${q.options[a]}${q.unit ? ` ${q.unit}` : ""}`;
  const techniqueNames = {MS:"Mass spectrometry",IR:"Infrared","1H":"¹H NMR","13C":"¹³C NMR"};
  const techniqueExplanations = {
    MS:"Mass spectrometry gives clues about a molecule’s mass and the fragments it forms. Here, m/z is the position of a peak on the mass scale.",
    IR:"Infrared light helps reveal types of chemical bonds. A band is a region where the molecule absorbs light.",
    "1H":"Proton NMR gives clues about the different surroundings of hydrogen atoms. A signal’s position and size help distinguish those surroundings.",
    "13C":"Carbon NMR gives clues about the different surroundings of carbon atoms. Each peak is an observed signal; ppm labels its position."
  };
  let meta, library, worker = null, state = null, sample = null, mode = null;
  let guided = false;
  let selected = null, busy = false, requestId = 0, pendingBack = null, revealed = false;
  let selectedSample = null, searchTimer = null;

  function questionGuidance(q) {
    if (q.kind !== "count") return "Choose the answer that matches your observations.";
    const cap = q.ncat - 1;
    const conversion = q.id === "MS_M_mass50" ? " Divide the molecular-ion m/z by 50 and round to the nearest whole number; for example, m/z 200 uses 4. Use 0 when no M+ is seen." : "";
    return `Answer in: ${q.unit}.${conversion} Values of ${cap} or more in these units use ${q.options[cap]}.`;
  }

  function shortQuestionGuidance(q) {
    if (q.id === "MS_M_mass50") return "Molecular-ion mass ÷ 50, rounded. Example: m/z 200 → 4.";
    return q.kind === "count" ? `Answer in: ${q.unit}.` : "Choose the answer that matches your observations.";
  }

  function findCompounds(query, source, limit = 15) {
    const exactIds = [], exactNames = [], exactFormulas = [], partial = [];
    for (let k = 0; k < source.id.length; k++) {
      const name = String(source.name[k] || "").toLowerCase();
      const formula = String(source.formula[k] || "").toLowerCase();
      if (String(source.id[k]) === query) exactIds.push(k);
      else if (name === query) { if (exactNames.length < limit) exactNames.push(k); }
      else if (formula === query) { if (exactFormulas.length < limit) exactFormulas.push(k); }
      else if (partial.length < limit && name.includes(query)) partial.push(k);
    }
    return [...exactIds, ...exactNames, ...exactFormulas, ...partial].slice(0, limit);
  }

  function error(message) {
    $("identify-error").textContent = message;
    $("identify-error").hidden = false;
  }
  function clearError() { $("identify-error").hidden = true; }
  function setBusy(value, message = "") {
    busy = value;
    $("identify-status").textContent = message;
    $("identify-status").hidden = !message;
    $("identify-session").setAttribute("aria-busy", String(value));
    $("restart-identification").disabled = value;
    $("new-synthetic").disabled = value;
    $("identify-back").disabled = value || !state?.history.length;
    $("identify-next").disabled = value || selected === null || !state || state.q < 0;
    $("identify-finish").disabled = value || !state?.history.length || state.q < 0;
    $("use-reading").disabled = value;
    $("identify-answers").querySelectorAll("button").forEach(button => { button.disabled = value; });
  }
  function send(type, extra = {}) {
    if (!worker || busy) return;
    clearError();
    setBusy(true, type === "answer" ? "Updating all candidates and choosing the next question…" : "Updating the identification…");
    worker.postMessage({type, requestId:++requestId, ...extra});
  }
  function start(chosenMode, k = null) {
    if (!meta) return;
    if (worker) worker.terminate();
    guided = chosenMode === "guided";
    mode = guided ? "synthetic" : chosenMode; state = null; sample = null; selected = null; pendingBack = null; revealed = false;
    if (guided && k === null) k = library.id.findIndex(id => String(id) === "2519");
    selectedSample = mode === "synthetic" ? (Number.isInteger(k) && k >= 0 && k < meta.N ? k : Math.floor(Math.random() * meta.N)) : null;
    clearError();
    $("identify-setup").hidden = true;
    $("identify-session").hidden = false;
    $("session-mode").textContent = guided ? "GUIDED EXAMPLE / ANSWERS PROVIDED" : mode === "own" ? "USE YOUR OWN DATA" : "SYNTHETIC PRACTICE / YOU CHOOSE THE ANSWERS";
    $("guided-explanation").hidden = !guided;
    $("restart-identification").textContent = guided ? "Restart walkthrough" : "Restart";
    const evidence = guided ? "all" : $("identify-evidence").value;
    $("session-evidence").textContent = `${evidence === "all" ? "IR + MS + ¹H + ¹³C NMR" : "MS + ¹H + ¹³C NMR"} · ${fmt(meta.N)} candidate compounds`;
    $("own-data-guide").hidden = mode !== "own";
    $("synthetic-data").hidden = mode !== "synthetic";
    $("synthetic-identity").hidden = true;
    $("synthetic-identity").replaceChildren();
    $("reveal-synthetic").textContent = "Reveal source compound";
    $("synthetic-spectra").replaceChildren();
    $("synthetic-search-results").replaceChildren();
    $("synthetic-search").value = "";
    $("show-reading").checked = false;
    $("synthetic-hint").hidden = true;
    $("identify-result").hidden = true;
    $("identify-controls").hidden = false;
    $("identify-finish").hidden = false;
    $("identify-question").textContent = "Opening the full v7 model…";
    $("identify-tech").textContent = "v7";
    $("identify-step").textContent = "";
    $("identify-unit").textContent = "";
    $("technique-explanation").textContent = "";
    $("question-detail").textContent = "";
    $("question-help").hidden = true;
    $("question-help").open = false;
    ["identify-unit", "identify-answers", "identify-selection"].forEach(id => { $(id).hidden = false; });
    $("identify-answers").replaceChildren();
    $("identify-selection").textContent = "";
    $("candidate-list").replaceChildren();
    $("identify-history").replaceChildren();
    $("history-empty").hidden = false;
    $("history-count").textContent = "0";
    $("ranking-count").textContent = "";
    const params = new URLSearchParams({mode:guided ? "guided" : mode});
    if (mode === "synthetic" && k !== null) params.set("cid", library.id[selectedSample]);
    history.replaceState(null, "", `identification.html?${params}`);
    setBusy(true, "Loading the model and checking its source data…");
    const currentWorker = new Worker("identification-worker.js");
    worker = currentWorker;
    currentWorker.onmessage = event => {
      if (worker !== currentWorker) return;
      const message = event.data;
      if (message.requestId !== requestId) return;
      if (message.type === "error") {
        setBusy(false); error(message.message); return;
      }
      if (message.type !== "state") return;
      state = message;
      if (message.sample) { sample = message.sample; renderSpectra(); }
      selected = pendingBack && pendingBack.q === state.q ? pendingBack.a : guided && sample && state.q >= 0 ? sample.a[state.q] : null;
      pendingBack = null;
      setBusy(false);
      render();
      $("identify-question").focus({preventScroll:true});
    };
    currentWorker.onerror = () => {
      if (worker !== currentWorker) return;
      setBusy(false); error("The identification could not load. Click Restart to try again.");
    };
    currentWorker.postMessage({type:"start", requestId:++requestId, evidence, k:selectedSample});
  }
  function chooseAnswer(a) {
    if (!state || state.q < 0 || busy) return;
    selected = a;
    $("identify-answers").querySelectorAll("button").forEach(button => {
      const picked = Number(button.dataset.answer) === a;
      button.setAttribute("aria-checked", String(picked));
    });
    $("identify-selection").textContent = `Selected: ${answerText(meta.questions[state.q], a)}`;
    $("identify-next").disabled = false;
  }
  function renderHint() {
    const available = !guided && mode === "synthetic" && sample && state?.q >= 0;
    $("synthetic-hint").hidden = !available;
    $("stored-reading").hidden = !available || !$("show-reading").checked;
    if (available) $("stored-answer").textContent = `Stored answer: ${answerText(meta.questions[state.q], sample.a[state.q])}`;
  }
  function render() {
    const finished = state.q < 0;
    $("guided-explanation").hidden = !guided || finished;
    $("question-help").hidden = finished;
    $("question-help").open = false;
    ["identify-unit", "identify-answers", "identify-selection"].forEach(id => { $(id).hidden = finished; });
    $("identify-result").hidden = !finished;
    $("identify-controls").hidden = finished;
    $("identify-finish").hidden = finished;
    $("identify-answers").replaceChildren();
    $("identify-selection").textContent = "";
    $("identify-unit").textContent = "";
    $("identify-step").textContent = `${state.history.length} answer${state.history.length === 1 ? "" : "s"}`;
    if (finished) {
      $("identify-tech").textContent = "RESULT";
      $("identify-question").textContent = "Best match in the library";
      renderResult();
    } else {
      const q = meta.questions[state.q];
      $("identify-tech").textContent = techniqueNames[q.tech] || q.tech;
      $("identify-step").textContent = `Question ${state.history.length + 1}`;
      $("identify-question").textContent = q.text;
      $("technique-explanation").textContent = techniqueExplanations[q.tech] || "This observation helps compare the molecules in the library.";
      $("identify-unit").textContent = shortQuestionGuidance(q);
      $("question-detail").textContent = questionGuidance(q);
      q.options.forEach((option, a) => {
        const button = document.createElement("button");
        button.type = "button"; button.dataset.answer = a;
        button.setAttribute("role", "radio"); button.setAttribute("aria-checked", String(selected === a));
        button.textContent = option;
        button.onclick = () => chooseAnswer(a);
        button.onkeydown = event => {
          const direction = ["ArrowRight","ArrowDown"].includes(event.key) ? 1 : ["ArrowLeft","ArrowUp"].includes(event.key) ? -1 : 0;
          if (!direction) return;
          event.preventDefault();
          const next = (a + direction + q.options.length) % q.options.length;
          chooseAnswer(next); $("identify-answers").children[next].focus();
        };
        $("identify-answers").append(button);
      });
      if (selected !== null) chooseAnswer(selected);
    }
    renderHint();
    $("candidate-list").innerHTML = state.top.map(([k,p]) => `<li><span>${esc(library.name[k] || `CID ${library.id[k]}`)}<small>${esc(library.formula[k])} · CID ${esc(library.id[k])}</small></span><strong>${pct(p)}</strong></li>`).join("");
    $("ranking-count").textContent = `${fmt(meta.N)} scored`;
    $("identify-history").innerHTML = state.history.map(step => `<li><strong>${esc(meta.questions[step.q].text)}</strong><span>${esc(answerText(meta.questions[step.q], step.a))}</span></li>`).join("");
    $("history-empty").hidden = state.history.length > 0;
    $("history-count").textContent = String(state.history.length);
    $("identify-history").scrollTop = $("identify-history").scrollHeight;
    setBusy(false);
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches && $("identify-question").animate) {
      $("identify-question").animate([{opacity:0,transform:"translateY(5px)"},{opacity:1,transform:"translateY(0)"}], {duration:220,easing:"ease-out"});
    }
  }
  function renderResult() {
    const root = $("identify-result"); root.replaceChildren();
    const [k,p] = state.top[0];
    const description = {confidence:"One candidate now has enough support for the model to stop asking questions.",question_limit:"The model reached its 60-question limit. This is its current best match.",no_useful_question:"No remaining question is useful enough to separate the leading candidates.",requested:"Here is the current best match based on your answers so far."}[state.stopReason] || "The model has stopped asking questions.";
    const details = document.createElement("p"); details.className = "identify-result-note"; details.textContent = description;
    const probability = document.createElement("p"); probability.className = "identify-result-probability"; probability.textContent = `${pct(p)} model probability`;
    const card = document.createElement("div");
    root.append(details, probability, card);
    SpecTreeMolecule.mount(card, {k,library});
    if (mode === "synthetic") {
      const comparison = document.createElement("p"); comparison.className = "identify-result-comparison";
      comparison.textContent = k === selectedSample ? "The model’s best match is the compound used to create this synthetic example." : "The model’s best match differs from the compound used to create this synthetic example. You can reveal the source below.";
      root.append(comparison);
    }
    const note = document.createElement("p"); note.className = "identify-result-note"; note.textContent = "Model probabilities are not measured identification accuracy."; root.append(note);
    const actions = document.createElement("div"); actions.className = "identify-result-actions";
    if (state.history.length) {
      const back = document.createElement("button"); back.textContent = "← Revise last answer"; back.onclick = goBack; actions.append(back);
    }
    if (mode === "synthetic") {
      const reveal = document.createElement("button"); reveal.textContent = "Reveal source compound"; reveal.onclick = revealSample; actions.append(reveal);
      const link = document.createElement("a"); link.href = `paths.html?cid=${encodeURIComponent(library.id[selectedSample])}`; link.textContent = "View source’s stored full path ↗"; actions.append(link);
      const provenance = document.createElement("p"); provenance.className = "identify-result-note"; provenance.textContent = "The stored full path uses the example’s automatic readings with all techniques. Your answers here may follow a different route."; root.append(provenance);
    }
    root.append(actions);
  }
  function goBack() {
    if (!state?.history.length || busy) return;
    pendingBack = state.history[state.history.length - 1];
    send("back");
  }
  function revealSample() {
    if (!sample) return;
    revealed = !revealed;
    $("synthetic-identity").hidden = !revealed;
    $("reveal-synthetic").textContent = revealed ? "Hide source compound" : "Reveal source compound";
    if (revealed) {
      SpecTreeMolecule.mount($("synthetic-identity"), {k:selectedSample,library});
      if (state?.q < 0) {
        const match = document.createElement("p"); match.className = "identify-result-note";
        match.textContent = state.top[0][0] === selectedSample ? "The leading candidate matches this source compound." : "The leading candidate differs from this source compound.";
        $("synthetic-identity").append(match);
      }
    }
  }

  function stickPlot(values, {min,max,reversed = false,color,label,title}) {
    const width = 600, height = 180, left = 40, right = 20, top = 22, bottom = 35;
    const x = value => left + (reversed ? (max-value)/(max-min) : (value-min)/(max-min)) * (width-left-right);
    const y = value => height-bottom - Math.max(0,Math.min(1,value))*(height-top-bottom);
    let markup = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title><path d="M${left} ${top}V${height-bottom}H${width-right}" fill="none" stroke="#b9cbd4"/>`;
    for (let i=0; i<=6; i++) {
      const value = min + i*(max-min)/6, px = x(value);
      markup += `<path d="M${px} ${top}V${height-bottom}" stroke="#e7eef2"/><text x="${px}" y="${height-bottom+17}" text-anchor="middle" fill="#7a909d" font-size="10">${Number(value.toFixed(max<=20?1:0))}</text>`;
    }
    values.forEach(([value,intensity]) => { if (value>=min && value<=max) markup += `<path d="M${x(value)} ${y(0)}V${y(intensity)}" stroke="${color}" stroke-width="1.8"/>`; });
    const labeled=[];
    [...values].sort((a,b)=>b[1]-a[1]).forEach(([value,intensity]) => {
      const px=x(value); if(value<min || value>max || labeled.length>=12 || labeled.some(at=>Math.abs(at-px)<28))return;
      labeled.push(px); markup += `<text x="${px}" y="${Math.max(12,y(intensity)-5)}" text-anchor="middle" fill="#4b6978" font-size="10">${Number(value.toFixed(max<=20?2:1))}</text>`;
    });
    return `${markup}<text x="${width-right}" y="${height-4}" text-anchor="end" fill="#7a909d" font-size="10">${esc(label)}</text></svg>`;
  }
  function dataTable(headers, rows) {
    return `<div class="spectrum-table-wrap"><table><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(v=>`<td>${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }
  function renderSpectra() {
    const ms = sample.ms || [], h = sample.h || [], c = sample.c || [];
    const maxMass = Math.max(60,...ms.map(p=>p[0]));
    const maxIntegral = Math.max(1,...h.map(p=>p.n));
    const maxH = Math.max(14,...h.map(p=>p.d))+0.5, minH=Math.min(-.5,...h.map(p=>p.d));
    const minC=Math.min(0,...c),maxC=Math.max(220,...c)+5;
    let html = `<section class="spectrum-block"><h3>EI mass spectrum</h3><p>Stored m/z peaks · relative intensity</p>${stickPlot(ms.map(([x,y])=>[x,y/100]),{min:0,max:Math.ceil((maxMass+10)/10)*10,color:"#4b8ddb",label:"m/z",title:"Synthetic mass spectrum"})}<details><summary>View all ${ms.length} peaks</summary>${dataTable(["m/z","Relative intensity (%)"],ms)}</details></section>`;
    html += `<section class="spectrum-block"><h3>¹H NMR</h3><p>Signal centers; height shows relative integral. Multiplicity and coupling are listed below.</p>${stickPlot(h.map(p=>[p.d,p.n/maxIntegral]),{min:minH,max:maxH,reversed:true,color:"#d56e70",label:"δ (ppm)",title:"Synthetic proton NMR signal centers"})}<details open><summary>View ${h.length} signals and multiplicities</summary>${dataTable(["δ (ppm)","Integral (H)","Multiplicity","J (Hz)"],h.map(p=>[p.d,p.n,p.m,Array.isArray(p.J)?p.J.join(", "):p.J??""]))}</details></section>`;
    html += `<section class="spectrum-block"><h3>¹³C NMR</h3><p>Stored proton-decoupled peak positions; equal display heights.</p>${stickPlot(c.map(x=>[x,.8]),{min:minC,max:maxC,reversed:true,color:"#a77dde",label:"δ (ppm)",title:"Synthetic carbon NMR peak positions"})}<details><summary>View all ${c.length} carbon peaks</summary>${dataTable(["δ (ppm)"],c.map(x=>[x]))}</details></section>`;
    const ir = meta.questions.filter(q=>q.tech === "IR");
    html += `<section class="spectrum-block"><h3>IR band readings</h3><p>Categorical simulated observations, not a measured or continuous FTIR spectrum.${state?.evidence === "nmr_ms" ? " IR is excluded from this identification." : ""}</p><details open><summary>View all ${ir.length} IR readings</summary><div class="spectrum-table-wrap"><table class="ir-table"><tbody>${ir.map(q=>`<tr><td>${esc(q.text)}</td><td class="ir-reading">${esc(q.options[sample.a[q.index]])}</td></tr>`).join("")}</tbody></table></div></details></section>`;
    $("synthetic-spectra").innerHTML = html;
  }

  $("start-guided").onclick = () => start("guided");
  $("start-own").onclick = () => start("own");
  $("start-synthetic").onclick = () => start("synthetic");
  $("restart-identification").onclick = () => start(guided ? "guided" : mode,selectedSample);
  $("new-synthetic").onclick = () => start("synthetic");
  $("change-identification").onclick = () => {
    if (worker) worker.terminate(); worker=null; state=null; sample=null; mode=null; busy=false; guided=false;
    $("identify-session").hidden=true; $("identify-setup").hidden=false; $("identify-status").textContent=""; clearError();
    history.replaceState(null,"","identification.html"); $("start-guided").focus();
  };
  $("identify-next").onclick = () => { if (selected !== null && state) send("answer",{q:state.q,a:selected}); };
  $("identify-back").onclick = goBack;
  $("identify-finish").onclick = () => send("finish");
  $("show-reading").onchange = renderHint;
  $("use-reading").onclick = () => { if(sample && state?.q>=0)chooseAnswer(sample.a[state.q]); };
  $("reveal-synthetic").onclick = revealSample;
  $("synthetic-search").oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const query=$("synthetic-search").value.trim().toLowerCase();
      const target=$("synthetic-search-results"); target.replaceChildren();
      if (!query) return;
      const found=findCompounds(query,library);
      if(!found.length){target.textContent="No matching compound in the v7 library.";return;}
      found.forEach(k=>{
        const button=document.createElement("button");button.type="button";button.innerHTML=`${esc(library.name[k] || `CID ${library.id[k]}`)}<small>${esc(library.formula[k])} · CID ${esc(library.id[k])}</small>`;
        button.onclick=()=>start("synthetic",k);target.append(button);
      });
    },140);
  };

  (async () => {
    try {
      const responses = await Promise.all([fetch("data/meta.json"),fetch("data/library.json")]);
      if(responses.some(response=>!response.ok))throw new Error("The v7 model metadata or library could not load. Refresh to try again.");
      [meta,library]=await Promise.all(responses.map(response=>response.json()));
      if(library.id.length!==meta.N || meta.questions.length!==meta.Q)throw new Error("The model and library counts do not match.");
      $("identify-library").textContent=`All ${fmt(meta.N)} compounds · ${fmt(meta.Q)} questions · v7`;
      $("identify-status").textContent="";
      $("setup-status").textContent="";
      $("start-guided").disabled=false;$("start-own").disabled=false;$("start-synthetic").disabled=false;
      const params=new URLSearchParams(location.search), requestedMode=params.get("mode");
      if(requestedMode==="guided"){
        const cid=params.get("cid") || "2519", k=library.id.findIndex(id=>String(id)===cid);
        if (k < 0) throw new Error("That compound is not in this library. Choose the guided example below to try caffeine.");
        start("guided",k);
      }
      else if(requestedMode==="own")start("own");
      else if(requestedMode==="synthetic"){
        const cid=params.get("cid"), k=cid?library.id.findIndex(id=>String(id)===cid):-1;
        start("synthetic",k>=0?k:null);
      }
    } catch(e){$("identify-status").textContent="";$("setup-status").textContent="";error(e.message);}
  })();
})();
