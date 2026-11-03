"use strict";

// The model code is copied unchanged from the shipped v7 engine.
importScripts("engine.js");

let bootPromise;
let model;
let engine;
let busy = false;
const chunks = new Map();
const CHUNK_CACHE_LIMIT = 3;
let incomingChunk = null;

self.SPECTREE_CHUNK = (index, base64) => {
  incomingChunk = {index, base64};
};

async function fetchOK(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Could not load ${path} (HTTP ${response.status}).`);
  return response;
}

async function unpackGzip(bytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This viewer needs a current browser with gzip decompression support.");
  }
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
}

function decodeBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function boot() {
  if (!bootPromise) bootPromise = (async () => {
    const [metadata, compressed] = await Promise.all([
      fetchOK("data/meta.json").then(response => response.json()),
      fetchOK("data/model.bin.gz").then(response => response.arrayBuffer()),
    ]);
    const buffer = await unpackGzip(compressed);
    if (buffer.byteLength !== metadata.provenance.modelBytes) throw new Error("The model payload has the wrong size.");
    if (self.crypto && self.crypto.subtle) {
      const digest = await self.crypto.subtle.digest("SHA-256", buffer);
      const hash = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
      if (hash !== metadata.provenance.modelSha256) throw new Error("The model payload failed its SHA-256 check.");
    }
    const types = {uint8: Uint8Array, uint32: Uint32Array, float32: Float32Array};
    const arrays = {};
    for (const [key, spec] of Object.entries(metadata.layout)) {
      arrays[key] = new types[spec.dtype](buffer, spec.offset, spec.length);
    }
    model = metadata;
    engine = makeEngine(metadata, arrays);
    self.postMessage({type: "ready", N: model.N, Q: model.Q});
  })().catch(error => {
    bootPromise = null;
    throw error;
  });
  return bootPromise;
}

async function loadChunk(index) {
  if (chunks.has(index)) {
    const rows = chunks.get(index);
    chunks.delete(index);
    chunks.set(index, rows);
    return rows;
  }
  incomingChunk = null;
  const path = `${model.chunks.dir}/chunk_${String(index).padStart(3, "0")}.js`;
  importScripts(path);
  const received = incomingChunk;
  incomingChunk = null;
  if (!received || received.index !== index) throw new Error(`Molecule chunk ${index} did not return its expected data.`);
  const rows = JSON.parse(new TextDecoder().decode(await unpackGzip(decodeBase64(received.base64))));
  const expected = Math.min(model.chunks.size, model.N - index * model.chunks.size);
  if (rows.length !== expected) throw new Error(`Molecule chunk ${index} is incomplete.`);
  chunks.set(index, rows);
  while (chunks.size > CHUNK_CACHE_LIMIT) chunks.delete(chunks.keys().next().value);
  return rows;
}

async function trace(message) {
  const {requestId, k, evidence = "all"} = message;
  await boot();
  if (!Number.isInteger(k) || k < 0 || k >= model.N) throw new Error("Select a compound in the v7 library.");
  if (!Object.hasOwn(model.settings, evidence)) throw new Error("Unknown evidence setting.");
  const rows = await loadChunk(Math.floor(k / model.chunks.size));
  const readings = rows[k % model.chunks.size].a;
  if (!Array.isArray(readings) || readings.length !== model.Q) throw new Error("The selected compound has incomplete readings.");
  const game = engine.newGame(evidence);
  const steps = [];
  for (;;) {
    const q = engine.nextQuestion(game);
    if (q < 0) break;
    const a = engine.answer(game, q, readings[q]);
    const top = engine.ranking(game, 5);
    const p1 = engine.p1(game);
    const targetRank = engine.rankOf(game, k);
    steps.push({q, a, top, targetRank, p1});
    self.postMessage({type: "progress", requestId, step: steps.length, p1});
    // Leave the event loop responsive; the viewer cancels a trace by terminating this worker.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  const top = engine.ranking(game, 5);
  const p1 = engine.p1(game);
  const settings = model.settings[evidence];
  const stopReason = p1 >= settings.stop_max ? "confidence"
    : steps.length >= settings.max_extra ? "question_limit" : "no_useful_question";
  self.postMessage({type: "result", requestId, k, evidence, steps, top,
    targetRank: engine.rankOf(game, k), p1, stopReason});
}

self.onmessage = async event => {
  const message = event.data || {};
  if (message.type !== "trace") return;
  if (busy) {
    self.postMessage({type: "error", requestId: message.requestId, message: "A trace is already running in this worker."});
    return;
  }
  busy = true;
  try {
    await trace(message);
  } catch (error) {
    self.postMessage({type: "error", requestId: message.requestId, message: error.message || String(error)});
  } finally {
    busy = false;
  }
};
