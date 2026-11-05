"use strict";

const $ = id => document.getElementById(id);
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt = value => Number(value).toLocaleString("en-US");
const pct = p => `${(p * 100).toFixed(p < .0001 ? 5 : 2)}%`;
const TECH = {
  IR:{name:"Infrared",short:"IR",color:"#b77b20",fill:"#fff4df"},
  MS:{name:"Mass spectrometry",short:"MS",color:"#427bbd",fill:"#edf3fc"},
  "1H":{name:"Proton NMR",short:"¹H",color:"#c65552",fill:"#fff0ee"},
  "13C":{name:"Carbon NMR",short:"¹³C",color:"#8e62b9",fill:"#f4effa"}
};
const ORDER = ["IR","MS","1H","13C"];
const SECTIONS = [
  {id:"library",title:"Compound library",body:"All 105,328 library compounds are candidates from the start. The 106 library groups follow the original storage order; their positions do not encode chemical similarity.",children:[["identity","Compound identity","Name, CID and formula"],["prior","Uniform prior","1 / 105,328 per compound"],["readings","Stored test readings","Draw 0 for every compound"]]},
  {id:"model",title:"Learned answer model",body:"The clean-answer table covers all 645 questions and 105,328 candidates. Per-question likelihood tables describe the probability of an observed reading given a compound’s clean answer.",children:[["clean","Clean answers","645 × 105,328 values"],["likelihood","Reading likelihoods","P(reading | clean answer)"],["weights","Technique weights","Fitted for each evidence mode"]]},
  {id:"observation",title:"Observed answer",body:"Decision paths use each compound’s stored simulated noisy test reading, draw 0, exactly as in v7. IR is represented by band readings. The answer is categorical or a count in the question’s stated units.",children:[["signals","Available evidence","IR, MS, ¹H and ¹³C"],["encoding","Answer encoding","No / Not sure / Yes, or count"],["draw","Fixed test draw","Reproducible v7 reading"]]},
  {id:"posterior",title:"Probability update",body:"Each answer updates every candidate’s log score using its clean answer, the reading likelihood and a fitted technique weight. Probabilities are normalized over all 105,328 candidates.",children:[["update","Weighted evidence","Weight × log likelihood"],["normalize","Normalization","Complete candidate library"],["rank","Candidate ranking","Deterministic tie order"]]},
  {id:"router",title:"Next-question selection",body:"The leading 256 candidates guide expected information gain over the unasked, allowed questions. All 105,328 candidates remain in the scoring pool. IR has a separate ×2 selection priority in all-evidence mode.",children:[["top256","Routing candidates","Current top 256"],["information","Information gain","Must exceed 0.0001 nats"],["priority","Question priority","IR ×2 in all-evidence mode"]]},
  {id:"stop",title:"Stopping check",body:"The engine stops when the leading model posterior reaches 99.9%, after 60 answers, or when no useful eligible question remains. Otherwise it selects another question.",children:[["threshold","Posterior threshold","Leading candidate ≥99.9%"],["budget","Question limit","At most 60 answers"],["exhausted","Information exhausted","No useful question remains"]]},
  {id:"bank",title:"Question bank",body:"Every one of the 645 v7 questions is visible in this network: 330 MS, 16 IR, 168 proton NMR and 131 carbon NMR. Thin links connect questions to families and techniques. NMR + MS mode excludes IR when calculating a path.",children:[["ms","Mass spectrometry","330 questions"],["ir","Infrared","16 questions"],["h","Proton NMR","168 questions"],["c","Carbon NMR","131 questions"]]},
  {id:"fit",title:"Model fitting",body:"The exported v7 likelihood tables and technique weights remain unchanged. The fit cohort contains 75,706 compounds, with 10 training noise readings per fit compound. The candidate library is larger: 105,328 compounds.",children:[["cohort","Fit cohort","75,706 compounds"],["trainreadings","Training readings","10 per fit compound"],["frozen","Fixed v7 model","Original engine and payload"]]},
  {id:"output",title:"Ranked candidates",body:"A path records the five leading candidates and their model posterior probabilities after every answer. The leading candidate may differ from the selected compound. These posteriors are not measured accuracy.",children:[["five","Leading candidates","Five largest model posteriors"],["target","Selected compound rank","Ties counted pessimistically"],["finish","Stopping reason","Threshold, limit or information"]]}
];

let meta, library, cy, lowerNames, families = [];
let view = "architecture", selectedK = null, result = null, worker = null, requestId = 0, busy = false;
let currentStep = -1, activeSection = null, activeDetail = null, tablePage = 0, miniTransform = null;
let inspectorActionFocused = false;
const expandedChunks = new Set(), expandedSections = new Set();
const TABLE_SIZE = 100;

function toast(message) {
  $("toast").textContent = message; $("toast").hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => $("toast").hidden = true, 4500);
}
function button(action, id, text, cls = "") { return `<button class="${cls}" data-action="${action}" data-id="${esc(id)}">${text}</button>`; }
function chip(t) { const x = TECH[t]; return `<span class="tech-chip" style="--color:${x.color};--chip:${x.fill}">${x.short} · ${x.name}</span>`; }
function detail(label, value) { return `<div class="detail-row"><span>${label}</span><strong>${value}</strong></div>`; }
function nameOf(k) { return library.name[k] || `CID ${library.id[k]}`; }
function shortText(text, max = 75) { return text.length > max ? text.slice(0, max - 1) + "…" : text; }
function answerText(q, a) { return `${q.options[a] ?? a}${q.unit ? ` ${q.unit}` : ""}`; }
function openInspector(open = true) {
  const returnFocus = !open && document.querySelector(".inspector").contains(document.activeElement);
  document.querySelector(".workspace").classList.toggle("inspector-closed", !open);
  $("toggle-inspector").setAttribute("aria-expanded", String(open));
  if (returnFocus) $("toggle-inspector").focus({preventScroll:true});
  requestAnimationFrame(() => { if (cy) { cy.resize(); updateMiniViewport(); } });
}
function inspect(html) {
  openInspector(); activeSection = null; activeDetail = null;
  $("inspector-content").innerHTML = html; $("inspector-content").scrollTop = 0;
  if (inspectorActionFocused) {
    const heading = $("inspector-content").querySelector("h2");
    if (heading) { heading.tabIndex = -1; heading.focus({preventScroll:true}); }
  }
}

function graphStyles() {
  return [
    {selector:"node",style:{shape:"ellipse",width:"data(displaySize)",height:"data(displaySize)","background-color":"data(fill)","border-width":0,label:"data(label)",color:"#344855","font-family":"Segoe UI, Arial, sans-serif","font-size":10,"text-wrap":"none","text-valign":"bottom","text-margin-y":3,"min-zoomed-font-size":9,"overlay-opacity":0}},
    {selector:"edge",style:{width:.55,"line-color":"data(color)",opacity:.24,"curve-style":"straight","target-arrow-shape":"none",label:"","overlay-opacity":0}},
    {selector:".section",style:{shape:"round-rectangle","border-width":1,"border-color":"#5d7182","font-size":12,"font-weight":600,"min-zoomed-font-size":6}},
    {selector:".tech",style:{"font-size":17,"font-weight":700,"min-zoomed-font-size":6}},
    {selector:".family",style:{shape:"diamond","font-size":11,"font-weight":600,"min-zoomed-font-size":8}},
    {selector:".question",style:{"font-size":9,"min-zoomed-font-size":10}},
    {selector:".compound",style:{"font-size":9,"min-zoomed-font-size":13}},
    {selector:".library-chunk",style:{shape:"round-rectangle","font-size":9,"min-zoomed-font-size":11}},
    {selector:".component",style:{shape:"rectangle","font-size":10,"min-zoomed-font-size":9}},
    {selector:".architecture-link",style:{width:1.1,opacity:.55,"target-arrow-shape":"triangle","target-arrow-color":"#8a9da9","arrow-scale":.5}},
    {selector:".model-link",style:{width:.4,opacity:.12}},
    {selector:"node.dimmed",style:{opacity:.32}},
    {selector:"edge.dimmed",style:{opacity:.06}},
    {selector:".trace-step",style:{label:"data(traceLabel)","font-size":12,"font-weight":700,"min-zoomed-font-size":6,"border-width":2,"border-color":"#b37c00",opacity:1}},
    {selector:".trace-link",style:{width:2.1,opacity:.88,"line-color":"#d7a227","target-arrow-color":"#d7a227","target-arrow-shape":"triangle","arrow-scale":.65,"curve-style":"bezier",label:"data(label)",color:"#9d6c00","font-size":10,"min-zoomed-font-size":8,"text-background-color":"#fff","text-background-opacity":.8,"text-background-padding":2}},
    {selector:".trace-endpoint",style:{"border-width":2,"border-color":"#b37c00",opacity:1}},
    {selector:".active-path",style:{width:3,"line-color":"#b37800","target-arrow-color":"#b37800",opacity:1}},
    {selector:".selected",style:{"border-width":3,"border-color":"#173e56",opacity:1,"font-size":13,"min-zoomed-font-size":0,"text-background-color":"#fff","text-background-opacity":.9,"text-background-padding":3}},
    {selector:".labels-all",style:{"min-zoomed-font-size":0}},
    {selector:".labels-off",style:{label:""}},
    {selector:".hidden-link",style:{display:"none"}},
    {selector:"node:active",style:{"overlay-opacity":0}}
  ];
}

function rebuildNetwork(fit = true) {
  const selectedIds = cy.nodes(".selected").map(n => n.id());
  const trace = view === "trace" ? result : null;
  const elements = SpecTreeNetwork.build(meta, library, {expandedChunks, includeLibrary:view !== "questions", trace});
  const nodeById = new Map(elements.filter(e => e.group === "nodes").map(e => [e.data.id,e]));
  const scale = Number($("node-scale").value);
  for (const section of SECTIONS) {
    if (!expandedSections.has(section.id)) continue;
    const parent = nodeById.get(section.id);
    section.children.forEach(([id,title,description], i) => {
      const angle = -.9 + i * 2.2;
      elements.push({group:"nodes",data:{id:`component-${section.id}-${id}`,label:title,kind:"component",section:section.id,detailId:id,description,size:8,fill:"#93a3b0",color:"#93a3b0"},position:{x:parent.position.x+65*Math.cos(angle),y:parent.position.y+65*Math.sin(angle)},classes:"component"});
      elements.push({group:"edges",data:{id:`e-component-${section.id}-${id}`,source:section.id,target:`component-${section.id}-${id}`,kind:"component-link",color:"#93a3b0"},classes:"component-link"});
    });
  }
  for (const e of elements) {
    if (e.group === "nodes") {
      e.data.displaySize = e.data.size * scale;
      if (e.data.step !== undefined) e.data.traceLabel = `${e.data.step + 1} · ${meta.questions[e.data.q].id}`;
      if (trace && e.data.step === undefined && !["library","output"].includes(e.data.id)) e.classes += " dimmed";
    } else if (trace && !e.classes.includes("trace-link")) e.classes += " dimmed";
  }
  if (trace && trace.steps.length) {
    const first = trace.steps[0].q, last = trace.steps[trace.steps.length-1].q;
    elements.push({group:"edges",data:{id:"trace-initial",source:"library",target:`q-${first}`,kind:"trace-link",label:"1",targetStep:0,color:"#d7a227"},classes:"trace-link"});
    elements.push({group:"edges",data:{id:"trace-final",source:`q-${last}`,target:"output",kind:"trace-link",label:"result",targetStep:trace.steps.length,color:"#d7a227"},classes:"trace-link"});
    nodeById.get("output").classes += " trace-endpoint";
    nodeById.get("output").data.label = `Final leader: ${shortText(nameOf(trace.top[0][0]),30)}`;
    nodeById.get("library").classes += " trace-endpoint";
  }
  cy.batch(() => { cy.elements().remove(); cy.add(elements); cy.nodes().ungrabify(); });
  applyDisplay();
  cy.batch(() => {
    selectedIds.forEach(id => cy.getElementById(id).addClass("selected"));
    if (trace) cy.edges(".trace-link").filter(e => e.data("targetStep") <= currentStep).addClass("active-path");
  });
  const count = cy.nodes().length;
  $("network-count").textContent = `${fmt(count)} nodes · ${fmt(cy.edges().length)} links`;
  $("map-summary").textContent = `${fmt(count)} visible nodes · all ${meta.Q} questions${view === "questions" ? "" : ` · ${fmt(meta.N)} candidates represented`}`;
  $("trace-empty").hidden = view !== "trace" || !!result;
  if (fit) fitMap();
  renderNodeTable(); drawMinimap();
}

function applyDisplay() {
  const mode = $("label-mode").value, scale = Number($("node-scale").value);
  cy.batch(() => {
    cy.nodes().removeClass("labels-all labels-off");
    if (mode === "all") cy.nodes().addClass("labels-all");
    if (mode === "off") cy.nodes().addClass("labels-off");
    cy.nodes().forEach(n => n.data("displaySize", n.data("size") * scale));
    cy.edges(".model-link").toggleClass("hidden-link", !$("model-links").checked);
  });
}
function fitMap() { if (cy.nodes().length) cy.fit(cy.nodes(),55); updateZoom(); }
function updateZoom() { $("zoom-value").textContent = `${Math.round(cy.zoom()*100)}%`; updateMiniViewport(); }
function selectNode(id) { cy.nodes().removeClass("selected"); cy.getElementById(id).addClass("selected"); renderNodeTable(); }
function focusNodes(nodes, maxZoom = 2) {
  if (!nodes.length) return;
  cy.fit(nodes,80);
  if (cy.zoom() > maxZoom) { cy.zoom(maxZoom); cy.center(nodes); }
}
function focusNode(id) {
  const n = cy.getElementById(id); if (!n.length) return;
  const zoom = Math.max(cy.zoom(),2);
  cy.stop();
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    cy.zoom(zoom); cy.center(n);
  } else {
    cy.animate({center:{eles:n},zoom},{duration:180});
  }
}
function focusSelection() {
  const selected = cy.nodes(".selected");
  if (selected.length) focusNodes(selected,3);
  else if (view === "trace" && result) focusNodes(cy.nodes(".trace-step"),2);
  else toast("Select a node first, then fit the selection.");
}

function drawMinimap() {
  if (!cy || !cy.nodes().length) return;
  const canvas = $("mini-canvas"), ctx = canvas.getContext("2d");
  const bounds = cy.nodes().boundingBox({includeLabels:false,includeOverlays:false});
  const s = Math.min((canvas.width-14)/Math.max(1,bounds.w),(canvas.height-14)/Math.max(1,bounds.h));
  miniTransform = {s,ox:(canvas.width-bounds.w*s)/2-bounds.x1*s,oy:(canvas.height-bounds.h*s)/2-bounds.y1*s};
  const {ox,oy} = miniTransform;
  ctx.clearRect(0,0,canvas.width,canvas.height);
  cy.edges(".architecture-link, .trace-link").forEach(e => {
    const a=e.source().position(), b=e.target().position(); ctx.strokeStyle=e.hasClass("trace-link")?"#cf9b2d":"#c6d0d7";ctx.lineWidth=.5;
    ctx.beginPath();ctx.moveTo(a.x*s+ox,a.y*s+oy);ctx.lineTo(b.x*s+ox,b.y*s+oy);ctx.stroke();
  });
  cy.nodes().forEach(n => { const p=n.position();ctx.fillStyle=n.data("fill")||"#8499a8";ctx.beginPath();ctx.arc(p.x*s+ox,p.y*s+oy,n.hasClass("section")||n.hasClass("tech")?1.8:.65,0,Math.PI*2);ctx.fill(); });
  updateMiniViewport();
}
function updateMiniViewport() {
  if (!cy || !miniTransform) return;
  const c=$("mini-canvas"), rect=c.getBoundingClientRect(), box=cy.extent(), {s,ox,oy}=miniTransform;
  const sx=rect.width/c.width, sy=rect.height/c.height, v=$("mini-viewport");
  v.style.left=`${(box.x1*s+ox)*sx}px`;v.style.top=`${(box.y1*s+oy)*sy}px`;
  v.style.width=`${box.w*s*sx}px`;v.style.height=`${box.h*s*sy}px`;
}
function renderNodeTable() {
  if (!cy || $("node-table").hidden) return;
  const text=$("table-filter").value.trim().toLowerCase();
  const rows=cy.nodes().toArray().filter(n => !text || `${n.data("kind")} ${n.data("label")} ${n.data("cid")||""} ${n.data("tech")||""}`.toLowerCase().includes(text));
  const pages=Math.max(1,Math.ceil(rows.length/TABLE_SIZE)); tablePage=Math.max(0,Math.min(tablePage,pages-1));
  $("node-table-body").innerHTML=rows.slice(tablePage*TABLE_SIZE,(tablePage+1)*TABLE_SIZE).map(n=>`<tr data-node="${esc(n.id())}" class="${n.hasClass("selected")?"selected":""}"><td>${esc(n.data("kind"))}</td><td><button class="table-node" data-node="${esc(n.id())}">${esc(n.data("label"))}</button></td><td>${esc(TECH[n.data("tech")]?.short||"")}</td><td>${n.data("count")===undefined?"":fmt(n.data("count"))}</td></tr>`).join("");
  $("table-count").textContent=`${fmt(rows.length)} nodes · ${tablePage+1}/${pages}`;
  $("table-prev").disabled=tablePage===0;$("table-next").disabled=tablePage>=pages-1;
}

function overviewMarkup() {
  return `<span class="tag">FULL V7 NETWORK</span><h2>Explore every question</h2><p>All 645 questions appear at once, linked to their families and techniques. The 106 library groups cover all ${fmt(meta.N)} candidates.</p><div class="stats-grid"><div class="stat"><b>${fmt(meta.N)}</b><small>candidate compounds</small></div><div class="stat"><b>${meta.Q}</b><small>question nodes</small></div></div><p>Zoom in for labels. Click a node for details; expand a library group to show its individual compounds.</p><div class="microheading">MODEL COMPONENTS</div><div class="node-list">${SECTIONS.map(s=>button("section",s.id,s.title)).join("")}</div><p class="note">Thin lines indicate membership or a question’s use of the answer model. Arrows connect model stages. Gold arrows show the order of a calculated decision path. Positions are for navigation and do not represent chemical similarity.</p>`;
}
function showOverview() { inspect(overviewMarkup()); }
function showSection(id, detailId) {
  const s=SECTIONS.find(s=>s.id===id);if(!s)return;
  const d=s.children.find(c=>c[0]===detailId);selectNode(d?`component-${id}-${detailId}`:id);
  let extra="";
  if (["model","fit"].includes(id)) {
    const ev=$("evidence").value,cfg=meta.settings[ev];
    extra=`<div class="microheading">LIKELIHOOD WEIGHTS · ${ev==="all"?"ALL EVIDENCE":"NMR + MS"}</div><div class="detail-list">${ORDER.map((t,i)=>detail(TECH[t].short,cfg.weights[i].toFixed(5))).join("")}</div><p class="tiny">${ev==="all"?"IR’s ×2 selection priority is separate from its likelihood weight.":"IR questions are excluded in NMR + MS mode."}</p>`;
  }
  inspect(`<span class="tag">MODEL COMPONENT</span><h2>${esc(d?d[1]:s.title)}</h2><p>${esc(s.body)}</p>${d?`<p class="code-label">${esc(d[2])}</p>`:""}${button("toggle-section",id,expandedSections.has(id)?"Collapse components −":"Expand components +","primary")}<div class="node-list">${s.children.map(([k,title])=>button("component",`${id}:${k}`,title)).join("")}</div>${id==="bank"?button("view","questions","View all question nodes ↗","wide"):""}${extra}${id==="fit"?`<div class="detail-list">${detail("v7 package built",esc(meta.built))}${detail("Fit compounds",fmt(meta.fitCompounds))}</div><div class="microheading">MODEL SHA-256</div><p class="code-label">${meta.provenance.modelSha256}</p>`:""}`);
  activeSection=id;activeDetail=detailId;
}
function showTech(t) {
  selectNode(`tech-${t}`);
  inspect(`${chip(t)}<h2>${TECH[t].name}</h2><p>All ${meta.techniqueCounts[t]} questions are already visible.</p>${button("focus-tech",t,"Fit this technique","primary")}<div class="node-list">${families.filter(f=>f.tech===t).map(f=>button("family",f.id,`${f.name}<small>${f.questions.length}</small>`)).join("")}</div>`);
}
function showFamily(id) {
  const f=families.find(f=>f.id===id);if(!f)return;selectNode(id);
  inspect(`${chip(f.tech)}<h2>${f.name}</h2><p>${f.questions.length} question nodes, all visible in the network.</p>${button("focus-family",id,"Fit this question family","primary")}<div class="node-list">${f.questions.map(q=>button("question",q.index,esc(shortText(q.text)))).join("")}</div>`);
}
function questionMarkup(q,a) {
  return `${chip(q.tech)}<h2>${esc(q.text)}</h2><div class="code-label">${esc(q.id)}</div><div class="microheading">POSSIBLE ANSWERS${q.unit?` · ${esc(q.unit)}`:""}</div><div class="answer-list" role="list" aria-label="Possible answers">${q.options.map((v,i)=>`<span role="listitem" class="answer-option ${a===i?"picked":""}" aria-label="${esc(String(v))}${a===i?", recorded answer":""}">${a===i?'<b aria-hidden="true">✓</b> ':""}${esc(v)}${a===i?'<small>Recorded answer</small>':""}</span>`).join("")}</div>${q.ncat===1?'<p class="note">This single-category question has no information gain in this export.</p>':""}`;
}
function showQuestion(i) {
  const q=meta.questions[i];selectNode(`q-${i}`);
  inspect(questionMarkup(q)+`<div class="detail-list">${detail("Question",`${i+1} / ${meta.Q}`)}${detail("Type",q.kind==="bin"?"Categorical":"Count")}</div><p class="note">${q.kind==="bin"?"The reading codes are No, Not sure and Yes.":"Counts use the displayed units and maximum category."} Question position does not determine when it is asked.</p>`);
}
function showQuestionAt(i) { if(view!=="questions")setView("questions");showQuestion(i);focusNode(`q-${i}`); }
function showChunk(chunk) {
  const from=chunk*meta.chunks.size,to=Math.min(from+meta.chunks.size,meta.N);selectNode(`chunk-${chunk}`);
  inspect(`<span class="tag">LIBRARY GROUP ${chunk+1} / ${meta.chunks.count}</span><h2>Compounds ${fmt(from+1)}–${fmt(to)}</h2><p>This group contains ${fmt(to-from)} entries in the original v7 library order.</p>${button("toggle-chunk",chunk,expandedChunks.has(chunk)?"Collapse compound nodes −":`Show ${fmt(to-from)} compound nodes +`,"primary")}${button("focus-chunk",chunk,"Fit this group","wide")}<p class="note">Groups partition the full library for navigation. They are not chemical clusters. Search by exact PubChem CID to locate any compound.</p><div class="microheading">FIRST ENTRIES</div><div class="node-list">${Array.from({length:Math.min(8,to-from)},(_,i)=>button("candidate",from+i,esc(nameOf(from+i)))).join("")}</div>`);
}
function showCandidate(k) {
  selectNode(`mol-${k}`);
  inspect(`<span class="tag">LIBRARY COMPOUND</span><h2>${esc(nameOf(k))}</h2><div class="detail-list">${detail("PubChem CID",esc(library.id[k]))}${detail("Formula",esc(library.formula[k]))}${detail("Library index",fmt(k+1))}</div><p class="code-label">${esc(library.smiles[k])}</p>${button("choose-candidate",k,"Choose this compound","primary")}${button("locate-compound",k,"Locate in the full network","wide")}${result?button("return-path","","Return to the decision path","wide"):""}`);
}
function locateCompound(k) {
  const chunk=Math.floor(k/meta.chunks.size);expandedChunks.add(chunk);
  if(view!=="architecture")setView("architecture");else rebuildNetwork(false);
  showCandidate(k);focusNode(`mol-${k}`);
}
function inspectNode(n) {
  const d=n.data();
  if(view==="trace" && result && d.step!==undefined){showStep(d.step);return;}
  if(view==="trace" && result && d.id==="output"){traceSummary();return;}
  if(d.kind==="question")showQuestion(d.q);
  else if(d.kind==="tech")showTech(d.tech);
  else if(d.kind==="family")showFamily(d.family);
  else if(d.kind==="library-chunk")showChunk(d.chunk);
  else if(d.kind==="compound")showCandidate(d.k);
  else showSection(d.section,d.detailId);
}
function refreshInspector() {
  if (document.querySelector(".workspace").classList.contains("inspector-closed")) return;
  const selected = cy.nodes(".selected");
  if (selected.length) inspectNode(selected[0]);
  else if (activeSection) showSection(activeSection);
}

function rankings(top) {
  return `<div class="ranking">${top.map(([k,p],i)=>`<div class="rank-item"><button data-action="candidate" data-id="${k}"><span>${i+1}</span><strong>${esc(nameOf(k))}</strong><b>${pct(p)}</b></button><div class="rank-bar"><i style="width:${Math.max(.1,p*100)}%"></i></div></div>`).join("")}</div>`;
}
function traceSummary() {
  if(!result){inspect('<span class="tag">DECISION PATH</span><h2>Follow the evidence</h2><p>Select a compound and trace its stored simulated test reading through the unchanged v7 engine. The path will be highlighted on the full network.</p><p class="note">The engine scores every library candidate after each answer. The gold sequence is specific to this reading; it is not a fixed decision tree.</p>');return;}
  currentStep=result.steps.length;selectNode("output");
  cy.edges(".trace-link").addClass("active-path");
  const stops={confidence:"Posterior reached 99.9%",question_limit:"60-question limit",no_useful_question:"No useful eligible question"};
  inspect(`<span class="tag">PATH COMPLETE · ${result.steps.length} ANSWERS</span><h2>${esc(nameOf(result.k))}</h2><p>${esc(library.formula[result.k])} · CID ${library.id[result.k]}</p><div class="navigation-row">${result.steps.length?`<button data-action="step" data-id="${result.steps.length-1}">← Last question</button><button class="primary" data-action="step" data-id="0">Restart path ↻</button>`:""}</div><div class="detail-list">${detail("Evidence",result.evidence==="all"?"IR + MS + NMR":"NMR + MS")}${detail("Leading candidate",result.top[0][0]===result.k?"Selected compound":"Different compound")}${detail("Selected compound rank",fmt(result.targetRank))}${detail("Stopping reason",stops[result.stopReason])}</div><div class="microheading">FINAL RANKING · MODEL POSTERIOR</div>${rankings(result.top)}${button("focus-path","","Fit the highlighted path","wide")}${button("export-trace","","Download decision path JSON ↓","wide")}<p class="note">Gold arrows connect questions in the order actually selected for v7 test draw 0. All ${fmt(meta.N)} candidates were scored at every step. Posterior is not measured accuracy.</p>`);
  syncStepList();
}
function buildStepList() {
  $("step-list").innerHTML=result?result.steps.map((s,i)=>{const q=meta.questions[s.q],t=TECH[q.tech];return `<button class="step-link" data-step="${i}" title="${esc(q.text)} — ${esc(answerText(q,s.a))}" style="--chip:${t.fill};--color:${t.color}"><span>${i+1}</span><strong>${esc(q.text)}<small>${esc(answerText(q,s.a))}</small></strong></button>`;}).join(""):"";
  syncStepList();
}
function syncStepList() {
  let active;
  document.querySelectorAll(".step-link").forEach(b=>{
    const isCurrent=+b.dataset.step===currentStep;
    b.classList.toggle("active",isCurrent);b.classList.toggle("completed",+b.dataset.step<currentStep);
    if(isCurrent){b.setAttribute("aria-current","step");active=b;}else b.removeAttribute("aria-current");
  });
  $("step-progress").textContent=result?(currentStep>=result.steps.length?"Complete":`${Math.max(0,currentStep+1)} / ${result.steps.length}`):"";
  const list=$("step-list");
  if(active&&list.clientHeight){const top=active.offsetTop,bottom=top+active.offsetHeight;if(top<list.scrollTop)list.scrollTop=top;else if(bottom>list.scrollTop+list.clientHeight)list.scrollTop=bottom-list.clientHeight;}
}
function showStep(i,focus=false) {
  if(!result)return;
  if(view!=="trace")setView("trace",false);
  currentStep=i;cy.edges().removeClass("active-path");syncStepList();
  if(i<0){selectNode("library");inspect(`<span class="tag">BEFORE ANY ANSWERS</span><h2>Uniform prior</h2><p>Each of the ${fmt(meta.N)} candidates starts with the same probability.</p><div class="probability">${pct(1/meta.N)}</div>${button("step",0,"First decision →","primary")}`);if(focus)focusNode("library");return;}
  if(i>=result.steps.length){traceSummary();if(focus)focusNode("output");return;}
  const s=result.steps[i],q=meta.questions[s.q];
  cy.edges(".trace-link").filter(e=>e.data("targetStep")<=i).addClass("active-path");selectNode(`q-${s.q}`);
  inspect(`<span class="tag">QUESTION ${i+1} / ${result.steps.length}</span>${questionMarkup(q,s.a)}<div class="recorded-answer"><span>Selected answer</span><strong>${esc(answerText(q,s.a))}</strong><small>From this molecule’s stored reading</small></div><div class="navigation-row trace-navigation"><button data-action="step" data-id="${i-1}" ${i===0?"disabled":""}>← Previous</button><button class="primary" data-action="step" data-id="${i+1}">${i+1===result.steps.length?"View result":"Next"} →</button></div><details class="trace-ranking"><summary>Candidate ranking after this answer</summary><div class="detail-list">${detail("Selected compound rank",fmt(s.targetRank))}${detail("Candidates scored",fmt(meta.N))}</div><div class="microheading">MODEL POSTERIOR</div>${rankings(s.top)}</details>${button("locate-question",q.index,"Inspect question in the bank ↗","wide")}<p class="note">Next follows the recorded decision path for this molecule. The highlighted answer comes from its stored simulated reading.</p>`);
  const answers=$("inspector-content").querySelector(".answer-list"),picked=answers.querySelector(".picked");
  if(picked)answers.scrollTop=Math.max(0,picked.offsetTop-(answers.clientHeight-picked.offsetHeight)/2);
  syncStepList();
  if(focus)focusNode(`q-${s.q}`);
}

function setView(next,showDetails=true) {
  view=next;activeSection=null;activeDetail=null;
  document.querySelector(".workspace").classList.toggle("trace-view",view==="trace");
  document.querySelectorAll("[data-view]").forEach(b=>{b.classList.toggle("active",b.dataset.view===view);b.setAttribute("aria-current",b.dataset.view===view?"page":"false");});
  $("architecture-controls").hidden=false;$("question-tools").hidden=view!=="questions";$("step-navigation").hidden=view!=="trace"||!result;
  const headings={architecture:["01 / FULL MODEL NETWORK","Full model network",`645 question nodes · ${fmt(meta.N)} compounds in 106 expandable groups`],questions:["02 / COMPLETE QUESTION BANK","All 645 questions","Every question is visible. Click a technique, family or individual question."],trace:["03 / ACTUAL DECISION PATH",result?nameOf(result.k):"Follow a decision path",result?`${result.steps.length} decisions · ${result.evidence==="all"?"All techniques":"NMR + MS"} · gold arrows show question order`:"Trace any compound to highlight its decisions on the complete network."]};
  const [eyebrow,title,description]=headings[view];$("view-eyebrow").textContent=eyebrow;$("view-title").textContent=title;$("view-description").textContent=description;
  rebuildNetwork();buildStepList();
  if(showDetails){if(view==="trace"){if(result)showStep(Math.max(0,currentStep));else traceSummary();}else if(view==="questions")inspect(`<span class="tag">ALL QUESTIONS VISIBLE</span><h2>645 question nodes</h2><p>Click any dot for its wording and answer categories. Search by question text or ID. Choose a technique to zoom into its question families.</p><div class="node-list">${ORDER.map(t=>button("tech",t,`${TECH[t].short} · ${TECH[t].name}<small>${meta.techniqueCounts[t]}</small>`)).join("")}</div><p class="note">Each question is linked to its family and the learned answer model. Graph proximity does not encode question similarity.</p>`);else showOverview();}
}
function cancelTrace(silent=false) {
  requestId++;if(worker){worker.terminate();worker=null;}busy=false;
  $("trace-button").disabled=selectedK===null;$("cancel-trace").hidden=true;$("trace-status").textContent=silent?"":"Calculation cancelled.";
}
function choose(k) {
  if(busy)cancelTrace(true);selectedK=k;result=null;currentStep=-1;
  $("search-results").innerHTML="";$("compound-search").value="";
  if(window.SpecTreeMolecule)window.SpecTreeMolecule.mount($("chosen-compound"),{k,library});
  else $("chosen-compound").innerHTML=`<strong>${esc(nameOf(k))}</strong><small>${esc(library.formula[k])} · CID ${esc(library.id[k])}</small>`;
  $("chosen-compound").insertAdjacentHTML("beforeend",button("locate-compound",k,"Locate in network","subtle"));
  $("trace-button").disabled=false;$("trace-status").textContent="";$("step-navigation").hidden=true;
  if(view==="trace")setView("trace");
}
function searchCompounds(text) {
  const t=text.trim().toLowerCase();if(!t)return[];const exact=[],prefix=[],inside=[],numeric=/^\d+$/.test(t);
  for(let k=0;k<meta.N;k++){const name=lowerNames[k],id=String(library.id[k]),formula=library.formula[k].toLowerCase();if((numeric&&id===t)||name===t||formula===t)exact.push(k);else if((numeric&&id.startsWith(t))||name.startsWith(t))prefix.push(k);else if(name.includes(t))inside.push(k);}
  const byLength=(a,b)=>nameOf(a).length-nameOf(b).length;prefix.sort(byLength);inside.sort(byLength);
  return [...exact,...prefix,...inside].slice(0,30);
}
function startTrace() {
  if(selectedK===null||busy)return;busy=true;const rid=++requestId;
  $("trace-button").disabled=true;$("cancel-trace").hidden=false;$("trace-status").classList.remove("error");$("trace-status").textContent="Loading the full model and selected reading…";
  if(!worker){
    worker=new Worker("trace-worker.js");
    worker.onerror=e=>{cancelTrace(true);$("trace-status").textContent=`Could not run the model: ${e.message||"worker failed"}`;$("trace-status").classList.add("error");};
    worker.onmessage=({data:d})=>{
      if(d.requestId!==requestId)return;
      if(d.type==="progress"){$("trace-status").textContent=`Decision ${d.step} · leading posterior ${pct(d.p1)}`;return;}
      busy=false;$("trace-button").disabled=false;$("cancel-trace").hidden=true;
      if(d.type==="error"){$("trace-status").textContent=d.message;$("trace-status").classList.add("error");return;}
      if(d.type==="result"){result=d;currentStep=0;$("trace-status").textContent=`Ready: ${d.steps.length} decisions. Use Next to follow the path.`;setView("trace",false);showStep(0,true);toast("Path ready. Follow each question with Next, or select a step below the inspector.");}
    };
  }
  worker.postMessage({type:"trace",requestId:rid,k:selectedK,evidence:$("evidence").value});
}
function download(blob,name) { const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000); }
function exportTrace() {
  if(!result)return;
  const out={model:"SpecTree v7",built:meta.built,modelSha256:meta.provenance.modelSha256,candidateCount:meta.N,compound:{index:result.k,cid:library.id[result.k],name:nameOf(result.k),formula:library.formula[result.k]},reading:meta.provenance.answerSource,...result,steps:result.steps.map((s,i)=>({...s,step:i+1,question:meta.questions[s.q],answer:answerText(meta.questions[s.q],s.a),top:s.top.map(([k,p])=>({index:k,cid:library.id[k],name:nameOf(k),posterior:p}))}))};
  download(new Blob([JSON.stringify(out,null,2)],{type:"application/json"}),`spectree-v7-CID-${library.id[result.k]}-${result.evidence}.json`);
}
function handleAction(action,id) {
  if(action==="section"){showSection(id);focusNode(id);}
  else if(action==="toggle-section"){expandedSections.has(id)?expandedSections.delete(id):expandedSections.add(id);rebuildNetwork(false);showSection(id);}
  else if(action==="component"){const [s,d]=id.split(":");expandedSections.add(s);rebuildNetwork(false);showSection(s,d);focusNode(`component-${s}-${d}`);}
  else if(action==="view")setView(id);
  else if(action==="tech"){showTech(id);focusNodes(cy.nodes().filter(n=>n.data("tech")===id),2);}
  else if(action==="focus-tech")focusNodes(cy.nodes().filter(n=>n.data("tech")===id),2);
  else if(action==="family"){showFamily(id);focusNodes(cy.nodes().filter(n=>n.data("family")===id),2.5);}
  else if(action==="focus-family")focusNodes(cy.nodes().filter(n=>n.data("family")===id),2.5);
  else if(action==="question"){showQuestion(+id);focusNode(`q-${id}`);}
  else if(action==="locate-question")showQuestionAt(+id);
  else if(action==="toggle-chunk"){const k=+id;expandedChunks.has(k)?expandedChunks.delete(k):expandedChunks.add(k);rebuildNetwork(false);showChunk(k);focusNodes(cy.nodes().filter(n=>n.data("chunk")===k),2);}
  else if(action==="focus-chunk")focusNodes(cy.nodes().filter(n=>n.data("chunk")===+id),3);
  else if(action==="candidate")showCandidate(+id);
  else if(action==="choose-candidate"){choose(+id);setView("trace");}
  else if(action==="locate-compound")locateCompound(+id);
  else if(action==="step")showStep(+id,true);
  else if(action==="return-path"){setView("trace",false);showStep(currentStep);}
  else if(action==="focus-path")focusNodes(cy.nodes(".trace-step"),2);
  else if(action==="export-trace")exportTrace();
}

function wireControls() {
  document.querySelector(".inspector").addEventListener("click",event=>{
    inspectorActionFocused = event.target.closest("button") === document.activeElement;
    setTimeout(()=>{ inspectorActionFocused = false; },0);
  },true);
  document.querySelectorAll("[data-view]").forEach(b=>b.onclick=()=>setView(b.dataset.view));
  for(const id of ["inspector-content","chosen-compound"]){$(id).onclick=e=>{const b=e.target.closest("button[data-action]");if(b)handleAction(b.dataset.action,b.dataset.id);};}
  $("toggle-inspector").onclick=()=>openInspector(document.querySelector(".workspace").classList.contains("inspector-closed"));$("close-inspector").onclick=()=>openInspector(false);
  $("clear-selection").onclick=()=>{cy.elements().removeClass("selected active-path");view==="trace"?traceSummary():showOverview();renderNodeTable();};
  $("step-list").onclick=e=>{const b=e.target.closest("button[data-step]");if(b)showStep(+b.dataset.step,true);};
  $("expand-all").onclick=()=>{SECTIONS.forEach(s=>expandedSections.add(s.id));rebuildNetwork();refreshInspector();};
  $("collapse-all").onclick=()=>{expandedChunks.clear();expandedSections.clear();rebuildNetwork();refreshInspector();};
  $("fit-map").onclick=fitMap;$("focus-selection").onclick=focusSelection;
  $("reset-map").onclick=()=>{expandedChunks.clear();expandedSections.clear();$("label-mode").value="auto";$("node-scale").value="1";$("model-links").checked=true;rebuildNetwork();refreshInspector();};
  $("zoom-in").onclick=()=>cy.zoom({level:Math.min(12,cy.zoom()*1.35),renderedPosition:{x:cy.width()/2,y:cy.height()/2}});
  $("zoom-out").onclick=()=>cy.zoom({level:Math.max(.03,cy.zoom()/1.35),renderedPosition:{x:cy.width()/2,y:cy.height()/2}});
  for(const id of ["label-mode","model-links"]){$(id).onchange=()=>{applyDisplay();drawMinimap();};}$("node-scale").oninput=()=>{applyDisplay();drawMinimap();};
  $("export-image").onclick=async()=>{try{download(await cy.png({output:"blob-promise",full:true,bg:"#fff",maxWidth:5000,maxHeight:5000}),`spectree-v7-${view}.png`);}catch(e){toast(`Could not export: ${e.message}`);}};
  $("toggle-table").onclick=()=>{$("node-table").hidden=!$("node-table").hidden;$("toggle-table").setAttribute("aria-expanded",String(!$("node-table").hidden));renderNodeTable();requestAnimationFrame(()=>{cy.resize();updateMiniViewport();});};
  $("table-filter").oninput=()=>{tablePage=0;renderNodeTable();};$("table-prev").onclick=()=>{tablePage--;renderNodeTable();};$("table-next").onclick=()=>{tablePage++;renderNodeTable();};
  $("node-table-body").onclick=e=>{const row=e.target.closest("[data-node]");if(row){const n=cy.getElementById(row.dataset.node);inspectNode(n);focusNode(n.id());}};
  $("mini-canvas").onclick=e=>{if(!miniTransform)return;const r=e.currentTarget.getBoundingClientRect(),{s,ox,oy}=miniTransform;const x=((e.clientX-r.left)*190/r.width-ox)/s,y=((e.clientY-r.top)*125/r.height-oy)/s;cy.pan({x:cy.width()/2-x*cy.zoom(),y:cy.height()/2-y*cy.zoom()});};
  let searchTimer;
  $("compound-search").oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{const text=$("compound-search").value,hits=searchCompounds(text);$("search-results").innerHTML=!text.trim()?"":hits.length?hits.map(k=>`<button class="search-result" data-k="${k}"><strong>${esc(nameOf(k))}</strong><small>${esc(library.formula[k])} · CID ${esc(library.id[k])}</small></button>`).join(""):'<div class="no-results">No matching compound.</div>';},140);};
  $("compound-search").onkeydown=e=>{if(e.key==="Escape")$("search-results").innerHTML="";if(e.key==="ArrowDown"){$("search-results").querySelector("button")?.focus();e.preventDefault();}if(e.key==="Enter"){clearTimeout(searchTimer);const first=searchCompounds($("compound-search").value)[0];if(first!==undefined)choose(first);}};
  $("search-results").onclick=e=>{const b=e.target.closest("button[data-k]");if(b)choose(+b.dataset.k);};
  $("random-button").onclick=()=>choose(Math.floor(Math.random()*meta.N));$("empty-random").onclick=()=>{choose(Math.floor(Math.random()*meta.N));startTrace();};
  $("trace-button").onclick=startTrace;$("cancel-trace").onclick=()=>cancelTrace();
  $("evidence").onchange=()=>{if(busy)cancelTrace();if(result)$("trace-status").textContent="Evidence changed. Trace again to calculate this mode.";if(activeSection)showSection(activeSection,activeDetail);};
  $("question-search").oninput=()=>{const text=$("question-search").value.trim().toLowerCase(),hits=meta.questions.filter(q=>q.text.toLowerCase().includes(text)||q.id.toLowerCase().includes(text)).slice(0,40);$("question-results").innerHTML=!text?"":hits.length?hits.map(q=>`<button class="search-result" data-q="${q.index}"><strong>${esc(q.text)}</strong><small>${esc(q.id)}</small></button>`).join(""):'<div class="no-results">No matching question.</div>';};
  $("question-results").onclick=e=>{const b=e.target.closest("button[data-q]");if(b)showQuestionAt(+b.dataset.q);};
}

async function init() {
  try {
    if(typeof cytoscape!=="function"||typeof SpecTreeNetwork==="undefined")throw new Error("A viewer script could not load. Keep the vendor and network-layout files with the map.");
    const responses=await Promise.all([fetch("data/meta.json"),fetch("data/library.json")]);if(responses.some(r=>!r.ok))throw new Error("A required model or compound-library file could not be loaded.");
    [meta,library]=await Promise.all(responses.map(r=>r.json()));if(library.id.length!==meta.N||meta.questions.length!==meta.Q)throw new Error("Model and library counts do not match.");
    lowerNames=library.name.map(n=>(n||"").toLowerCase());families=SpecTreeNetwork.familyList(meta);
    cy=cytoscape({container:$("cy"),style:graphStyles(),elements:[],minZoom:.03,maxZoom:12,wheelSensitivity:.17,boxSelectionEnabled:false,autounselectify:true});
    cy.on("pan zoom",updateZoom);cy.on("tap","node",e=>inspectNode(e.target));
    cy.on("tap","edge.trace-link",e=>showStep(e.target.data("targetStep"),true));
    cy.on("dbltap","node",e=>{const d=e.target.data();if(d.kind==="library-chunk")handleAction("toggle-chunk",d.chunk);else if(d.kind==="section")handleAction("toggle-section",d.section);else focusNode(e.target.id());});
    new ResizeObserver(()=>{cy.resize();updateMiniViewport();}).observe($("cy"));
    wireControls();$("dataset-status").textContent=`${fmt(meta.N)} compounds · ${meta.Q} questions`;$("library-status").textContent=`${fmt(meta.N)} compounds available`;
    $("compound-search").disabled=false;$("random-button").disabled=false;$("map-loading").hidden=true;
    setView("architecture",false);$("inspector-content").innerHTML=overviewMarkup();openInspector(false);
    const params=new URLSearchParams(location.search),deepCid=params.get("cid")||(params.has("demo")?"2519":null);
    if(deepCid){const k=library.id.findIndex(id=>String(id)===deepCid);if(k>=0){if(params.get("evidence")==="nmr_ms")$("evidence").value="nmr_ms";choose(k);startTrace();}else toast(`CID ${deepCid} is not in the library.`);}
  } catch(e) {
    const loading = $("map-loading");
    loading.hidden=false;
    loading.setAttribute("role","alert");
    loading.innerHTML=`<h2>The map could not open</h2><p>One of the files needed for this view did not load. Try again, or return home to choose another view.</p><button type="button" id="retry-map">Try again</button><p><a href="./">Back to home</a></p><details><summary>Technical details</summary><p>${esc(e.message)}</p></details>`;
    $("retry-map").onclick=()=>{ $("retry-map").disabled=true; $("retry-map").textContent="Reopening…"; location.reload(); };
    $("dataset-status").textContent="Map unavailable";
    console.error(e);
  }
}
init();
