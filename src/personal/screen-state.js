import { createHash } from 'node:crypto';

export const screenHash = (text, keyboard) => createHash('sha256')
  .update(JSON.stringify([text, keyboard ?? { inline_keyboard: [] }])).digest('hex');

export async function standaloneScreen(store, id, messageId, ownerId) {
  return Boolean(messageId) && String(id) !== String(ownerId)
    && !await store.first("SELECT 1 FROM cards c,json_each(c.parts) p WHERE c.user_id=? AND json_extract(p.value,'$.id')=? LIMIT 1", id, messageId);
}
