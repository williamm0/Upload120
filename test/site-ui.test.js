'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

class FakeClassList {
  constructor(initial = []) {
    this.values = new Set(initial);
  }

  add(value) {
    this.values.add(value);
  }

  remove(value) {
    this.values.delete(value);
  }

  toggle(value, force) {
    const active = force === undefined ? !this.values.has(value) : Boolean(force);
    if (active) this.values.add(value);
    else this.values.delete(value);
    return active;
  }

  contains(value) {
    return this.values.has(value);
  }
}

class FakeElement {
  constructor({ id = '', tag = 'div', dataset = {}, classes = [] } = {}) {
    this.id = id;
    this.tag = tag;
    this.dataset = dataset;
    this.classList = new FakeClassList(classes);
    this.listeners = {};
    this.attributes = {};
    this.children = [];
    this.innerHTML = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
  }

  addEventListener(type, handler) {
    this.listeners[type] = handler;
  }

  dispatch(type, event = {}) {
    return this.listeners[type]?.({ target: this, preventDefault() {}, ...event });
  }

  closest(selector) {
    if (selector === '[data-method]' && this.dataset.method) return this;
    if (selector === '[data-mode]' && this.dataset.mode) return this;
    return null;
  }

  matches(selector) {
    return selector === this.tag;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  append(child) {
    this.children.push(child);
  }

  remove() {}

  click() {
    this.dispatch('click');
  }

  focus() {}
}

function buildDocument() {
  const ids = new Map();
  const methodButtons = [
    new FakeElement({ tag: 'button', dataset: { method: 'balanced-sync' }, classes: ['method-card', 'active'] }),
    new FakeElement({ tag: 'button', dataset: { method: 'header-lite' }, classes: ['method-card'] }),
    new FakeElement({ tag: 'button', dataset: { method: 'classic-force' }, classes: ['method-card'] })
  ];
  const modeButtons = [
    new FakeElement({ tag: 'button', dataset: { mode: 'auto' }, classes: ['mult-card', 'active'] }),
    new FakeElement({ tag: 'button', dataset: { mode: '2' }, classes: ['mult-card'] }),
    new FakeElement({ tag: 'button', dataset: { mode: '4' }, classes: ['mult-card'] }),
    new FakeElement({ tag: 'label', dataset: { mode: 'custom' }, classes: ['mult-card', 'custom-card'] })
  ];
  const navItems = ['patch', 'how', 'settings', 'about'].map(id => new FakeElement({ dataset: { nav: id } }));
  const sections = ['patch', 'how', 'settings', 'about'].map(id => new FakeElement({ id }));

  for (const id of [
    'dropzone',
    'browseBtn',
    'fileInput',
    'queue',
    'processBtn',
    'clearQueueBtn',
    'methodRow',
    'methodHint',
    'multiplierRow',
    'customMultiplier',
    'suffixInput',
    'autoDownloadInput',
    'modeHint'
  ]) {
    ids.set(id, new FakeElement({ id }));
  }

  ids.get('suffixInput').value = '_patch';
  ids.get('customMultiplier').value = '2';

  return {
    ids,
    methodButtons,
    modeButtons,
    querySelector(selector) {
      if (selector.startsWith('#')) return ids.get(selector.slice(1));
      if (selector === '.custom-card') return modeButtons[3];
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-nav]') return navItems;
      if (selector === '[data-method]') return methodButtons;
      if (selector === '[data-mode]') return modeButtons;
      if (selector === 'main > section[id]') return sections;
      return [];
    },
    createElement(tag) {
      return new FakeElement({ tag });
    },
    body: new FakeElement()
  };
}

test('website queue captures the selected local method for new files', async () => {
  const document = buildDocument();
  const script = fs.readFileSync(path.join(__dirname, '..', 'docs', 'script.js'), 'utf8');
  const context = {
    document,
    window: {
      Upload120Patcher: {
        inspectMp4() {
          return { isMp4: true, fps: 120, width: 1920, height: 1080 };
        },
        patchMp4Buffer() {
          throw new Error('processQueue should not run in this test');
        }
      }
    },
    IntersectionObserver: class {
      observe() {}
    },
    Number,
    RegExp,
    String,
    URL: { revokeObjectURL() {}, createObjectURL() { return 'blob:test'; } },
    setTimeout
  };

  vm.runInNewContext(script, context);

  document.ids.get('methodRow').dispatch('click', { target: document.methodButtons[1] });
  document.ids.get('fileInput').dispatch('change', {
    target: {
      files: [{
        name: 'clip.mp4',
        size: 100,
        type: 'video/mp4',
        async arrayBuffer() {
          return new ArrayBuffer(8);
        }
      }]
    }
  });

  await new Promise(resolve => setImmediate(resolve));

  assert.match(document.ids.get('queue').innerHTML, /Header Lite/);
});
