function $(id) { return document.getElementById(id); }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}
  if (!res.ok) throw new Error(data.message || data.detail || text || 'API error');
  return data;
}

function getNoteId() {
  const id = Number(new URLSearchParams(location.search).get('id'));
  return Number.isFinite(id) && id > 0 ? id : null;
}

function getBackUrl() {
  const from = new URLSearchParams(location.search).get('from');
  return from || '/mypage.html';
}

function setStatus(msg) {
  const el = $('status');
  if (el) el.innerHTML = msg;
}

function setCommunityMode(isCommunity) {
  const vis = $('visibility');
  const hint = $('visibilityHint');
  const uni = $('university_name');
  if (!vis || !hint || !uni) return;

  if (isCommunity) {
    vis.value = 'private';
    vis.disabled = true;
    uni.placeholder = '未入力なら（コミュ）になります';
    hint.textContent = 'コミュニティ投稿は参加メンバーのみ閲覧可能です（公開設定は自動で非公開になります）。';
  } else {
    vis.disabled = false;
    uni.placeholder = '例：長崎大学';
    hint.textContent = vis.value === 'private'
      ? '非公開：マイページからのみ閲覧できます。'
      : '公開：大学の一覧に表示されます。';
  }
}

async function loadCommunities(selectedCommunityId) {
  const sel = $('community_id');
  if (!sel) return;

  const current = selectedCommunityId ?? (Number(sel.value || 0) || null);

  sel.innerHTML = '<option value="">（未選択：大学公開/個人ノート）</option>';

  try {
    const list = await api('/api/communities/mine');
    for (const c of list || []) {
      const opt = document.createElement('option');
      opt.value = String(c.id);
      opt.textContent = `${c.name}（${c.role === 'admin' ? '管理者' : 'メンバー'}）`;
      sel.appendChild(opt);
    }

    if (current) sel.value = String(current);
  } catch (e) {
    setStatus(`<span style="color:#c00;">コミュニティ取得失敗: ${escapeHtml(e.message)}</span>`);
  }

  setCommunityMode(!!sel.value);
}

function fillForm(note) {
  $('community_id').value = note.community_id ? String(note.community_id) : '';
  $('university_name').value = note.university_name || '';
  $('visibility').value = note.visibility || 'public';
  $('author_name').value = note.author_name || '';
  $('course_name').value = note.course_name || '';
  $('lecture_no').value = note.lecture_no || '';
  $('lecture_date').value = note.lecture_date || '';
  $('title').value = note.title || '';
  $('body_raw').value = note.body_raw || '';
  setCommunityMode(!!note.community_id);
}

function collectForm() {
  return {
    community_id: $('community_id').value ? Number($('community_id').value) : null,
    university_name: $('university_name').value.trim(),
    visibility: $('visibility').value,
    author_name: $('author_name').value.trim(),
    course_name: $('course_name').value.trim(),
    lecture_no: $('lecture_no').value.trim(),
    lecture_date: $('lecture_date').value,
    title: $('title').value.trim(),
    body_raw: $('body_raw').value,
  };
}

function validate(data) {
  const missing = [];
  if (!data.course_name) missing.push('授業名');
  if (!data.lecture_no) missing.push('回（第◯回）');
  if (!data.lecture_date) missing.push('日付');
  if (!data.title) missing.push('タイトル');
  if (!data.body_raw.trim()) missing.push('本文');

  if (!data.community_id && !data.university_name) missing.push('大学名または学部名');

  if (missing.length) {
    alert('未入力があります:\n- ' + missing.join('\n- '));
    return false;
  }
  return true;
}

async function loadNote() {
  const noteId = getNoteId();
  if (!noteId) {
    setStatus('ノートIDが不正です。');
    return;
  }

  try {
    setStatus('読み込み中...');
    const note = await api('/api/notes/' + noteId);
    await loadCommunities(note.community_id || null);
    fillForm(note);
    setStatus(`<span style="color:#666;">ID: ${noteId} を編集中</span>`);
  } catch (e) {
    setStatus(`<span style="color:#c00;">読み込み失敗: ${escapeHtml(e.message)}</span>`);
  }
}

async function saveNote() {
  const noteId = getNoteId();
  if (!noteId) return;

  const data = collectForm();
  if (!validate(data)) return;

  try {
    $('btnSave').disabled = true;
    $('btnSave').textContent = '更新中...';
    await api('/api/notes/' + noteId, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
    alert('更新しました');
    location.href = getBackUrl();
  } catch (e) {
    alert('更新失敗: ' + e.message);
  } finally {
    $('btnSave').disabled = false;
    $('btnSave').textContent = '更新する';
  }
}

$('btnBack')?.addEventListener('click', () => {
  location.href = getBackUrl();
});

$('btnReloadCommunities')?.addEventListener('click', () => {
  loadCommunities();
});

$('community_id')?.addEventListener('change', () => {
  setCommunityMode(!!$('community_id').value);
});

$('visibility')?.addEventListener('change', () => {
  setCommunityMode(!!$('community_id').value);
});

$('btnSave')?.addEventListener('click', saveNote);

loadNote();
