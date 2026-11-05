/* Full-library adaptive decision-prefix tree. Cytoscape owns the interactive graph. */
(function (global) {
  "use strict";

  const COLORS = {MS:"#5089c4", IR:"#d69a36", "1H":"#da7873", "13C":"#a181c7", terminal:"#459f94"};
  const REASONS = {1:"Posterior threshold reached", 2:"60-answer limit", 3:"No useful question remains"};
  const DTYPES = {int32:Int32Array, uint32:Uint32Array, int16:Int16Array, uint16:Uint16Array, uint8:Uint8Array, float64:Float64Array};
  const REQUIRED = ["parent","q","answer","depth","count","terminalReason","topIndex","p1","lo","compoundLeaf","orderedCompounds"];
  const fmt = n => Number(n).toLocaleString("en-US");
  const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const nodeId = id => `pt-${id}`;
  const numberId = id => Number(String(id).replace(/^pt-/, ""));
  const percent = p => `${(p * 100).toFixed(p < .0001 ? 5 : 2)}%`;

  function decode(schema, buffer) {
    if (!(buffer instanceof ArrayBuffer)) throw new Error("The tree binary could not be read.");
    const arrays = {};
    const blocks = Array.isArray(schema.blocks) ? schema.blocks : Object.entries(schema.blocks || {}).map(([name,b]) => ({name,...b}));
    for (const block of blocks) {
      const Type = DTYPES[block.dtype];
      if (!Type) throw new Error(`Unsupported tree array type: ${block.dtype}`);
      const offset = block.offset ?? block.byteOffset;
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(block.length) || offset < 0 || block.length < 0 || offset + block.length * Type.BYTES_PER_ELEMENT > buffer.byteLength) throw new Error(`Invalid tree array: ${block.name}`);
      // The exporter pads each block to its element alignment. Copy only if an older export did not.
      arrays[block.name] = offset % Type.BYTES_PER_ELEMENT ? new Type(buffer.slice(offset, offset + block.length * Type.BYTES_PER_ELEMENT)) : new Type(buffer, offset, block.length);
    }
    return arrays;
  }

  function prepare(arrays, compoundCount) {
    for (const name of REQUIRED) if (!arrays[name]) throw new Error(`Tree data is missing ${name}.`);
    const n = arrays.parent.length;
    if (!n) throw new Error("The tree is empty.");
    for (const name of REQUIRED.slice(0,9)) if (arrays[name].length !== n) throw new Error(`Tree array length differs: ${name}`);
    if (arrays.compoundLeaf.length !== compoundCount || arrays.orderedCompounds.length !== compoundCount) throw new Error("The tree does not cover the complete library.");
    const firstChild = new Int32Array(n).fill(-1), nextSibling = new Int32Array(n).fill(-1);
    let root = -1;
    for (let i = n - 1; i >= 0; i--) {
      const parent = arrays.parent[i];
      if (parent < 0) { if (root !== -1) throw new Error("The tree has more than one root."); root = i; }
      else {
        if (parent >= n || parent === i || arrays.depth[parent] + 1 !== arrays.depth[i]) throw new Error(`Invalid tree parent at node ${i}.`);
        nextSibling[i] = firstChild[parent]; firstChild[parent] = i;
      }
      if (!arrays.count[i] || arrays.lo[i] + arrays.count[i] > compoundCount) throw new Error(`Invalid reading interval at node ${i}.`);
    }
    if (root < 0 || arrays.count[root] !== compoundCount || arrays.lo[root] !== 0) throw new Error("The root does not represent the complete library.");
    const seen = new Uint8Array(compoundCount);
    for (let i = 0; i < compoundCount; i++) {
      const k = arrays.orderedCompounds[i], leaf = arrays.compoundLeaf[k];
      if (k < 0 || k >= compoundCount || seen[k] || leaf < 0 || leaf >= n || arrays.q[leaf] !== -1 || i < arrays.lo[leaf] || i >= arrays.lo[leaf] + arrays.count[leaf]) throw new Error("Compound membership in the tree is incomplete or inconsistent.");
      seen[k] = 1;
    }
    for (let i = 0; i < n; i++) {
      let total = 0, children = 0;
      for (let child = firstChild[i]; child >= 0; child = nextSibling[child]) { total += arrays.count[child]; children++; }
      if ((arrays.q[i] < 0 && children) || (arrays.q[i] >= 0 && (!children || total !== arrays.count[i]))) throw new Error(`Reading counts do not partition at node ${i}.`);
      if (arrays.q[i] < -1 || (arrays.q[i] < 0 && !REASONS[arrays.terminalReason[i]])) throw new Error(`Invalid terminal state at node ${i}.`);
    }
    return {...arrays, firstChild, nextSibling, root, nodeCount:n, compoundCount};
  }

  function children(model, id) {
    const result = [];
    for (let c = model.firstChild[id]; c >= 0; c = model.nextSibling[c]) result.push(c);
    return result.sort((a,b) => model.lo[a] - model.lo[b]);
  }

  function ancestors(model, id) {
    const path = [];
    for (let i = id; i >= 0; i = model.parent[i]) path.push(i);
    return path.reverse();
  }

  class Heap {
    constructor() { this.items = []; }
    push(value) {
      const a = this.items; a.push(value); let i = a.length - 1;
      while (i) { const p = (i - 1) >> 1; if (a[p].score >= value.score) break; a[i] = a[p]; i = p; } a[i] = value;
    }
    pop() {
      const a = this.items, top = a[0], last = a.pop();
      if (a.length) {
        let i = 0;
        while (i * 2 + 1 < a.length) {
          let c = i * 2 + 1;
          if (c + 1 < a.length && a[c + 1].score > a[c].score) c++;
          if (a[c].score <= last.score) break;
          a[i] = a[c]; i = c;
        }
        a[i] = last;
      }
      return top;
    }
  }

  function initialExpansion(model, root = model.root, budget = 4500) {
    const expanded = new Set(), queue = new Heap(); let visible = 1;
    const offer = id => { if (model.firstChild[id] >= 0) queue.push({id,score:model.count[id] / Math.sqrt(1 + model.depth[id] - model.depth[root])}); };
    offer(root);
    while (queue.items.length) {
      const {id} = queue.pop(), kids = children(model,id);
      if (visible + kids.length > budget) continue;
      expanded.add(id); visible += kids.length;
      kids.forEach(offer);
    }
    return expanded;
  }

  function projection(model, expanded, root = model.root) {
    const ids = [], frontier = [], stack = [root], visibleChildren = new Map(), depthCounts = [];
    let maxDepth = model.depth[root], covered = 0;
    while (stack.length) {
      const id = stack.pop(); ids.push(id); maxDepth = Math.max(maxDepth,model.depth[id]);
      const kids = expanded.has(id) ? children(model,id) : [];
      visibleChildren.set(id,kids);
      const depth = model.depth[id]-model.depth[root];
      depthCounts[depth] = (depthCounts[depth]||0)+1;
      if (kids.length) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
      else { frontier.push(id); covered += model.count[id]; }
    }
    // Allocate angular space to the visible descendants, never to a sampled subset.
    // Small root branches retain a little space; larger branches receive larger sectors.
    const demand = new Map(), ranges = new Map(), angles = new Map();
    for (let i = ids.length - 1; i >= 0; i--) {
      const id = ids[i], kids = visibleChildren.get(id);
      demand.set(id,kids.length?kids.reduce((sum,child)=>sum+demand.get(child),0):1);
    }
    ranges.set(root,[-Math.PI/2,Math.PI*1.5]);
    for (const id of ids) {
      const [start,end] = ranges.get(id), span = end-start, kids = visibleChildren.get(id);
      angles.set(id,(start+end)/2);
      if (!kids.length) continue;
      const isRoot = id===root, gaps = kids.length>1?(isRoot?kids.length:kids.length-1):0;
      const gap = gaps ? Math.min(isRoot ? 0.04 : 0.025,span*0.12/gaps) : 0;
      const available = span-gap*gaps;
      const weights = kids.map(child=>isRoot?Math.max(8,demand.get(child)):demand.get(child));
      const total = weights.reduce((sum,value)=>sum+value,0);
      let cursor = start+(isRoot?gap/2:0);
      kids.forEach((child,i)=>{
        const size = available*weights[i]/total;
        ranges.set(child,[cursor,cursor+size]); cursor+=size+gap;
      });
    }
    // Dense levels receive wider radial bands. Stagger nodes within those bands
    // to use their area instead of stacking thousands of nodes on one circle.
    // Adjacent bands stay disjoint, so every answer edge travels outward.
    const levels = maxDepth-model.depth[root], radii = [0], gaps = [0], ranks = [];
    for(let depth=1;depth<=levels;depth++) {
      gaps[depth] = Math.max(depth===1?520:240,18*Math.sqrt(depthCounts[depth]||1));
      radii[depth] = radii[depth-1]+gaps[depth];
    }
    const positions = new Map([[root,{x:0,y:0}]]);
    for(const id of ids) {
      if(id===root)continue;
      const depth = model.depth[id]-model.depth[root], rank = ranks[depth]||0;
      ranks[depth] = rank+1;
      const amplitude = depth>1 && depthCounts[depth]>1 ? 0.28*Math.min(gaps[depth],gaps[depth+1]||gaps[depth]) : 0;
      const stagger = ((rank*.618033988749895)%1-.5)*2;
      const radius = radii[depth]+amplitude*stagger, angle = angles.get(id);
      positions.set(id,{x:radius*Math.cos(angle),y:radius*Math.sin(angle)});
    }
    // Keep the drawing scale comparable across overview, subtrees and long paths,
    // so fitting a deep trace does not shrink its node glyphs to invisible specks.
    const outerRadius = Math.max(1,...ids.map(id=>Math.hypot(positions.get(id).x,positions.get(id).y)));
    const scale = Math.min(1,1800/outerRadius);
    if(scale<1)for(const position of positions.values()){position.x*=scale;position.y*=scale;}
    const xs = ids.map(id=>positions.get(id).x), ys = ids.map(id=>positions.get(id).y);
    const width = Math.max(...xs)-Math.min(...xs), height = Math.max(...ys)-Math.min(...ys);
    return {ids,frontier,positions,ranges,covered,width,height,maxDepth,root,layout:"radial"};
  }

  function create(options) {
    const host = options.container;
    if (!host) throw new Error("A path-tree container is required.");
    const meta = options.meta, library = options.library;
    const manifestUrl = options.manifestUrl || "data/path_tree_all/schema.json";
    const initialBudget = options.initialBudget || 4500, maxVisible = options.maxVisible || 8500;
    let cy, model, schema, scope, projected, expanded = new Set(), selectedNode = null, selectedK = null;
    let selectedPath = new Set(), memberPage = 0, visible = true, destroyed = false, rendering = false, loading = false;
    let retryTimer, lodTimer, labelTimer, noticeTimer, searchTimer, nodeTapTimer, lastTap = -1, lastTapTime = 0, labelMode = "auto", autoDetail = true, baseZoom = 1, lodPauseUntil = 0, miniTransform;
    let inspectorActionFocused = false;
    const outcomeCache = new Map();
    const element = className => host.querySelector(`.${className}`);
    const named = k => library.name[k] || `CID ${library.id[k]}`;
    const answerText = (q,a) => {
      const question = meta.questions[q];
      return question ? `${question.options?.[a] ?? a}${question.unit ? ` ${question.unit}` : ""}` : String(a);
    };
    host.classList.add("pt-viewer");
    host.innerHTML = `<div class="pt-graph" role="img" aria-label="Radial v7 stored-reading decision tree. Branches spread outward in all directions. Drag to pan, scroll to zoom; search or use the branch inspector to navigate."></div>
      <div class="pt-top"><div class="pt-title"><span class="pt-eyebrow">FULL LIBRARY · 360° DECISION PATHS</span><h1>Full-library decision tree</h1><p class="pt-coverage" role="status">Opening the path tree…</p></div>
        <div class="pt-search-wrap"><label for="pt-compound-search">Find a compound in the tree</label><div class="pt-search-input"><span aria-hidden="true">⌕</span><input id="pt-compound-search" class="pt-search" type="search" aria-label="Find a compound in the tree" placeholder="Name, formula or PubChem CID" autocomplete="off" disabled><button class="pt-clear-search" title="Clear search" aria-label="Clear search">×</button></div><div class="pt-search-results" role="list"></div></div></div>
      <div class="pt-scope" hidden><button data-pt-action="all">← Whole tree</button><span class="pt-scope-label"></span></div>
      <div class="pt-selection" hidden><span></span><button data-pt-action="fit-path">Fit path</button><button data-pt-action="clear-path" aria-label="Clear highlighted path">×</button></div>
      <div class="pt-toolbar"><button data-pt-action="zoom-in" aria-label="Zoom in">+</button><button data-pt-action="zoom-out" aria-label="Zoom out">−</button><span class="pt-zoom">100%</span><button data-pt-action="fit">Fit tree</button><button data-pt-action="reset">Reset</button><button data-pt-action="details">Details</button><button data-pt-action="export" title="Download the current view as a PNG">↓ PNG</button><label>Labels<select class="pt-labels"><option value="auto">Auto</option><option value="all">All</option><option value="off">Off</option></select></label><label class="pt-auto"><input type="checkbox" checked> Reveal on zoom</label></div>
      <div class="pt-legend"><span><i style="background:${COLORS.MS}"></i>MS</span><span><i style="background:${COLORS.IR}"></i>IR</span><span><i style="background:${COLORS["1H"]}"></i>¹H</span><span><i style="background:${COLORS["13C"]}"></i>¹³C</span><span><i style="background:${COLORS.terminal}"></i>Endpoint</span><small>Outward = later decisions · Thicker = more readings</small></div>
      <div class="pt-mini"><canvas width="210" height="130" aria-label="Tree overview; click to pan"></canvas><div class="pt-mini-viewport"></div><span>TREE OVERVIEW</span></div>
      <div class="pt-bottom"><span class="pt-graph-count"></span><span>Drag to pan · Scroll to zoom · Double-click to expand</span></div>
      <aside class="pt-inspector" aria-label="Branch details" hidden><div class="pt-inspector-head"><span class="pt-eyebrow">BRANCH INSPECTOR</span><button data-pt-action="close-details" aria-label="Close branch details">×</button></div><div class="pt-detail-content"></div></aside>
      <div class="pt-loading"><span class="pt-loader"></span><h2>Opening all stored paths</h2><p>Reading the complete v7 path index.</p><button data-pt-action="retry" hidden>Retry</button></div><div class="pt-notice" role="status" hidden></div>`;

    function notice(text) {
      const target = element("pt-notice"); target.textContent = text; target.hidden = false;
      clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { target.hidden = true; },5000);
    }
    function cancelNodeTap() {
      clearTimeout(nodeTapTimer); nodeTapTimer = undefined; lastTap = -1; lastTapTime = 0;
    }
    function status() {
      if (!projected) return;
      const whole = scope === model.root;
      element("pt-coverage").textContent = whole ? `All ${fmt(model.compoundCount)} stored readings represented · IR + MS + ¹H + ¹³C NMR` : `${fmt(model.count[scope])} readings in this branch · full library: ${fmt(model.compoundCount)}`;
      const aggregates = projected.frontier.filter(id => model.q[id] >= 0).length;
      element("pt-graph-count").textContent = `${fmt(projected.ids.length)} visible ${projected.ids.length===1?"node":"nodes"} · ${fmt(aggregates)} expandable ${aggregates===1?"branch":"branches"} · ${fmt(projected.covered)} readings represented`;
      element("pt-scope").hidden = whole;
      element("pt-scope-label").textContent = `Branch after ${model.depth[scope]} ${model.depth[scope]===1?"answer":"answers"} · ${fmt(model.count[scope])} readings`;
      options.onStatus?.({visibleNodes:projected.ids.length,aggregateNodes:aggregates,representedCount:projected.covered,totalCount:model.compoundCount,scope});
    }
    function styles() {
      return [
        {selector:"node",style:{width:"data(size)",height:"data(size)","background-color":"data(color)","border-width":0,label:"data(label)","font-family":"Segoe UI, Arial, sans-serif","font-size":11,color:"#405768","text-valign":"bottom","text-margin-y":5,"min-zoomed-font-size":9,"overlay-opacity":0}},
        {selector:"edge",style:{width:"data(width)","line-color":"data(color)",opacity:.68,"curve-style":"unbundled-bezier","control-point-distances":0,"control-point-weights":.5,"target-arrow-shape":"none",label:"data(label)","font-size":10,"min-zoomed-font-size":10,"text-rotation":"autorotate",color:"#526c7a","text-background-color":"#fff","text-background-opacity":.85,"text-background-padding":2,"overlay-opacity":0}},
        {selector:".pt-aggregate",style:{shape:"diamond","border-color":"#fff","border-width":.7}},
        {selector:".pt-terminal",style:{shape:"ellipse"}},
        {selector:".pt-root",style:{width:30,height:30,"border-width":2,"border-color":"#fff","font-size":15,"font-weight":600,"min-zoomed-font-size":6}},
        {selector:".pt-muted",style:{opacity:.12}},
        {selector:"edge.pt-path",style:{"line-color":"#a76c00",opacity:1,width:8,"z-index":10,"target-arrow-shape":"triangle","target-arrow-color":"#a76c00","arrow-scale":.65}},
        {selector:"node.pt-path",style:{"border-width":1.5,"border-color":"#a76c00",width:12,height:12,opacity:1,"z-index":11}},
        {selector:".pt-selected",style:{"border-width":3,"border-color":"#173c51",width:14,height:14,label:"data(label)","font-size":13,"font-weight":600,"min-zoomed-font-size":0,"text-background-color":"#fff","text-background-opacity":.94,"text-background-padding":4,"z-index":20,opacity:1}},
        {selector:".pt-all-labels",style:{"min-zoomed-font-size":0}},
        {selector:".pt-auto-hidden",style:{label:""}},
        {selector:".pt-no-labels",style:{label:""}}
      ];
    }
    function graphElements() {
      const output = [], rootCount = model.count[scope], inPath = selectedK !== null;
      for (const id of projected.ids) {
        const q = model.q[id], terminal = q < 0, aggregated = !terminal && !expanded.has(id), question = meta.questions[q];
        const color = terminal ? COLORS.terminal : COLORS[question?.tech] || "#8295a1";
        let label = terminal ? `${fmt(model.count[id])} ${model.count[id] === 1 ? "reading" : "readings"} · endpoint` : `${question?.id || `Question ${q}`} · ${fmt(model.count[id])}`;
        if (id === model.root) label = `${fmt(model.compoundCount)} stored readings`;
        const classes = [terminal?"pt-terminal":"",aggregated?"pt-aggregate":"",id===scope?"pt-root":"",id===selectedNode?"pt-selected":"",selectedPath.has(id)?"pt-path":inPath?"pt-muted":""].filter(Boolean).join(" ");
        output.push({group:"nodes",data:{id:nodeId(id),treeId:id,label,color,count:model.count[id],size:aggregated?8:terminal?4.5:5},position:projected.positions.get(id),classes});
        if (id === scope) continue;
        const parent = model.parent[id], parentQ = model.q[parent], edgeColor = COLORS[meta.questions[parentQ]?.tech] || color;
        output.push({group:"edges",data:{id:`pt-edge-${id}`,source:nodeId(parent),target:nodeId(id),treeId:id,color:edgeColor,width:.8+7*Math.sqrt(model.count[id]/rootCount),label:answerText(parentQ,model.answer[id])},classes:selectedPath.has(id)?"pt-path":inPath?"pt-muted":""});
      }
      return output;
    }
    function render({fit=false,anchor=null}={}) {
      if (!model || destroyed) return;
      rendering = true; clearTimeout(lodTimer); lodPauseUntil = Date.now()+450;
      const old = anchor !== null ? cy.getElementById(nodeId(anchor)) : null;
      const oldPosition = old?.length ? old.renderedPosition() : null, zoom = cy.zoom();
      projected = projection(model,expanded,scope);
      if (projected.covered !== model.count[scope]) throw new Error("The visible branches no longer cover their stored readings.");
      cy.batch(() => { cy.elements().remove(); cy.add(graphElements()); cy.nodes().ungrabify(); });
      if (fit) fitTree();
      else if (oldPosition && projected.positions.has(anchor)) {
        const position = projected.positions.get(anchor);
        cy.viewport({zoom,pan:{x:oldPosition.x-position.x*zoom,y:oldPosition.y-position.y*zoom}});
      }
      applyLabels(); status(); drawMini(); lodPauseUntil = Date.now()+450; rendering = false;
    }
    function applyLabels() {
      clearTimeout(labelTimer);
      if (!cy || destroyed) return;
      const elements=cy.elements();
      cy.batch(()=>{
        elements.removeClass("pt-all-labels pt-no-labels pt-auto-hidden");
        if(labelMode!=="auto") {elements.addClass(labelMode==="all"?"pt-all-labels":"pt-no-labels");return;}
        elements.addClass("pt-auto-hidden");
        cy.edges(".pt-path").removeClass("pt-auto-hidden");
        const zoom=cy.zoom(),width=cy.width(),height=cy.height(),candidates=[],grid=new Map();
        cy.nodes().forEach(node=>{
          const selected=node.hasClass("pt-selected"),root=node.hasClass("pt-root"),forced=selected||root;
          const position=node.renderedPosition(),font=selected?13:root?15:11;
          if(forced)node.removeClass("pt-auto-hidden");
          if(position.x<0||position.x>width||position.y<0||position.y>height||(!forced&&(font*zoom<9||node.hasClass("pt-muted"))))return;
          const labelWidth=Math.max(30,String(node.data("label")).length*font*.56*zoom+14),labelHeight=Math.max(22,font*zoom+12);
          const y=position.y+(node.data("size")/2+5)*zoom;
          candidates.push({node,forced,priority:selected?3:root?2:node.hasClass("pt-path")?1:0,count:node.data("count"),
            x1:position.x-labelWidth/2,x2:position.x+labelWidth/2,y1:y,y2:y+labelHeight});
        });
        candidates.sort((a,b)=>b.priority-a.priority||b.count-a.count);
        for(const candidate of candidates){
          const keys=[];
          for(let x=Math.floor(candidate.x1/140);x<=Math.floor(candidate.x2/140);x++)
            for(let y=Math.floor(candidate.y1/24);y<=Math.floor(candidate.y2/24);y++)keys.push(`${x}:${y}`);
          const overlaps=keys.some(key=>(grid.get(key)||[]).some(other=>candidate.x1<other.x2&&candidate.x2>other.x1&&candidate.y1<other.y2&&candidate.y2>other.y1));
          if(overlaps&&!candidate.forced)continue;
          candidate.node.removeClass("pt-auto-hidden");
          for(const key of keys){if(!grid.has(key))grid.set(key,[]);grid.get(key).push(candidate);}
        }
      });
    }
    function scheduleLabels() {
      clearTimeout(labelTimer);
      if(labelMode==="auto"&&!rendering)labelTimer=setTimeout(applyLabels,150);
    }
    function fitTree() {
      if (!cy?.nodes().length) return;
      lodPauseUntil = Date.now()+700;
      cy.resize(); cy.fit(cy.nodes(),65); baseZoom = cy.zoom(); updateViewport();
    }
    function fitPath() {
      if (!selectedPath.size) return fitTree();
      const path = cy.nodes(".pt-path");
      cy.fit(path,95);
      if (cy.zoom()>2) { cy.zoom(2); cy.center(path); }
      lodPauseUntil = Date.now()+800;
    }
    function focusNode(id) {
      const n = cy.getElementById(nodeId(id));
      if (n.length) { cy.zoom(Math.max(.75,cy.zoom())); cy.center(n); lodPauseUntil=Date.now()+700; }
    }
    function expand(id,automatic=false) {
      if (!model || model.q[id]<0 || expanded.has(id)) return false;
      const kids = children(model,id);
      if (projected.ids.length+kids.length>maxVisible) { if (!automatic) notice("Open this branch on its own to reveal more detail. Every stored reading remains in the tree."); return false; }
      expanded.add(id); render({anchor:id});
      if (!automatic) inspect(id);
      return true;
    }
    function collapse(id) {
      if (!model || !expanded.has(id)) return;
      const stack=[id];
      while (stack.length) { const n=stack.pop(); expanded.delete(n); children(model,n).forEach(c=>{if(expanded.has(c))stack.push(c);}); }
      // Collapsing a highlighted path clears that highlight; it never leaves a broken path on screen.
      if (selectedPath.has(id) && selectedK!==null) clearPath(false);
      selectedNode=id; render({anchor:id}); inspect(id);
    }
    function openBranch(id) {
      scope=id; selectedNode=id; clearPath(false); expanded=initialExpansion(model,scope,initialBudget);
      render({fit:true}); inspect(id); fitTree();
    }
    function wholeTree() {
      if (!model) return;
      scope=model.root; selectedNode=null; clearPath(false); expanded=initialExpansion(model,scope,initialBudget);
      closeInspector(); render({fit:true});
    }
    function clearPath(redraw=true) {
      selectedK=null; selectedPath.clear(); element("pt-selection").hidden=true;
      if (redraw) { render(); if(selectedNode!==null)inspect(selectedNode); }
    }
    function selectCompound(k) {
      if (!model) { notice("The complete path index is still loading."); return false; }
      if (!Number.isInteger(k) || k<0 || k>=model.compoundCount) return false;
      scope=model.root; selectedK=k; selectedNode=model.compoundLeaf[k];
      selectedPath=new Set(ancestors(model,selectedNode));
      expanded=initialExpansion(model,scope,initialBudget);
      for (const id of selectedPath) if(model.q[id]>=0)expanded.add(id);
      element("pt-selection").hidden=false;
      element("pt-selection").querySelector("span").textContent=`${named(k)} · ${model.depth[selectedNode]} decisions`;
      element("pt-search-results").innerHTML="";
      render(); fitPath(); inspect(selectedNode); options.onSelectCompound?.(k);
      return true;
    }
    function outcomes(id) {
      if (outcomeCache.has(id)) return outcomeCache.get(id);
      const reasons={1:0,2:0,3:0}, endpoints=new Set(); let matches=0;
      for(let i=model.lo[id];i<model.lo[id]+model.count[id];i++) {
        const k=model.orderedCompounds[i], leaf=model.compoundLeaf[k];
        endpoints.add(leaf); reasons[model.terminalReason[leaf]]=(reasons[model.terminalReason[leaf]]||0)+1;
        if(model.topIndex[leaf]===k)matches++;
      }
      const result={reasons,matches,endpoints:endpoints.size};
      if(outcomeCache.size>80)outcomeCache.clear(); outcomeCache.set(id,result); return result;
    }
    function inspect(id,keepPage=false) {
      if (!model) return;
      if (!keepPage)memberPage=0;
      selectedNode=id;
      cy.nodes().removeClass("pt-selected"); cy.getElementById(nodeId(id)).addClass("pt-selected");
      const q=model.q[id], question=meta.questions[q], terminal=q<0, count=model.count[id], history=ancestors(model,id), result=outcomes(id);
      const top=model.topIndex[id], pageSize=25, pages=Math.ceil(count/pageSize); memberPage=Math.max(0,Math.min(memberPage,pages-1));
      const members=[]; const from=model.lo[id]+memberPage*pageSize, to=Math.min(model.lo[id]+count,from+pageSize);
      for(let i=from;i<to;i++)members.push(model.orderedCompounds[i]);
      const detail=(label,value)=>`<div class="pt-detail-row"><span>${label}</span><strong>${value}</strong></div>`;
      element("pt-detail-content").innerHTML=`<span class="pt-type" style="--pt-color:${COLORS[question?.tech]||COLORS.terminal}">${id===model.root?"ROOT":terminal?"DECISION ENDPOINT":"QUESTION BRANCH"}</span>
        <h2>${terminal?"End of this decision path":escape(question?.id||"Stored reading tree")}</h2>
        <details class="pt-help"><summary>How to explore</summary><p>Drag the blank canvas to move around. Scroll or pinch to zoom; the + and − buttons work too.</p><p>Select a dot to see its question, then choose an answer branch below to follow the next step. Search for a compound to highlight its stored path. Use <strong>Fit tree</strong> to see the current view, or <strong>Reset</strong> to return to the whole tree.</p></details>
        <div class="pt-stats"><div><b>${fmt(count)}</b><span>stored ${count===1?"reading":"readings"}</span></div><div><b>${model.depth[id]}</b><span>answers so far</span></div></div>
        ${terminal?`<p class="pt-question">${escape(REASONS[model.terminalReason[id]]||"Path ended")}</p>`:`<div class="pt-small-label">NEXT QUESTION · ${escape(question?.tech||"")}</div><p class="pt-question">${escape(question?.text||"")}</p>`}
        <div class="pt-detail-actions">${!terminal?`<button data-pt-action="${expanded.has(id)?"collapse":"expand"}" data-node="${id}">${expanded.has(id)?"Collapse branch":"Expand next answers"}</button><button data-pt-action="branch" data-node="${id}">Open branch ↗</button>`:""}<button data-pt-action="focus" data-node="${id}">Locate node</button></div>
        <div class="pt-detail-list">${detail("Share of the full library",percent(count/model.compoundCount))}${detail("Distinct decision endpoints",fmt(result.endpoints))}${top>=0?detail("Leading candidate after this history",`<button class="pt-text-button" data-pt-compound="${top}">${escape(named(top))}</button>`):""}${Number.isFinite(model.p1[id])?detail("Leading model posterior",percent(model.p1[id])):""}</div>
        ${!terminal?`<div class="pt-small-label">OBSERVED ANSWER BRANCHES</div><div class="pt-answer-list">${children(model,id).map(child=>`<button data-pt-action="inspect-child" data-node="${child}"><span>${escape(answerText(q,model.answer[child]))}</span><b>${fmt(model.count[child])}</b></button>`).join("")}</div>`:""}
        <details class="pt-history" ${history.length<7?"open":""}><summary>Answer history · ${history.length-1} decisions</summary><ol>${history.slice(1).map((n,i)=>{const parent=model.parent[n],prev=meta.questions[model.q[parent]];return `<li><button data-pt-action="history" data-node="${parent}" style="--pt-color:${COLORS[prev?.tech]||COLORS.terminal}"><span>${i+1} · ${escape(prev?.id||"")}</span><strong>${escape(answerText(model.q[parent],model.answer[n]))}</strong><small>${escape(prev?.text||"")}</small></button></li>`;}).join("")||"<li>No answers yet; this is the root.</li>"}</ol></details>
        <details class="pt-outcomes"><summary>Outcomes for these stored readings</summary>${Object.entries(REASONS).map(([code,text])=>detail(text,fmt(result.reasons[code]||0))).join("")}${detail("Leading prediction equals source identity",`${fmt(result.matches)} / ${fmt(count)}`)}<p class="pt-note">These are outcomes for the stored simulated readings, not a measured accuracy estimate or calibrated confidence.</p></details>
        <div class="pt-small-label">COMPOUNDS IN THIS BRANCH</div><div class="pt-members">${members.map(k=>`<button data-pt-compound="${k}" class="${k===selectedK?"pt-member-selected":""}"><strong>${escape(named(k))}</strong><span>CID ${escape(library.id[k])} · ${escape(library.formula[k])}</span></button>`).join("")}</div><div class="pt-pages"><button data-pt-action="members-prev" ${memberPage===0?"disabled":""}>←</button><span>${fmt(memberPage*pageSize+1)}–${fmt(Math.min(count,(memberPage+1)*pageSize))} of ${fmt(count)}</span><button data-pt-action="members-next" ${memberPage>=pages-1?"disabled":""}>→</button></div>
        <p class="pt-note">Each source compound contributes its canonical v7 simulated test reading, draw 0. Branches show the actual adaptive question and answer histories observed across the full library. Other possible answer combinations are not included. Node spacing is for navigation; line width encodes reading count.</p>`;
      openInspector();
      scheduleLabels();
      if(!keepPage)element("pt-inspector").scrollTop=0;
      if(inspectorActionFocused){
        const heading=element("pt-detail-content").querySelector("h2");
        heading.tabIndex=-1;heading.focus({preventScroll:true});
      }
      options.onInspect?.({id,question:q,count,depth:model.depth[id],terminal,history});
    }
    function openInspector() {
      const changed=element("pt-inspector").hidden, oldWidth=cy.width(), pan=cy.pan();
      element("pt-inspector").hidden=false;host.classList.add("pt-details-open");
      if(changed){
        cy.resize();cy.pan({x:pan.x+(cy.width()-oldWidth)/2,y:pan.y});
        if(selectedK!==null)fitPath();
        else {
          const node=cy.getElementById(nodeId(selectedNode));
          if(node.length){const p=node.renderedPosition();if(p.x<25||p.x>cy.width()-25||p.y<25||p.y>cy.height()-25)cy.center(node);}
        }
        updateViewport();
      }
    }
    function closeInspector() {
      const returnFocus=element("pt-inspector").contains(document.activeElement);
      const oldWidth=cy?.width(), pan=cy?.pan();
      element("pt-inspector").hidden=true;host.classList.remove("pt-details-open");
      if(returnFocus)host.querySelector('[data-pt-action="details"]').focus({preventScroll:true});
      if(cy){cy.resize();cy.pan({x:pan.x+(cy.width()-oldWidth)/2,y:pan.y});updateViewport();}
    }
    function search(query) {
      const text=query.trim().toLowerCase(), matches=[];
      if(!text)return matches;
      let exact=-1;
      for(let k=0;k<library.id.length;k++)if(String(library.id[k])===text){exact=k;break;}
      if(exact>=0)matches.push(exact);
      for(let k=0;k<library.id.length && matches.length<24;k++)if(k!==exact && (`${library.name[k]} ${library.formula[k]} ${library.id[k]}`).toLowerCase().includes(text))matches.push(k);
      return matches;
    }
    function searchMarkup() {
      const input=element("pt-search"), text=input.value.trim();
      if(!text){element("pt-search-results").innerHTML="";return;}
      const matches=search(text);
      element("pt-search-results").innerHTML=matches.length?matches.map(k=>`<button data-pt-compound="${k}" role="listitem"><strong>${escape(named(k))}</strong><small>CID ${escape(library.id[k])} · ${escape(library.formula[k])}</small></button>`).join(""):`<p>No library compounds match “${escape(text)}”.</p>`;
    }
    function drawMini() {
      if(!projected)return;
      const canvas=element("pt-mini").querySelector("canvas"), ctx=canvas.getContext("2d"); if(!ctx)return;
      const box=cy.nodes().boundingBox({includeLabels:false,includeOverlays:false}), scale=Math.min((canvas.width-14)/Math.max(1,box.w),(canvas.height-16)/Math.max(1,box.h));
      miniTransform={scale,ox:(canvas.width-box.w*scale)/2-box.x1*scale,oy:(canvas.height-box.h*scale)/2-box.y1*scale};
      const {ox,oy}=miniTransform;ctx.clearRect(0,0,canvas.width,canvas.height);
      cy.edges().forEach(e=>{const a=e.source().position(),b=e.target().position();ctx.strokeStyle=e.hasClass("pt-path")?"#a76c00":e.data("color");ctx.globalAlpha=e.hasClass("pt-muted")?.13:.48;ctx.lineWidth=e.hasClass("pt-path")?1.1:.45;ctx.beginPath();ctx.moveTo(a.x*scale+ox,a.y*scale+oy);ctx.lineTo(b.x*scale+ox,b.y*scale+oy);ctx.stroke();});
      ctx.globalAlpha=1;updateViewport();
    }
    function updateViewport() {
      if(!cy)return;
      element("pt-zoom").textContent=`${Math.round(cy.zoom()*100)}%`;
      if(!miniTransform)return;
      const canvas=element("pt-mini").querySelector("canvas"), box=cy.extent(), rect=canvas.getBoundingClientRect(), sx=rect.width/canvas.width, sy=rect.height/canvas.height, {scale,ox,oy}=miniTransform;
      const outline=element("pt-mini-viewport");
      Object.assign(outline.style,{left:`${(box.x1*scale+ox)*sx}px`,top:`${(box.y1*scale+oy)*sy}px`,width:`${box.w*scale*sx}px`,height:`${box.h*scale*sy}px`});
    }
    function revealOnZoom() {
      if(!autoDetail||!visible||!model||rendering||Date.now()<lodPauseUntil||selectedK!==null||cy.zoom()<Math.max(baseZoom*1.7,.38)||projected.ids.length>=maxVisible)return;
      const box=cy.extent(), center={x:(box.x1+box.x2)/2,y:(box.y1+box.y2)/2};
      const nearby=projected.frontier.filter(id=>model.q[id]>=0).filter(id=>{const p=projected.positions.get(id);return p.x>box.x1&&p.x<box.x2&&p.y>box.y1&&p.y<box.y2;}).sort((a,b)=>{const x=projected.positions.get(a),y=projected.positions.get(b);return Math.hypot(x.x-center.x,x.y-center.y)-Math.hypot(y.x-center.x,y.y-center.y);});
      let added=0, anchor=null;
      for(const id of nearby.slice(0,80)) {
        const cost=children(model,id).length;
        if(projected.ids.length+added+cost>maxVisible||added+cost>220)break;
        expanded.add(id);added+=cost;if(anchor===null)anchor=id;
      }
      if(added)render({anchor});
    }
    function exportPng() {
      if(!cy)return null;
      return cy.png({output:"blob",bg:"#ffffff",full:false,scale:Math.min(2,global.devicePixelRatio||1)});
    }
    function downloadImage() {
      const blob=exportPng();if(!blob)return;
      const url=URL.createObjectURL(blob), a=document.createElement("a");a.href=url;a.download="SpecTree-v7-full-library-path-tree.png";a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);
    }
    async function load(data) {
      if(loading||destroyed)return false;loading=true;clearTimeout(retryTimer);
      element("pt-loading").hidden=false;
      element("pt-loading").querySelector("button").hidden=true;
      try {
        let arrays;
        if(data?.arrays){schema=data.schema||{};arrays=data.arrays;}
        else {
          const url=new URL(manifestUrl,document.baseURI), response=await fetch(url,{cache:"no-store"});
          if(!response.ok)throw new Error(`Path index is not available yet (HTTP ${response.status}).`);
          schema=await response.json();
          const statusResponse=await fetch(new URL("status.json",url),{cache:"no-store"});
          if(!statusResponse.ok)throw new Error("The independent path-tree validation record is not available yet.");
          const buildStatus=await statusResponse.json();
          if(schema.status!=="complete"||buildStatus.status!=="complete"||buildStatus.validation?.passed!==true||!schema.binarySha256||buildStatus.validation.binarySha256!==schema.binarySha256)throw new Error("The full-library path tree is awaiting independent validation.");
          if(schema.evidence!=="all"||schema.N!==library.id.length||schema.Q!==meta.questions.length||schema.provenance?.sourceModelSha256!==meta.provenance?.modelSha256||schema.provenance?.sourceLibrarySha256!==meta.provenance?.librarySha256)throw new Error("The path tree does not match this v7 model, compound library and evidence mode.");
          const binaryName=(typeof schema.binary==="string"?schema.binary:schema.binary?.file)||schema.binaryFile||schema.dataFile||schema.file||"tree.bin";
          const binary=await fetch(new URL(binaryName,url));if(!binary.ok)throw new Error(`Tree data could not load (HTTP ${binary.status}).`);
          const buffer=await binary.arrayBuffer();
          if(!global.crypto?.subtle)throw new Error("Binary verification requires localhost or a secure browser connection.");
          const digest=Array.from(new Uint8Array(await global.crypto.subtle.digest("SHA-256",buffer)),b=>b.toString(16).padStart(2,"0")).join("");
          if(digest!==schema.binarySha256)throw new Error("The tree binary does not match its verified SHA-256 hash.");
          arrays=decode(schema,buffer);
        }
        model=prepare(arrays,library.id.length);
        for(let i=0;i<model.nodeCount;i++)if(model.q[i]>=meta.questions.length)throw new Error("The tree and question bank do not match.");
        scope=model.root;expanded=initialExpansion(model,scope,initialBudget);
        if(!cy) {
          const cytoscape=options.cytoscape||global.cytoscape;if(typeof cytoscape!=="function")throw new Error("Cytoscape.js could not load.");
          cy=cytoscape({container:element("pt-graph"),elements:[],style:styles(),minZoom:.025,maxZoom:12,boxSelectionEnabled:false,autounselectify:true,hideEdgesOnViewport:false,textureOnViewport:false});
          cy.on("tap","node",event=>{
            const id=event.target.data("treeId"),now=Date.now(),doubleTap=lastTap===id&&now-lastTapTime<350;
            cancelNodeTap();
            if(doubleTap){if(model.q[id]<0)inspect(id);else if(expanded.has(id))collapse(id);else expand(id);return;}
            // Opening details resizes the canvas. Keep the node still until a
            // possible second tap so double-clicking does not miss its target.
            lastTap=id;lastTapTime=now;
            nodeTapTimer=setTimeout(()=>{cancelNodeTap();if(!destroyed)inspect(id);},350);
          });
          cy.on("tap","edge",event=>{cancelNodeTap();inspect(event.target.data("treeId"));});
          cy.on("tap",event=>{if(event.target===cy){cancelNodeTap();closeInspector();}});
          cy.on("pan zoom",()=>{
            cancelNodeTap();updateViewport();scheduleLabels();clearTimeout(lodTimer);
            // Repositioning a newly expanded tree also emits viewport events.
            // Only a later navigation gesture may request another reveal batch.
            if(!rendering)lodTimer=setTimeout(revealOnZoom,200);
          });
        }
        element("pt-search").disabled=false;element("pt-loading").hidden=true;
        render({fit:true});options.onReady?.({nodes:model.nodeCount,compounds:model.compoundCount});return true;
      } catch(error) {
        let progress;
        try {const response=await fetch(new URL("status.json",new URL(manifestUrl,document.baseURI)),{cache:"no-store"});if(response.ok)progress=await response.json();}catch(_){}
        const pending=progress&&(["running","validating","starting","preparing","exporting"].includes(progress.status)||(progress.status==="complete"&&progress.validation?.passed===undefined));
        const message=element("pt-loading");message.querySelector("h2").textContent=pending?(["validating","complete"].includes(progress.status)?"Verifying the complete path tree":"Building the complete path tree"):"The path tree is not ready";
        let description=error.message;
        if(pending){
          const done=progress.completedReadings??progress.completedCompounds??progress.processedCompounds??progress.coveredCompounds??progress.completed??progress.processed;
          const inFlight=progress.inFlightCompletedReadings||0;
          description=`${Number.isFinite(done)?`${fmt(done)} / ${fmt(library.id.length)} stored readings checkpointed. `:""}${inFlight?`${fmt(inFlight)} more readings computed in active branches. `:""}${Number.isFinite(progress.computedStates)?`${fmt(progress.computedStates)} decision states computed. `:""}The viewer will open when the complete index passes independent validation.`;
          retryTimer=setTimeout(()=>load(),20000);
        }
        message.querySelector("p").textContent=description;message.querySelector("button").hidden=false;
        element("pt-coverage").textContent="Complete data is required before displaying the tree.";
        options.onError?.(error);return false;
      } finally {loading=false;}
    }

    element("pt-inspector").addEventListener("click",event=>{
      inspectorActionFocused=event.target.closest("button")===document.activeElement;
      setTimeout(()=>{inspectorActionFocused=false;},0);
    },true);
    host.addEventListener("click",event=>{
      const compound=event.target.closest("[data-pt-compound]");if(compound){cancelNodeTap();selectCompound(Number(compound.dataset.ptCompound));return;}
      const button=event.target.closest("[data-pt-action]");if(!button)return;
      cancelNodeTap();
      const action=button.dataset.ptAction,id=Number(button.dataset.node);
      if(action==="retry"){load();return;}if(!model)return;
      if(action==="zoom-in"||action==="zoom-out"){cy.zoom({level:cy.zoom()*(action==="zoom-in"?1.35:1/1.35),renderedPosition:{x:cy.width()/2,y:cy.height()/2}});}
      else if(action==="fit")fitTree();else if(action==="fit-path")fitPath();else if(action==="reset"||action==="all")wholeTree();
      else if(action==="close-details")closeInspector();else if(action==="details")inspect(selectedNode??scope);else if(action==="export")downloadImage();
      else if(action==="expand")expand(id);else if(action==="collapse")collapse(id);else if(action==="branch")openBranch(id);else if(action==="focus")focusNode(id);
      else if(action==="clear-path")clearPath();
      else if(action==="inspect-child"){const parent=model.parent[id];if(!expanded.has(parent)&&!expand(parent))return;inspect(id);focusNode(id);}
      else if(action==="history"){
        if(!projected.positions.has(id)){
          scope=model.root;expanded=initialExpansion(model,scope,initialBudget);
          for(const ancestor of ancestors(model,id))if(model.q[ancestor]>=0)expanded.add(ancestor);
          render({fit:true});
        }
        inspect(id);focusNode(id);
      }
      else if(action==="members-prev"||action==="members-next"){memberPage+=action==="members-prev"?-1:1;inspect(selectedNode,true);}
    });
    element("pt-search").addEventListener("input",()=>{clearTimeout(searchTimer);searchTimer=setTimeout(searchMarkup,130);});
    element("pt-search").addEventListener("keydown",event=>{if(event.key==="Enter"){event.preventDefault();clearTimeout(searchTimer);const matches=search(event.target.value);if(matches.length)selectCompound(matches[0]);else searchMarkup();}else if(event.key==="Escape")element("pt-search-results").innerHTML="";});
    element("pt-clear-search").onclick=()=>{element("pt-search").value="";element("pt-search-results").innerHTML="";element("pt-search").focus();};
    element("pt-labels").onchange=event=>{labelMode=event.target.value;applyLabels();};
    element("pt-auto").querySelector("input").onchange=event=>{autoDetail=event.target.checked;};
    element("pt-mini").querySelector("canvas").onclick=event=>{
      if(!miniTransform||!cy)return;const rect=event.target.getBoundingClientRect(),x=(event.clientX-rect.left)*event.target.width/rect.width,y=(event.clientY-rect.top)*event.target.height/rect.height,{scale,ox,oy}=miniTransform;
      cy.pan({x:cy.width()/2-(x-ox)/scale*cy.zoom(),y:cy.height()/2-(y-oy)/scale*cy.zoom()});
    };
    const observer=typeof ResizeObserver!=="undefined"?new ResizeObserver(()=>{if(cy&&visible){cy.resize();updateViewport();scheduleLabels();}}):null;observer?.observe(host);
    return {load,selectCompound,expand,collapse,search,exportPng,fit:fitTree,reset:wholeTree,openBranch,
      show(){visible=true;host.hidden=false;cy?.resize();updateViewport();},hide(){visible=false;host.hidden=true;},resize(){cy?.resize();updateViewport();},
      inspect, getState(){return {ready:!!model,nodeCount:model?.nodeCount,compoundCount:model?.compoundCount,visibleNodes:projected?.ids.length,representedCount:projected?.covered,scope,selectedK,selectedNode};},
      destroy(){destroyed=true;cancelNodeTap();clearTimeout(retryTimer);clearTimeout(lodTimer);clearTimeout(labelTimer);clearTimeout(noticeTimer);clearTimeout(searchTimer);observer?.disconnect();cy?.destroy();host.innerHTML="";host.classList.remove("pt-viewer");}
    };
  }

  const api={create,decode,prepare,initialExpansion,projection,children,ancestors};
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  else global.SpecTreePathTree=api;
})(typeof window!=="undefined"?window:globalThis);
