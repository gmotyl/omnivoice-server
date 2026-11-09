import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createBar } from '../bar.mjs';

// The bar's shadow root is closed, so the page (and the test) cannot reach it through
// host.shadowRoot. To inspect it, the test wraps attachShadow on the document's elements
// and records the root it returns along with the requested mode.
function setup() {
  const { document, window } = parseHTML('<!doctype html><html><head></head><body><p>Page</p></body></html>');
  const attached = [];
  const proto = Object.getPrototypeOf(document.createElement('div'));
  const original = proto.attachShadow;
  const realCreate = document.createElement.bind(document);
  document.createElement = (name, ...rest) => {
    const el = realCreate(name, ...rest);
    el.attachShadow = function (init) {
      const root = original.call(this, init);
      attached.push({ host: this, init, root });
      return root;
    };
    return el;
  };
  const actions = [];
  const bar = createBar({ doc: document, onAction: (type, payload) => actions.push([type, payload]) });
  return { document, window, attached, actions, bar };
}

function click(document, el, init = {}) {
  const ev = new document.defaultView.Event('click', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'shiftKey', { value: !!init.shiftKey });
  el.dispatchEvent(ev);
  return ev;
}

test('bar renders all controls in a shadow root', () => {
  const { document, attached } = setup();
  assert.equal(attached.length, 1);
  const { host, init, root } = attached[0];
  assert.equal(init.mode, 'closed');
  assert.equal(host.shadowRoot, null);
  assert.equal(host.parentNode, document.body);
  // Nothing from the bar leaks into the page DOM outside the host.
  assert.equal(document.body.querySelectorAll('button').length, 0);
  for (const label of ['Play', 'Previous', 'Next', 'Close']) {
    assert.ok(root.querySelector(`button[aria-label="${label}"]`), `missing ${label} button`);
  }
  assert.ok(root.querySelector('select[aria-label="Voice"]'));
  const speed = root.querySelector('input[aria-label="Speed"]');
  assert.ok(speed);
  assert.equal(speed.getAttribute('type'), 'range');
  assert.equal(speed.getAttribute('min'), '0.5');
  assert.equal(speed.getAttribute('max'), '2');
  assert.equal(speed.getAttribute('step'), '0.1');
});

test('shift on previous and next emits paragraph actions', () => {
  const { document, attached, actions } = setup();
  const { root } = attached[0];
  const prev = root.querySelector('button[aria-label="Previous"]');
  const next = root.querySelector('button[aria-label="Next"]');
  click(document, prev);
  click(document, next);
  click(document, prev, { shiftKey: true });
  click(document, next, { shiftKey: true });
  assert.deepEqual(actions.map(([t]) => t), ['prev', 'next', 'prev-paragraph', 'next-paragraph']);
});

test('error state shows message, options link and retry', () => {
  const { document, attached, actions, bar } = setup();
  const { root } = attached[0];
  const error = root.querySelector('.error');
  assert.equal(error.hasAttribute('hidden'), true);
  bar.setState('error', 'Engine returned 500');
  assert.equal(error.hasAttribute('hidden'), false);
  assert.match(error.textContent, /Engine returned 500/);
  const link = root.querySelector('a.options');
  assert.equal(link.textContent, 'Open options');
  const ev = click(document, link);
  assert.equal(ev.defaultPrevented, true);
  click(document, root.querySelector('button[aria-label="Retry"]'));
  assert.deepEqual(actions.map(([t]) => t), ['options', 'retry']);
  bar.setState('playing');
  assert.equal(error.hasAttribute('hidden'), true);
});

test('destroy removes the bar', () => {
  const { document, attached, bar } = setup();
  const { host } = attached[0];
  assert.equal(host.parentNode, document.body);
  bar.destroy();
  assert.equal(host.parentNode, null);
  assert.equal(document.body.children.length, 1);
});
