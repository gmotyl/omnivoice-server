// Test fixtures mimicking app pages where Readability finds no article: a Slack-like client
// (channel sidebar, channel messages, thread pane) and a Gmail-like inbox (label nav, a main
// region with the open conversation's messages as list items). linkedom has no layout, so
// scroll panes are marked data-scroll and made scrollable through scrollPanes().

const msg = (id, who, text) =>
  `<div role="listitem" id="${id}"><div class="msg"><span class="sender">${who}</span> ` +
  `<div class="text">${text}</div></div></div>`;

export const CHANNELS = ['general', 'random', 'engineering', 'design-reviews', 'release-train', 'support-escalations'];

export const SLACK = `
  <div class="client">
    <div class="sidebar" data-scroll="1">
      <div class="team">Acme workspace</div>
      ${CHANNELS.map((c) => `<div class="channel"><a href="/c/${c}">${c}</a></div>`).join('')}
    </div>
    <div class="channel-pane" role="main">
      <div class="header"><span>engineering</span></div>
      <div class="messages" data-scroll="1" role="list">
        ${msg('c1', 'Ann', 'Morning all, the nightly build failed again on the integration stage.')}
        ${msg('c2', 'Bob', 'I can take a look after standup, it is probably the flaky network test.')}
        ${msg('c3', 'Cid', 'Thread about the release plan below, please weigh in there when you can.')}
      </div>
    </div>
    <div class="thread-pane" aria-label="Thread">
      <div class="thread-header"><span>Thread in engineering</span></div>
      <div class="thread-messages" id="thread" data-scroll="1" role="list">
        ${msg('t1', 'Cid', 'Proposal: we cut the release branch on Thursday and freeze features.')}
        ${msg('t2', 'Dee', 'Thursday works for me, but the migration needs one more review first.')}
        ${msg('t3', 'Eve', 'Agreed, let us also schedule the rollback drill for Friday morning.')}
      </div>
    </div>
  </div>`;

export const LABELS = ['Inbox', 'Starred', 'Snoozed', 'Sent', 'Drafts', 'Purchases'];

export const GMAIL = `
  <div class="app">
    <nav class="labels">${LABELS.map((l) => `<div><a href="#${l.toLowerCase()}">${l}</a></div>`).join('')}</nav>
    <div class="toolbar"><span>Archive</span> <span>Report spam</span> <span>Delete</span></div>
    <div role="main" id="main">
      <h2>Quarterly planning notes</h2>
      <div role="list">
        ${msg('m1', 'Fay', 'Hi team, attached are the notes from the planning session. Please read them before Monday.')}
        ${msg('m2', 'Gus', 'Thanks Fay. I added two comments about the hiring plan and the budget for the offsite.')}
        ${msg('m3', 'Hal', 'Looks good to me. One question about the timeline for the second milestone though.')}
      </div>
    </div>
  </div>`;

// Fake layout: [data-scroll] boxes overflow vertically and scroll (overflow-y: auto).
export function scrollPanes(doc) {
  for (const el of doc.querySelectorAll('[data-scroll]')) {
    Object.defineProperty(el, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 500, configurable: true });
  }
  return (el) => ({ overflowY: el.hasAttribute('data-scroll') ? 'auto' : 'visible' });
}
