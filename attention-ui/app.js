// Renders the Attention projection and previews a Dispatch envelope. Dispatch sends no request and persists no state.
const form = document.querySelector('#attention');
const list = form.querySelector('.attention-list');
const note = form.querySelector('.quiet-note');
const dispatch = form.querySelector('.dispatch');
const rowTemplate = document.querySelector('#attention-row');
let projection = null;

function renderRow(row, index) {
  const item = rowTemplate.content.cloneNode(true);
  const input = item.querySelector('input');
  input.value = row.id;
  input.checked = index === 0;
  input.disabled = !row.issue_id;
  item.querySelector('.reason').textContent = row.summary;
  item.querySelector('.actor').textContent = [row.actor, row.issue_id].filter(Boolean).join(' · ');
  return item;
}

function syncDispatch() {
  dispatch.disabled = !form.querySelector('input[name="issue"]:checked:not(:disabled)');
}

// Field names follow the locked Sink dispatch envelope. A new press is a new human intent, so it gets a new event_id.
function dispatchEnvelope(row) {
  return {
    intent: 'dispatch',
    project: projection.project,
    issue_id: row.issue_id,
    event_id: crypto.randomUUID(),
    idempotency_key: `${row.issue_id}:dispatch`,
    occurred_at: Math.floor(Date.now() / 1000),
  };
}

async function load() {
  try {
    const response = await fetch('/api/attention');
    projection = await response.json();
  } catch {
    note.textContent = 'The list could not load.';
    note.hidden = false;
    return;
  } finally {
    form.removeAttribute('aria-busy');
  }
  document.body.dataset.source = projection.source;
  console.info('attention source', projection.source, projection.set_revision);
  list.replaceChildren(...projection.rows.map(renderRow));
  if (projection.rows.length === 0) {
    note.textContent = 'Nothing needs you.';
    note.hidden = false;
  }
  syncDispatch();
}

form.addEventListener('change', syncDispatch);

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const selected = form.querySelector('input[name="issue"]:checked');
  const row = projection?.rows.find((candidate) => candidate.id === selected?.value);
  if (!row?.issue_id) return;
  const envelope = dispatchEnvelope(row);
  console.info('dispatch preview', envelope);
  window.alert(`${row.summary}\n${row.issue_id}\n\nThis is a Dispatch preview. Nothing was sent.`);
});

load();
