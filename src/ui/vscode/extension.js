// The only file that imports the VS Code API. Everything else receives it as a parameter, so
// it can be tested with a fake and the rest of the core never depends on the editor.
import * as vscode from 'vscode';
import { activateWith } from './activate.js';

export const activate = (context) => activateWith(vscode, context);

export const deactivate = () => {};
