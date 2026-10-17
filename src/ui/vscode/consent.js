import { dataDestination } from '../viewmodel/settings.js';

const ALLOW = 'Allow once';
const ALWAYS = 'Always allow';
const consentKey = (destination) => `mergeAssistant.consent.${destination}`;

// Before code leaves this machine, say where it goes and let the user decide. A destination the
// user has accepted for good is not asked about again; local models never ask.
export const ensureConsent = async ({ vscode, context, settings }) => {
  const destination = dataDestination(settings);
  if (!destination) return true;
  if (context.globalState.get(consentKey(destination), false)) return true;

  const choice = await vscode.window.showWarningMessage(
    `Send conflicting code to ${destination}?`,
    {
      modal: true,
      detail: [
        'Merge Assistant sends the conflicting code, the code around it, commit messages and where changed names are used to this service.',
        settings.useTools ? 'Tool calling is on, so files the model asks to read are sent too.' : null,
        'Files that commonly hold secrets (.env, keys) are never read. Use a local model if code must stay on this machine.',
      ].filter(Boolean).join('\n'),
    },
    ALLOW,
    ALWAYS
  );
  if (choice === ALWAYS) await context.globalState.update(consentKey(destination), true);
  return choice === ALLOW || choice === ALWAYS;
};
