import { buildTree } from '../viewmodel/treeModel.js';

const COLLAPSIBLE = { none: 'None', collapsed: 'Collapsed', expanded: 'Expanded' };

export const toTreeItem = (vscode, descriptor) => {
  const item = new vscode.TreeItem(descriptor.label, vscode.TreeItemCollapsibleState[COLLAPSIBLE[descriptor.collapsible] ?? 'None']);
  item.id = descriptor.id;
  item.description = descriptor.description;
  item.tooltip = descriptor.tooltip;
  item.contextValue = descriptor.contextValue;
  if (descriptor.icon) {
    item.iconPath = new vscode.ThemeIcon(descriptor.icon.id, descriptor.icon.color ? new vscode.ThemeColor(descriptor.icon.color) : undefined);
  }
  if (descriptor.command) {
    item.command = { command: descriptor.command.id, title: descriptor.command.title ?? '', arguments: descriptor.command.args };
  }
  return item;
};

export const createTreeProvider = ({ vscode, session, isBusy = () => false }) => {
  const emitter = new vscode.EventEmitter();
  const stop = session.onDidChange(() => emitter.fire(undefined));

  return {
    onDidChangeTreeData: emitter.event,
    getChildren: (element) => (element ? element.children : buildTree(session.state, { busy: isBusy() })),
    getTreeItem: (descriptor) => toTreeItem(vscode, descriptor),
    refresh: () => emitter.fire(undefined),
    dispose() {
      stop();
      emitter.dispose();
    },
  };
};
