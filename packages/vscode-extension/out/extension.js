"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const fs_1 = require("fs");
/**
 * smallchat VS Code Extension
 *
 * Provides:
 * - Syntax highlighting for .smallchat manifest files
 * - Autocomplete for tool names in configuration files
 * - JSON validation for manifest and config files
 * - Hover information for selectors and tools
 */
let toolNames = [];
let providerNames = [];
function activate(context) {
    // Load tool names from compiled artifacts for autocomplete
    loadToolNames();
    // Register completion provider for JSON files
    const completionProvider = vscode.languages.registerCompletionItemProvider([
        { language: 'json', pattern: '**/*-manifest.json' },
        { language: 'json', pattern: '**/*.toolkit.json' },
        { language: 'json', pattern: '**/smallchat.config.json' },
        { language: 'smallchat' },
    ], {
        provideCompletionItems(document, position) {
            const lineText = document.lineAt(position).text;
            const items = [];
            // Suggest tool names
            if (lineText.includes('"name"') || lineText.includes('"toolName"')) {
                for (const name of toolNames) {
                    const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
                    item.detail = 'smallchat tool';
                    items.push(item);
                }
            }
            // Suggest provider IDs
            if (lineText.includes('"providerId"') || lineText.includes('"id"')) {
                for (const name of providerNames) {
                    const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Module);
                    item.detail = 'smallchat provider';
                    items.push(item);
                }
            }
            // Suggest transport types
            if (lineText.includes('"transportType"')) {
                for (const type of ['mcp', 'rest', 'local', 'grpc']) {
                    const item = new vscode.CompletionItem(type, vscode.CompletionItemKind.Enum);
                    item.detail = 'Transport type';
                    items.push(item);
                }
            }
            // Suggest JSON Schema types
            if (lineText.includes('"type"')) {
                for (const type of ['string', 'number', 'boolean', 'object', 'array', 'integer', 'null']) {
                    const item = new vscode.CompletionItem(type, vscode.CompletionItemKind.TypeParameter);
                    item.detail = 'JSON Schema type';
                    items.push(item);
                }
            }
            return items;
        },
    }, '"');
    // Register hover provider
    const hoverProvider = vscode.languages.registerHoverProvider([
        { language: 'json', pattern: '**/*-manifest.json' },
        { language: 'smallchat' },
    ], {
        provideHover(document, position) {
            const range = document.getWordRangeAtPosition(position, /[a-zA-Z_][a-zA-Z0-9_-]*/);
            if (!range)
                return;
            const word = document.getText(range);
            if (toolNames.includes(word)) {
                return new vscode.Hover(new vscode.MarkdownString(`**smallchat tool**: \`${word}\`\n\nRegistered tool name in the dispatch table.`));
            }
            if (providerNames.includes(word)) {
                return new vscode.Hover(new vscode.MarkdownString(`**smallchat provider**: \`${word}\`\n\nRegistered provider/tool class.`));
            }
            return undefined;
        },
    });
    // Watch for toolkit file changes to refresh completions
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.toolkit.json');
    watcher.onDidChange(() => loadToolNames());
    watcher.onDidCreate(() => loadToolNames());
    context.subscriptions.push(completionProvider, hoverProvider, watcher);
    vscode.window.showInformationMessage('smallchat extension activated');
}
function deactivate() {
    toolNames = [];
    providerNames = [];
}
/**
 * Load tool and provider names from any .toolkit.json files in the workspace.
 */
function loadToolNames() {
    toolNames = [];
    providerNames = [];
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders)
        return;
    for (const folder of workspaceFolders) {
        // Look for compiled toolkit artifacts
        const toolkitPattern = new vscode.RelativePattern(folder, '**/*.toolkit.json');
        vscode.workspace.findFiles(toolkitPattern, '**/node_modules/**', 5).then((files) => {
            for (const file of files) {
                try {
                    const content = (0, fs_1.readFileSync)(file.fsPath, 'utf-8');
                    const data = JSON.parse(content);
                    if (data.dispatchTables) {
                        for (const [providerId, table] of Object.entries(data.dispatchTables)) {
                            providerNames.push(providerId);
                            const methods = table;
                            for (const [, method] of Object.entries(methods)) {
                                if (method.toolName) {
                                    toolNames.push(method.toolName);
                                }
                            }
                        }
                    }
                }
                catch {
                    // Ignore parse errors
                }
            }
        });
        // Also scan manifest files
        const manifestPattern = new vscode.RelativePattern(folder, '**/*-manifest.json');
        vscode.workspace.findFiles(manifestPattern, '**/node_modules/**', 20).then((files) => {
            for (const file of files) {
                try {
                    const content = (0, fs_1.readFileSync)(file.fsPath, 'utf-8');
                    const data = JSON.parse(content);
                    if (data.id)
                        providerNames.push(data.id);
                    if (Array.isArray(data.tools)) {
                        for (const tool of data.tools) {
                            if (tool.name)
                                toolNames.push(tool.name);
                        }
                    }
                }
                catch {
                    // Ignore
                }
            }
        });
    }
}
//# sourceMappingURL=extension.js.map