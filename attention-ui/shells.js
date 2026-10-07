// Renders the secondary quiet lists. They only read; Dispatch stays on the Attention home.
const shell = document.body.dataset.shell;
const paper = document.querySelector('.paper');

const clock = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const timeOf = (seconds) => clock.format(new Date(seconds * 1000));

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function section(heading, rows, emptyText) {
  const block = element('section', 'quiet-section');
  if (heading) block.append(element('h2', null, heading));
  if (rows.length === 0) {
    block.append(element('p', 'quiet-note', emptyText));
    return block;
  }
  const list = element('ul', 'quiet-list');
  for (const [primary, ...secondaries] of rows) {
    const item = element('li', 'quiet-row');
    item.append(element('span', 'primary', primary), ...secondaries.map((text) => element('span', 'secondary', text)));
    list.append(item);
  }
  block.append(list);
  return block;
}

const renderers = {
  tasks: (data) => [
    section('Ready', data.ready.map((task) => [task.title, task.issue_id]), 'Nothing is ready.'),
    section(
      'In progress',
      data.in_progress.map((task) => [
        task.title,
        [task.issue_id, task.holder, task.tip && `tip ${task.tip.slice(0, 7)}`].filter(Boolean).join(' · '),
      ]),
      'Nothing is in progress.',
    ),
  ],
  // A lease end time is when the claim lapses, not evidence that the agent is still working.
  agents: (data) => [
    section(
      null,
      data.claims.map((claim) => [
        claim.agent_label ?? 'Unlabeled claim',
        claim.title ? `${claim.issue_id} · ${claim.title}` : claim.issue_id,
        `held until ${timeOf(claim.expires_at)} · ${claim.tip ? `tip ${claim.tip.slice(0, 7)}` : 'no tip yet'}`,
        `host: ${claim.host ?? 'not reported'}`,
      ]),
      'No agent holds a claim.',
    ),
  ],
};

try {
  const data = await (await fetch(`/api/${shell}`)).json();
  document.body.dataset.source = data.source;
  console.info(`${shell} source`, data.source);
  paper.append(...renderers[shell](data));
} catch {
  paper.append(element('p', 'quiet-note', 'The list could not load.'));
} finally {
  paper.removeAttribute('aria-busy');
}
