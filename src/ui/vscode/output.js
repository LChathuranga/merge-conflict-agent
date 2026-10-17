import { redact } from '../viewmodel/redact.js';

// Output channel logging. Everything passes through the redactor, so an API key that ends up
// in an error message or a URL never reaches the log.
export const createLogger = ({ vscode, getSecrets = () => [] }) => {
  const channel = vscode.window.createOutputChannel('Merge Assistant');
  const write = (level, message) => {
    const time = new Date().toISOString().slice(11, 19);
    channel.appendLine(redact(`[${time}] ${level} ${message}`, getSecrets()));
  };

  return {
    info: (message) => write('INFO ', message),
    warn: (message) => write('WARN ', message),
    error: (message) => write('ERROR', message),
    show: (preserveFocus = true) => channel.show(preserveFocus),
    redact: (text) => redact(text, getSecrets()),
    dispose: () => channel.dispose(),
  };
};
