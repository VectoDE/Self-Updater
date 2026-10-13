// SPDX-FileCopyrightText: 2025 Vecto <https://github.com/VectoDE>
//
// SPDX-License-Identifier: Apache-2.0

// Configuration builder: turns the form into an updater.config.json and checks it with the package's own schema.
import {
  CONFIG_VERSION,
  type ConfigIssue,
  migrateConfig,
  NOTIFICATION_EVENTS,
  type NotificationEvent,
  parseConfig,
} from '../../src/config.js';

type Json = Record<string, unknown>;
type Control = HTMLInputElement | HTMLSelectElement;

const STORAGE_KEY = 'self-updater-builder';
const PLACEHOLDER = /\$\{([A-Z_]\w*)(?::-[^}]*)?\}/gi;

const byId = (id: string): HTMLElement => {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`#${id} is missing`);
  }
  return element;
};

const form = byId('form') as HTMLFormElement;
const output = byId('json');
const status = byId('status');
const issueList = byId('issues');
const notifications = byId('notifications');
const rowTemplate = byId('notification-row') as HTMLTemplateElement;

const controls = (): Control[] => [...form.querySelectorAll<Control>('input[name], select[name]')];

const isVisible = (element: Element): boolean => element.closest('[hidden]') === null;

/** Writes value at a dotted path, creating the objects on the way. */
const setPath = (target: Json, path: string, value: unknown): void => {
  const keys = path.split('.');
  const last = keys.pop() ?? path;
  let node = target;
  for (const key of keys) {
    const next = node[key];
    if (typeof next === 'object' && next !== null) {
      node = next as Json;
    } else {
      const created: Json = {};
      node[key] = created;
      node = created;
    }
  }
  node[last] = value;
};

const getPath = (source: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((node, key) => {
    if (typeof node === 'object' && node !== null) {
      return (node as Json)[key];
    }
    return undefined;
  }, source);

/** The value a control contributes, or undefined to leave the key out and use the default. */
const inputValue = (input: HTMLInputElement): unknown => {
  switch (input.type) {
    case 'checkbox':
      return input.checked === input.defaultChecked ? undefined : input.checked;
    case 'radio':
      return input.checked && !input.defaultChecked ? input.value : undefined;
    case 'number':
      return input.value === '' ? undefined : Number(input.value);
    default: {
      const text = input.value.trim();
      return text === '' ? undefined : text;
    }
  }
};

const valueOf = (control: Control): unknown => {
  if (control instanceof HTMLInputElement) {
    return inputValue(control);
  }
  return control.value === '' ? undefined : control.value;
};

const notificationRows = (): HTMLDivElement[] => [...notifications.querySelectorAll<HTMLDivElement>('.notification')];

const readNotifications = (): Json[] =>
  notificationRows().map((row) => {
    const field = (key: string) => row.querySelector<Control>(`[data-key="${key}"]`)?.value.trim() ?? '';
    const events = NOTIFICATION_EVENTS.filter(
      (event) => row.querySelector<HTMLInputElement>(`[data-event="${event}"]`)?.checked
    );
    return { type: field('type'), url: field('url'), events };
  });

/** The configuration the form describes, with only the values that differ from the defaults. */
const collect = (): Json => {
  const config: Json = { version: CONFIG_VERSION };
  for (const control of controls()) {
    // Fields hidden by another choice do not apply, e.g. the tag pattern while following a branch.
    if (!isVisible(control)) {
      continue;
    }
    const value = valueOf(control);
    if (value !== undefined) {
      setPath(config, control.name, value);
    }
  }
  setPath(config, 'service.type', form.querySelector<HTMLSelectElement>('[name="service.type"]')?.value ?? 'none');
  const targets = readNotifications();
  if (targets.length > 0) {
    config.notifications = targets;
  }
  return config;
};

/**
 * ${NAME} placeholders are filled in from the environment on the server. For the check they get stand-in values of
 * the right shape: a URL for names ending in URL, a long string for everything else.
 */
const withStandIns = (config: Json): unknown =>
  JSON.parse(
    JSON.stringify(config).replaceAll(PLACEHOLDER, (_match, name: string) =>
      name.toUpperCase().endsWith('URL') ? 'https://placeholder.invalid/hook' : 'x'.repeat(32)
    )
  );

/** Secrets typed in plain text would end up in the file; they belong in the environment. */
const secretWarnings = (): ConfigIssue[] =>
  [...form.querySelectorAll<HTMLInputElement>('input[data-secret]')]
    .filter((input) => isVisible(input) && input.value.trim() !== '' && !input.value.includes('${'))
    .map((input) => ({
      path: input.name || 'notifications',
      message: 'holds a secret in plain text; write ${NAME} and set NAME in the environment or .env',
    }));

const STEP_OF: [string, string][] = [
  ['hooks.postUpdate', 'rollback'],
  ['hooks', 'hooks'],
  ['schedule', 'triggers'],
  ['webhook', 'triggers'],
];

const stepOf = (path: string): string => {
  const special = STEP_OF.find(([prefix]) => path === prefix || path.startsWith(`${prefix}.`));
  return special?.[1] ?? path.split(/[.[]/)[0] ?? '';
};

const controlFor = (path: string): HTMLElement | null => {
  const notification = /^notifications\[(\d+)\]\.?(\w*)/.exec(path);
  if (notification) {
    const row = notificationRows()[Number(notification[1])];
    return (
      row?.querySelector<HTMLElement>(`[data-key="${notification[2] === '' ? 'url' : (notification[2] ?? 'url')}"]`) ??
      row ??
      null
    );
  }
  return form.querySelector<HTMLElement>(`[name="${CSS.escape(path)}"]`);
};

const issueItem = (issue: ConfigIssue, kind: 'problem' | 'warning'): HTMLLIElement => {
  const item = document.createElement('li');
  item.className = `issue issue--${kind}`;
  const button = document.createElement('button');
  button.type = 'button';
  const where = document.createElement('code');
  where.textContent = issue.path || 'configuration';
  button.append(where, ` ${issue.message}`);
  button.addEventListener('click', () => {
    const target = controlFor(issue.path);
    target?.scrollIntoView({
      block: 'center',
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
    target?.focus({ preventScroll: true });
  });
  item.append(button);
  return item;
};

const markSteps = (problems: ConfigIssue[], warnings: ConfigIssue[]): void => {
  const bad = new Set(problems.map(({ path }) => stepOf(path)));
  const warned = new Set(warnings.map(({ path }) => stepOf(path)));
  for (const step of form.querySelectorAll<HTMLElement>('[data-step]')) {
    const name = step.dataset.step ?? '';
    if (bad.has(name)) {
      step.dataset.state = 'problem';
    } else if (warned.has(name)) {
      step.dataset.state = 'warning';
    } else {
      delete step.dataset.state;
    }
  }
  for (const control of form.querySelectorAll('[aria-invalid]')) {
    control.removeAttribute('aria-invalid');
  }
  for (const { path } of problems) {
    controlFor(path)?.setAttribute('aria-invalid', 'true');
  }
};

let current = '';
// Until the first input, the form shows where to begin instead of a list of empty required fields.
let started = false;

const showStart = (): void => {
  issueList.replaceChildren();
  markSteps([], []);
  status.dataset.state = 'idle';
  status.textContent = 'Start with the clone URL and the workspace directory';
};

const render = (): void => {
  const config = collect();
  current = `${JSON.stringify(config, null, 2)}\n`;
  output.textContent = current;
  if (!started) {
    showStart();
    return;
  }
  const result = parseConfig(withStandIns(config));
  const problems = result.ok ? [] : result.issues;
  const warnings = secretWarnings();
  issueList.replaceChildren(
    ...problems.map((issue) => issueItem(issue, 'problem')),
    ...warnings.map((issue) => issueItem(issue, 'warning'))
  );
  markSteps(problems, warnings);
  if (problems.length > 0) {
    status.dataset.state = 'problem';
    status.textContent = problems.length === 1 ? '1 problem to fix' : `${problems.length} problems to fix`;
  } else {
    status.dataset.state = warnings.length > 0 ? 'warning' : 'ok';
    status.textContent = warnings.length > 0 ? 'Valid, with a secret in plain text' : 'Valid';
  }
  try {
    localStorage.setItem(STORAGE_KEY, current);
  } catch {
    // Storage can be blocked; the builder works without it.
  }
};

/** Shows the fields that apply to the current choices (data-when="path" or "path=value,value"). */
const applyConditions = (): void => {
  for (const element of form.querySelectorAll<HTMLElement>('[data-when]')) {
    const [path = '', values] = (element.dataset.when ?? '').split('=');
    const source = [...form.querySelectorAll<Control>(`[name="${CSS.escape(path)}"]`)];
    const active = source.find(
      (control) => !(control instanceof HTMLInputElement && control.type === 'radio') || control.checked
    );
    let shown: boolean;
    if (values === undefined) {
      shown = active instanceof HTMLInputElement && active.checked;
    } else {
      shown = values.split(',').includes(active?.value ?? '');
    }
    element.hidden = !shown;
  }
};

const addNotification = (values?: { type?: unknown; url?: unknown; events?: unknown }): void => {
  const fragment = rowTemplate.content.cloneNode(true) as DocumentFragment;
  const row = fragment.querySelector<HTMLDivElement>('.notification');
  if (!row) {
    return;
  }
  const type = row.querySelector<HTMLSelectElement>('[data-key="type"]');
  const url = row.querySelector<HTMLInputElement>('[data-key="url"]');
  if (type && typeof values?.type === 'string') type.value = values.type;
  if (url && typeof values?.url === 'string') url.value = values.url;
  if (Array.isArray(values?.events)) {
    const events = new Set(values.events as NotificationEvent[]);
    for (const box of row.querySelectorAll<HTMLInputElement>('[data-event]')) {
      box.checked = events.has(box.dataset.event as NotificationEvent);
    }
  }
  row.querySelector('.remove')?.addEventListener('click', () => {
    row.remove();
    render();
  });
  notifications.append(row);
};

const fillControl = (control: Control, value: unknown): void => {
  if (control instanceof HTMLInputElement && control.type === 'checkbox') {
    control.checked = typeof value === 'boolean' ? value : control.defaultChecked;
  } else if (control instanceof HTMLInputElement && control.type === 'radio') {
    control.checked = value === undefined ? control.defaultChecked : value === control.value;
  } else if (typeof value === 'string' || typeof value === 'number') {
    control.value = String(value);
  } else {
    control.value = control instanceof HTMLSelectElement ? (control.options[0]?.value ?? '') : '';
  }
};

/** Puts a configuration (any version) into the form. */
const load = (raw: unknown): void => {
  for (const control of controls()) {
    fillControl(control, getPath(raw, control.name));
  }
  notifications.replaceChildren();
  const targets = getPath(raw, 'notifications');
  if (Array.isArray(targets)) {
    for (const target of targets as Json[]) {
      addNotification(target);
    }
  }
  applyConditions();
  render();
};

const importResult = byId('import-result');

byId('import-button').addEventListener('click', () => {
  const source = (byId('import-source') as HTMLTextAreaElement).value;
  try {
    const { raw, migrated } = migrateConfig(JSON.parse(source));
    started = true;
    load(raw);
    importResult.textContent = migrated
      ? 'Loaded and converted to the current format. Rollback stays off, as in 2.x.'
      : 'Loaded.';
  } catch {
    importResult.textContent = 'That is not valid JSON. Paste the whole file, including the outer braces.';
  }
});

byId('add-notification').addEventListener('click', () => {
  addNotification();
  render();
  notificationRows().at(-1)?.querySelector<HTMLElement>('[data-key="url"]')?.focus();
});

byId('copy').addEventListener('click', () => {
  navigator.clipboard.writeText(current).then(
    () => {
      status.textContent = 'Copied to the clipboard';
    },
    () => {
      status.textContent = 'Copying is blocked here; select the text and copy it by hand';
    }
  );
});

byId('download').addEventListener('click', () => {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([current], { type: 'application/json' }));
  link.download = 'updater.config.json';
  link.click();
  URL.revokeObjectURL(link.href);
});

form.addEventListener('input', () => {
  started = true;
  applyConditions();
  render();
});
form.addEventListener('change', () => {
  started = true;
  applyConditions();
  render();
});
form.addEventListener('submit', (event) => {
  event.preventDefault();
});

const readSaved = (): string | null => {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

const saved = readSaved();
if (saved) {
  started = true;
  try {
    load(JSON.parse(saved));
  } catch {
    load({});
  }
} else {
  applyConditions();
  render();
}
