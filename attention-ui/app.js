// Fixture selection exists only for art feedback. This stub sends no request and persists no state.
const form = document.querySelector('#attention');

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const selected = form.querySelector('input[name="issue"]:checked');
  const row = selected.closest('.attention-row');
  const reason = row.querySelector('.reason').textContent;
  const actor = row.querySelector('.actor').textContent;
  console.info('dispatch stub', { intent: 'dispatch', fixture_id: selected.value, actor, reason });
  window.alert(`${reason}\n${actor}\n\nThis is a Dispatch preview. Nothing was sent.`);
});
