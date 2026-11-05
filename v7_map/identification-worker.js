"use strict";

// Interactive sessions use the unchanged v7 engine and its full candidate library.
importScripts("engine.js");

let bootPromise;
let model;
let engine;
let game = null;
let evidence = null;
let selectedCompound = null;
let currentQuestion = -1;
let stopReason = null;
let requestQueue = Promise.resolve();
const chunks = new Map();
let incomingChunk = null;

self.SPECTREE_CHUNK = (index, base64) => { incomingChunk = {index, base64}; };

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

async function boot() {
  if (!bootPromise) bootPromise = (async () => {
    const [metadata, compressed] = await Promise.all([
      fetchOK("data/meta.json").then(response => response.json()),
      fetchOK("data/model.bin.gz").then(response => response.arrayBuffer()),
    ]);
    if (metadata.N !== 105328 || metadata.Q !== 645) throw new Error("The complete v7 model is required.");
    const buffer = await unpackGzip(compressed);
    if (buffer.byteLength !== metadata.provenance.modelBytes) throw new Error("The model payload has the wrong size.");
    if (!self.crypto || !self.crypto.subtle) throw new Error("This browser cannot verify the model. Open the viewer at its localhost address in a current browser.");
    const digest = await self.crypto.subtle.digest("SHA-256", buffer);
    const hash = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
    if (hash !== metadata.provenance.modelSha256) throw new Error("The model payload failed its SHA-256 check.");
    const types = {uint8: Uint8Array, uint32: Uint32Array, float32: Float32Array};
    const arrays = {};
    for (const [key, spec] of Object.entries(metadata.layout)) {
      arrays[key] = new types[spec.dtype](buffer, spec.offset, spec.length);
    }
    if (arrays.clean.length !== metadata.N * metadata.Q) throw new Error("The model answer table is incomplete.");
    model = metadata;
    engine = makeEngine(metadata, arrays);
  })().catch(error => {
    bootPromise = null;
    throw error;
  });
  return bootPromise;
}

async function loadSample(k) {
  const index = Math.floor(k / model.chunks.size);
  let rows = chunks.get(index);
  if (!rows) {
    incomingChunk = null;
    importScripts(`${model.chunks.dir}/chunk_${String(index).padStart(3, "0")}.js`);
    const received = incomingChunk;
    incomingChunk = null;
    if (!received || received.index !== index) throw new Error(`Molecule chunk ${index} did not return its expected data.`);
    const binary = atob(received.base64);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    rows = JSON.parse(new TextDecoder().decode(await unpackGzip(bytes)));
    const expected = Math.min(model.chunks.size, model.N - index * model.chunks.size);
    if (!Array.isArray(rows) || rows.length !== expected) throw new Error(`Molecule chunk ${index} is incomplete.`);
  }
  chunks.delete(index);
  chunks.set(index, rows);
  while (chunks.size > 3) chunks.delete(chunks.keys().next().value);
  const row = rows[k % model.chunks.size];
  if (!row || !Array.isArray(row.a) || row.a.length !== model.Q ||
      row.a.some((a, q) => !Number.isInteger(a) || a < 0 || a >= model.ncat[q]) ||
      !Array.isArray(row.ms) || !Array.isArray(row.h) || !Array.isArray(row.c)) {
    throw new Error("The selected compound has incomplete readings.");
  }
  return {k, ms: row.ms, h: row.h, c: row.c, a: row.a};
}

function updateQuestion() {
  currentQuestion = engine.nextQuestion(game);
  const settings = model.settings[evidence];
  stopReason = currentQuestion >= 0 ? null
    : engine.p1(game) >= settings.stop_max ? "confidence"
    : game.order.length >= settings.max_extra ? "question_limit" : "no_useful_question";
}

function sendState(requestId, sample) {
  const state = {
    type: "state", requestId, q: currentQuestion,
    history: game.order.map((q, i) => ({q, a: game.answers[i]})),
    top: engine.ranking(game, 5), p1: engine.p1(game), stopReason,
    evidence, k: selectedCompound,
  };
  if (sample) state.sample = sample;
  self.postMessage(state);
}

async function handle(message) {
  if (message.type === "start") {
    const nextEvidence = message.evidence === undefined ? "all" : message.evidence;
    const nextCompound = message.k === undefined ? null : message.k;
    if (nextEvidence !== "all" && nextEvidence !== "nmr_ms") throw new Error("Unknown evidence setting.");
    if (nextCompound !== null && (!Number.isInteger(nextCompound) || nextCompound < 0 || nextCompound >= 105328)) {
      throw new Error("Select a compound in the v7 library.");
    }
    await boot();
    const sample = nextCompound === null ? null : await loadSample(nextCompound);
    evidence = nextEvidence;
    selectedCompound = nextCompound;
    game = engine.newGame(evidence);
    updateQuestion();
    sendState(message.requestId, sample);
    return;
  }
  if (!game) throw new Error("Start an identification session first.");
  if (message.type === "answer") {
    if (currentQuestion < 0) throw new Error("This identification is complete. Go back or start a new session.");
    if (!Number.isInteger(message.q) || message.q !== currentQuestion) throw new Error("That question is no longer current.");
    if (!Number.isInteger(message.a) || message.a < 0 || message.a >= model.ncat[currentQuestion]) {
      throw new Error("Choose one of the available answers.");
    }
    engine.answer(game, currentQuestion, message.a);
    updateQuestion();
  } else if (message.type === "back") {
    if (!game.order.length) throw new Error("There are no previous answers.");
    const previous = game;
    game = engine.newGame(evidence);
    for (let i = 0; i < previous.order.length - 1; i++) engine.answer(game, previous.order[i], previous.answers[i]);
    updateQuestion();
  } else if (message.type === "finish") {
    if (currentQuestion >= 0) {
      currentQuestion = -1;
      stopReason = "requested";
    }
  } else {
    throw new Error("Unknown identification request.");
  }
  sendState(message.requestId);
}

// A start may still be loading data when another request arrives. Process in order.
self.onmessage = event => {
  const message = event.data || {};
  requestQueue = requestQueue.then(() => handle(message)).catch(error => {
    self.postMessage({type: "error", requestId: message.requestId, message: error.message || String(error)});
  });
};
