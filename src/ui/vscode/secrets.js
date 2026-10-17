import { PROVIDERS, keySlot } from '../viewmodel/settings.js';

const BASE_SLOTS = PROVIDERS.filter((p) => p !== 'ollama');
const keyName = (slot) => `mergeAssistant.apiKey.${slot}`;
const INDEX_NAME = 'mergeAssistant.keySlots';

// API keys live only in VS Code's SecretStorage (never in settings, files or the log).
// A "slot" names the server a key belongs to: "openai", "anthropic", or "openai@host" for another
// OpenAI-compatible server. SecretStorage cannot list its keys, so the extra slots are remembered
// in an index kept in the same store (names only, never the keys).
export const createSecretStore = (secretStorage) => {
  const readIndex = async () => {
    try {
      const parsed = JSON.parse((await secretStorage.get(INDEX_NAME)) ?? '[]');
      return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string') : [];
    } catch {
      return [];
    }
  };
  const writeIndex = (slots) => secretStorage.store(INDEX_NAME, JSON.stringify([...new Set(slots)]));

  return {
    get: (slot) => secretStorage.get(keyName(slot)),
    async set(slot, value) {
      await secretStorage.store(keyName(slot), value);
      if (!BASE_SLOTS.includes(slot)) await writeIndex([...(await readIndex()), slot]);
    },
    async clear(slot) {
      await secretStorage.delete(keyName(slot));
      if (!BASE_SLOTS.includes(slot)) await writeIndex((await readIndex()).filter((s) => s !== slot));
    },
    async slots() {
      return [...BASE_SLOTS, ...(await readIndex())];
    },
    // { slot: key } for every slot that currently holds a key.
    async loadAll() {
      const keys = {};
      for (const slot of [...BASE_SLOTS, ...(await readIndex())]) keys[slot] = (await secretStorage.get(keyName(slot))) ?? '';
      return keys;
    },
  };
};

const slotLabel = (slot) => (slot.startsWith('openai@') ? `OpenAI-compatible server ${slot.slice(7)}` : slot);

export const apiKeyCommands = ({ vscode, store, getSettings, onChanged }) => ({
  async setApiKey() {
    const settings = getSettings();
    const current = keySlot(settings);
    // The slots to offer: the two services, plus the other server the settings point at, if any.
    const offered = [...new Set([...BASE_SLOTS, ...(settings.provider === 'openai' && current !== 'openai' ? [current] : [])])];
    const picked = await vscode.window.showQuickPick(
      offered.map((slot) => ({ label: slot, description: slot === current ? 'in use now' : slotLabel(slot) === slot ? '' : slotLabel(slot) })),
      { title: 'Set API key for which provider?', placeHolder: 'Ollama needs no key' }
    );
    if (!picked) return;

    const value = await vscode.window.showInputBox({
      title: `${picked.label} API key`,
      prompt: 'Stored in VS Code secret storage on this machine. It is never written to settings or the log.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (text) => (text.trim().length < 8 ? 'That does not look like an API key.' : undefined),
    });
    if (value === undefined) return;

    await store.set(picked.label, value.trim());
    await onChanged();
    vscode.window.showInformationMessage(`Saved the ${picked.label} API key.`);
  },

  async clearApiKey() {
    const keys = await store.loadAll();
    const stored = Object.keys(keys).filter((slot) => keys[slot]);
    if (stored.length === 0) {
      vscode.window.showInformationMessage('No API keys are stored.');
      return;
    }
    const picked = await vscode.window.showQuickPick(stored.map((label) => ({ label, description: slotLabel(label) === label ? '' : slotLabel(label) })), { title: 'Clear which API key?' });
    if (!picked) return;

    await store.clear(picked.label);
    await onChanged();
    vscode.window.showInformationMessage(`Cleared the ${picked.label} API key.`);
  },
});
