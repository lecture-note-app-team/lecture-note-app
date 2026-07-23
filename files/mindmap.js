function $(id) { return document.getElementById(id); }

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}
  if (!res.ok) throw new Error(data.message || data.detail || text || "API error");
  return data;
}

const params = new URLSearchParams(location.search);
const noteId = params.get("note_id") || params.get("id");

if (!noteId) {
  document.body.innerHTML = "<p>note_id がありません</p>";
  throw new Error("missing note_id");
}

$("backLink").href = `/note_detail.html?id=${encodeURIComponent(noteId)}`;

// state
let nodes = []; // { id, label, x, y, parentId }
let edges = []; // { from, to }
let selectedId = null;
const CENTER_X = 1100;
const CENTER_Y = 650;

function setStatus(msg) {
  $("statusLine").textContent = msg || "";
}

function idFactory() {
  let n = nodes.length + edges.length + 1;
  return () => `n${Date.now()}_${n++}`;
}
let nextId = idFactory();

function findNode(id) {
  return nodes.find((n) => n.id === id) || null;
}

function render() {
  const svg = $("svgLayer");
  const layer = $("nodeLayer");

  // SVG size follows canvas inner size
  svg.setAttribute("width", "2400");
  svg.setAttribute("height", "1400");

  svg.innerHTML = edges.map((e) => {
    const a = findNode(e.from);
    const b = findNode(e.to);
    if (!a || !b) return "";
    return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="rgba(0,0,0,0.28)" stroke-width="2" />`;
  }).join("");

  layer.innerHTML = "";
  for (const n of nodes) {
    const div = document.createElement("div");
    div.className = "mindmap-node" + (n.parentId === null ? " is-root" : "") + (n.id === selectedId ? " is-selected" : "");
    div.style.left = `${n.x}px`;
    div.style.top = `${n.y}px`;
    div.textContent = n.label || "(無題)";
    div.dataset.nodeId = n.id;
    layer.appendChild(div);
    wireNodeDrag(div, n);
  }
}

function wireNodeDrag(el, node) {
  let dragging = false;
  let startX = 0, startY = 0, origX = 0, origY = 0;
  let moved = false;

  function onDown(clientX, clientY) {
    dragging = true;
    moved = false;
    startX = clientX;
    startY = clientY;
    origX = node.x;
    origY = node.y;
  }
  function onMove(clientX, clientY) {
    if (!dragging) return;
    const dx = clientX - startX;
    const dy = clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
    node.x = origX + dx;
    node.y = origY + dy;
    render();
  }
  function onUp() {
    if (!dragging) return;
    dragging = false;
    if (!moved) {
      selectedId = node.id;
      render();
    }
  }

  el.addEventListener("mousedown", (e) => { e.preventDefault(); onDown(e.clientX, e.clientY); });
  window.addEventListener("mousemove", (e) => onMove(e.clientX, e.clientY));
  window.addEventListener("mouseup", onUp);

  el.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    onDown(t.clientX, t.clientY);
  }, { passive: true });
  el.addEventListener("touchmove", (e) => {
    const t = e.touches[0];
    onMove(t.clientX, t.clientY);
  }, { passive: true });
  el.addEventListener("touchend", onUp);
}

function addNode() {
  const parent = selectedId ? findNode(selectedId) : (nodes[0] || null);
  const id = nextId();
  const baseX = parent ? parent.x + 220 : CENTER_X;
  const baseY = parent ? parent.y + (Math.random() * 120 - 60) : CENTER_Y;
  const label = prompt("ノードのラベルを入力してください", "新しいノード");
  if (label == null) return;

  nodes.push({ id, label: label.trim() || "新しいノード", x: baseX, y: baseY, parentId: parent ? parent.id : null });
  if (parent) edges.push({ from: parent.id, to: id });
  selectedId = id;
  render();
}

function collectDescendants(id) {
  const result = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of edges) {
      if (result.has(e.from) && !result.has(e.to)) {
        result.add(e.to);
        changed = true;
      }
    }
  }
  return result;
}

function deleteSelectedNode() {
  if (!selectedId) {
    alert("削除するノードを選択してください（クリックで選択）");
    return;
  }
  const target = findNode(selectedId);
  if (!target || target.parentId === null) {
    alert("中心ノードは削除できません");
    return;
  }
  if (!confirm(`「${target.label}」とその子ノードを削除します。よろしいですか？`)) return;

  const toRemove = collectDescendants(selectedId);
  nodes = nodes.filter((n) => !toRemove.has(n.id));
  edges = edges.filter((e) => !toRemove.has(e.from) && !toRemove.has(e.to));
  selectedId = null;
  render();
}

function renameSelectedNode() {
  if (!selectedId) {
    alert("編集するノードを選択してください（クリックで選択）");
    return;
  }
  const target = findNode(selectedId);
  const label = prompt("新しいラベルを入力してください", target.label);
  if (label == null) return;
  target.label = label.trim() || target.label;
  render();
}

async function saveMindmap() {
  try {
    setStatus("保存中…");
    await api(`/api/notes/${noteId}/mindmap`, {
      method: "PUT",
      body: JSON.stringify({ nodes, edges }),
    });
    setStatus("保存しました。");
  } catch (e) {
    setStatus("保存に失敗しました: " + e.message);
  }
}

async function generateMindmap() {
  const hasExisting = nodes.length > 0;
  if (hasExisting && !confirm("既存のマインドマップを上書きしてAIで再生成します。よろしいですか？")) {
    return;
  }
  const btn = $("btnGenerate");
  btn.disabled = true;
  setStatus("AIがノート本文からマインドマップを作成しています…");
  try {
    const result = await api(`/api/notes/${noteId}/mindmap/generate`, { method: "POST" });
    nodes = result.data.nodes;
    edges = result.data.edges;
    selectedId = null;
    render();
    setStatus("生成しました。ノードはドラッグで動かして調整できます。");
  } catch (e) {
    setStatus("生成に失敗しました: " + e.message);
  } finally {
    btn.disabled = false;
  }
}

async function loadNoteTitle() {
  try {
    const note = await api(`/api/notes/${noteId}`);
    $("noteTitle").textContent = `マインドマップ：${note.title || "(無題)"}`;
  } catch {
    // タイトル取得失敗は致命的ではない
  }
}

async function init() {
  await loadNoteTitle();
  try {
    const result = await api(`/api/notes/${noteId}/mindmap`);
    nodes = result.data.nodes || [];
    edges = result.data.edges || [];
    render();
    setStatus(`最終更新: ${result.updatedAt || ""}（${result.source === "manual" ? "手動編集済み" : "AI生成"}）`);
  } catch (e) {
    setStatus("まだマインドマップがありません。「AIで自動生成」を押して作成してください。");
  }

  $("btnGenerate").addEventListener("click", generateMindmap);
  $("btnAddNode").addEventListener("click", addNode);
  $("btnDeleteNode").addEventListener("click", deleteSelectedNode);
  $("btnRenameNode").addEventListener("click", renameSelectedNode);
  $("btnSave").addEventListener("click", saveMindmap);
}

init();
