"use strict";
(async function () {
  const host = document.getElementById("path-tree");
  try {
    const responses = await Promise.all([fetch("data/meta.json"), fetch("data/library.json")]);
    if (responses.some(r => !r.ok)) throw new Error("The v7 model metadata or compound library could not load.");
    const [meta, library] = await Promise.all(responses.map(r => r.json()));
    if (library.id.length !== meta.N || meta.questions.length !== meta.Q) throw new Error("The model and library counts do not match.");
    document.getElementById("path-dataset-status").textContent = `${meta.N.toLocaleString("en-US")} stored readings`;
    if (!window.SpecTreePathTree) throw new Error("The decision tree viewer script could not load.");
    const cid = new URLSearchParams(location.search).get("cid");
    const selected = cid ? library.id.findIndex(id => String(id) === cid) : -1;
    const tree = SpecTreePathTree.create({container:host, meta, library,
      manifestUrl:"data/path_tree_all/schema.json",
      onReady:() => { if (selected >= 0) tree.selectCompound(selected); }});
    await tree.load();
    tree.show();
  } catch (error) {
    host.replaceChildren();
    const box = document.createElement("div"); box.className = "paths-boot";
    const heading = document.createElement("h1"); heading.textContent = "Could not open the path tree";
    const message = document.createElement("p"); message.textContent = error.message;
    const retry = document.createElement("button"); retry.textContent = "Try again"; retry.onclick = () => location.reload();
    box.append(heading, message, retry); host.append(box); console.error(error);
  }
})();
