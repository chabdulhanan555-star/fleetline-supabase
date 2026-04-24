import { createStore, del, entries, get, set } from 'idb-keyval';

const store = createStore('fleetline', 'outbox');
const listeners = new Set();

async function emit() {
  const items = await listOutbox();
  listeners.forEach((listener) => listener(items));
}

export async function listOutbox() {
  const rows = await entries(store);
  return rows
    .map(([id, value]) => ({ id, ...value }))
    .sort((left, right) => (left.queuedAt ?? 0) - (right.queuedAt ?? 0));
}

export async function getOutboxItem(id) {
  const value = await get(id, store);
  return value ? { id, ...value } : null;
}

export async function enqueue(item) {
  await set(item.id, {
    ...item,
    attempts: item.attempts ?? 0,
    queuedAt: item.queuedAt ?? Date.now(),
  }, store);
  await emit();
}

export async function removeFromOutbox(id) {
  await del(id, store);
  await emit();
}

export function onOutboxChange(listener) {
  listeners.add(listener);
  listOutbox().then(listener);
  return () => listeners.delete(listener);
}

function wait(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export async function flushOutbox(replay) {
  const items = await listOutbox();

  for (const item of items) {
    try {
      await replay(item);
      await del(item.id, store);
    } catch (error) {
      const attempts = (item.attempts ?? 0) + 1;
      await set(item.id, { ...item, attempts }, store);

      if (attempts >= 3) {
        console.error('[outbox] giving up after 3 attempts', item.id, error);
      } else {
        await wait(500 * 2 ** (attempts - 1));
      }
    }
  }

  await emit();
}
