import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';

// In-memory mappings to track files and prevent infinite sync loops
const fileKeyToRelativePath = new Map<string, string>();
const lastReceivedContent = new Map<string, string>(); // absolutePath -> content

let historyProvider: EnvSyncHistoryProvider | null = null;

// Visual decoration type for highlighting changed lines in .env files
const changeDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
    isWholeLine: true
});

/**
 * Execute a shell command and return the trimmed output.
 */
function execCmd(cmd: string, cwd: string): string {
    try {
        return cp.execSync(cmd, { cwd, encoding: 'utf8' }).trim();
    } catch {
        return '';
    }
}

/**
 * Identify the current developer and device.
 */
function getAuthor(cwd: string): string {
    const email = execCmd('git config --get user.email', cwd);
    const name = execCmd('git config --get user.name', cwd);
    const hostname = os.hostname();
    const userStr = email || name || os.userInfo().username || 'unknown';
    return `${userStr} (${hostname})`;
}

/**
 * Generate a unique, Firebase-safe project namespace based on the Git remote URL.
 */
function getProjectNamespace(cwd: string): string {
    const remoteUrl = execCmd('git config --get remote.origin.url', cwd);
    if (!remoteUrl) {
        // Fallback to workspace directory name
        return sanitizeKey(path.basename(cwd));
    }
    return sanitizeKey(remoteUrl);
}

/**
 * Sanitize strings to make them safe for Firebase Realtime Database keys.
 */
function sanitizeKey(key: string): string {
    return key
        .replace(/git@|https?:\/\//g, '') // strip protocol/git prefix
        .replace(/\\/g, '_')              // convert Windows backslashes to underscores
        .replace(/[:\/.$#\[\]@]/g, '_')   // replace illegal chars with underscore
        .replace(/__+/g, '_')             // collapse multiple underscores
        .replace(/^_+|_+$/g, '');         // trim leading/trailing underscores
}

/**
 * Check if the document is a valid .env file in the workspace.
 */
function isEnvFile(document: vscode.TextDocument): boolean {
    const fileName = path.basename(document.fileName);
    const isEnv = fileName === '.env' || fileName.startsWith('.env.');
    const isIgnored = document.fileName.includes('node_modules') || 
                      document.fileName.includes('.next') || 
                      document.fileName.includes('dist');
    return isEnv && !isIgnored;
}

/**
 * Perform a standard HTTPS request (used for PUT and POST calls to Firebase).
 */
function makeRequest(urlStr: string, method: string, data?: any): Promise<void> {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(urlStr);
        const body = data ? JSON.stringify(data) : '';
        const options: https.RequestOptions = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        };

        const req = https.request(options, (res) => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                resolve();
            } else {
                reject(new Error(`HTTP ${res.statusCode} on ${method} ${urlStr}`));
            }
        });

        req.on('error', reject);
        if (body) {
            req.write(body);
        }
        req.end();
    });
}

/**
 * Heuristics to detect line-by-line differences.
 * Highlights line if it differs from the line at same index AND does not exist anywhere in the old file.
 * This prevents shifting highlights when new lines are inserted.
 */
function getLineDiffs(oldContent: string, newContent: string): number[] {
    const oldLines = oldContent.split('\n').map(l => l.trim());
    const newLines = newContent.split('\n');
    const oldSet = new Set(oldLines);
    const changedLineNumbers: number[] = [];

    for (let i = 0; i < newLines.length; i++) {
        const lineContentClean = newLines[i].trim();
        const oldLineAtSameIndex = oldLines[i];
        if (oldLineAtSameIndex === undefined || lineContentClean !== oldLineAtSameIndex) {
            if (!oldSet.has(lineContentClean)) {
                changedLineNumbers.push(i);
            }
        }
    }
    return changedLineNumbers;
}

/**
 * Apply temporary background highlighting to modified lines in the open editor.
 */
function highlightChanges(editor: vscode.TextEditor, changedLines: number[]) {
    const decorations = changedLines.map(line => {
        const range = new vscode.Range(line, 0, line, 0);
        return { range };
    });
    editor.setDecorations(changeDecorationType, decorations);

    // Clear highlights automatically after 10 seconds
    setTimeout(() => {
        editor.setDecorations(changeDecorationType, []);
    }, 10000);
}

/**
 * Class managing the synchronization state and socket connection for a single workspace folder.
 */
class WorkspaceSyncSession {
    private sseRequest: http.ClientRequest | null = null;
    private sseBuffer = '';
    private disposables: vscode.Disposable[] = [];
    private stopped = false;

    constructor(
        private folder: vscode.WorkspaceFolder,
        private dbUrl: string
    ) {}

    public start() {
        const workspaceRoot = this.folder.uri.fsPath;
        const author = getAuthor(workspaceRoot);
        const projectName = getProjectNamespace(workspaceRoot);

        console.log(`[Env Sync] Starting session for ${this.folder.name} (ID: ${projectName})`);
        
        // 1. Start listening to Firebase changes via Server-Sent Events (SSE)
        this.connectSse(projectName, workspaceRoot, author);

        // 2. Register save document listener
        const saveListener = vscode.workspace.onDidSaveTextDocument(async (document) => {
            if (!isEnvFile(document)) return;
            
            const docFolder = vscode.workspace.getWorkspaceFolder(document.uri);
            if (!docFolder || docFolder.uri.fsPath !== workspaceRoot) return;

            const absolutePath = document.fileName;
            const relativePath = path.relative(workspaceRoot, absolutePath).replace(/\\/g, '/');
            const content = document.getText();

            // Loop prevention: check if saved content matches the last synced content
            if (lastReceivedContent.get(absolutePath) === content) {
                return;
            }

            // Cache locally
            lastReceivedContent.set(absolutePath, content);

            // Push to Firebase
            const escapedPath = sanitizeKey(relativePath);
            const fileUrl = `${this.dbUrl.replace(/\/$/, '')}/env-sync/projects/${projectName}/files/${escapedPath}.json`;
            const historyUrl = `${this.dbUrl.replace(/\/$/, '')}/env-sync/projects/${projectName}/history/${escapedPath}.json`;

            const payload = {
                path: relativePath,
                content: content,
                updatedAt: Date.now(),
                updatedBy: author
            };

            try {
                await makeRequest(fileUrl, 'PUT', payload);
                await makeRequest(historyUrl, 'POST', payload);
                vscode.window.showInformationMessage(`[Env Sync] Pushed ${relativePath} to database.`);
                if (historyProvider) {
                    historyProvider.refresh();
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`[Env Sync] Error pushing ${relativePath}: ${err.message}`);
            }
        });

        this.disposables.push(saveListener);
    }

    public stop() {
        this.stopped = true;
        if (this.sseRequest) {
            this.sseRequest.destroy();
            this.sseRequest = null;
        }
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables = [];
        console.log(`[Env Sync] Stopped session for ${this.folder.name}`);
    }

    private connectSse(projectName: string, workspaceRoot: string, author: string) {
        // Destroy any existing connection before opening a new one
        if (this.sseRequest) {
            this.sseRequest.destroy();
            this.sseRequest = null;
        }

        // Don't reconnect if the session was stopped
        if (this.stopped) return;

        const urlStr = `${this.dbUrl.replace(/\/$/, '')}/env-sync/projects/${projectName}/files.json`;
        const parsedUrl = new URL(urlStr);

        const options: https.RequestOptions = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: {
                'Accept': 'text/event-stream'
            }
        };

        const req = https.request(options, (res) => {
            this.sseBuffer = '';
            
            res.on('data', (chunk) => {
                this.sseBuffer += chunk.toString();
                // Normalize newlines and split by double newlines (SSE packet separator)
                const normalized = this.sseBuffer.replace(/\r\n/g, '\n');
                const packets = normalized.split('\n\n');
                
                // Keep trailing incomplete packet
                this.sseBuffer = packets.pop() || '';

                for (const packet of packets) {
                    if (!packet.trim()) continue;

                    let eventType = 'put';
                    let dataStr = '';

                    const lines = packet.split('\n');
                    for (const line of lines) {
                        if (line.startsWith('event:')) {
                            eventType = line.slice(6).trim();
                        } else if (line.startsWith('data:')) {
                            dataStr = line.slice(5).trim();
                        }
                    }

                    if (dataStr && eventType !== 'keep-alive') {
                        try {
                            const payload = JSON.parse(dataStr);
                            this.handleDbUpdate(eventType, payload, workspaceRoot, author);
                        } catch (err) {
                            // Suppress parsing errors on incomplete packets
                        }
                    }
                }
            });

            res.on('end', () => {
                // Stream closed by server — reconnect after a short delay
                if (!this.stopped) {
                    setTimeout(() => {
                        this.connectSse(projectName, workspaceRoot, author);
                    }, 3000);
                }
            });
        });

        req.on('error', (err: any) => {
            console.error(`[Env Sync] SSE connection error for ${projectName}:`, err);
            // Reconnect after error with longer delay
            if (!this.stopped) {
                setTimeout(() => {
                    this.connectSse(projectName, workspaceRoot, author);
                }, 5000);
            }
        });

        this.sseRequest = req;
        req.end();
    }

    private handleDbUpdate(event: string, payload: any, workspaceRoot: string, author: string) {
        if (!payload || (event !== 'put' && event !== 'patch')) return;

        const eventPath = payload.path;
        const data = payload.data;
        if (data === null || data === undefined) return;

        if (eventPath === '/') {
            // Full state or multiple files update
            for (const fileKey in data) {
                const fileInfo = data[fileKey];
                if (fileInfo && typeof fileInfo === 'object' && fileInfo.content !== undefined) {
                    fileKeyToRelativePath.set(fileKey, fileInfo.path);
                    this.syncFileLocally(fileInfo.path, fileInfo.content, fileInfo.updatedBy || 'unknown', workspaceRoot, author);
                }
            }
        } else {
            const pathParts = eventPath.split('/').filter(Boolean);
            if (pathParts.length === 1) {
                // Path like "/apps_api_env"
                const fileKey = pathParts[0];
                if (data && typeof data === 'object') {
                    const relativePath = data.path || fileKeyToRelativePath.get(fileKey);
                    if (relativePath && data.content !== undefined) {
                        fileKeyToRelativePath.set(fileKey, relativePath);
                        this.syncFileLocally(relativePath, data.content, data.updatedBy || 'unknown', workspaceRoot, author);
                    }
                }
            } else if (pathParts.length >= 2) {
                // Deep path updates like "/apps_api_env/content" or "/apps_api_env/updatedBy"
                const fileKey = pathParts[0];
                const relativePath = fileKeyToRelativePath.get(fileKey);
                if (relativePath) {
                    if (pathParts[1] === 'content' && typeof data === 'string') {
                        // Direct content update from console
                        this.syncFileLocally(relativePath, data, 'Firebase Console', workspaceRoot, author);
                    } else {
                        // Fallback to fetch from DB for other deep paths
                        this.refreshFileFromDb(fileKey, relativePath, workspaceRoot, author);
                    }
                }
            }
        }
    }

    private async refreshFileFromDb(fileKey: string, relativePath: string, workspaceRoot: string, author: string) {
        const fileUrl = `${this.dbUrl.replace(/\/$/, '')}/env-sync/projects/${getProjectNamespace(workspaceRoot)}/files/${fileKey}.json`;
        try {
            const responseData = await new Promise<string>((resolve, reject) => {
                https.get(fileUrl, (res) => {
                    let body = '';
                    res.on('data', chunk => body += chunk);
                    res.on('end', () => resolve(body));
                }).on('error', reject);
            });
            const fileInfo = JSON.parse(responseData);
            if (fileInfo && fileInfo.content !== undefined) {
                this.syncFileLocally(fileInfo.path, fileInfo.content, fileInfo.updatedBy, workspaceRoot, author);
            }
        } catch (err) {
            console.error('[Env Sync] Failed to refresh file from DB:', err);
        }
    }

    private syncFileLocally(
        relativePath: string,
        newContent: string,
        updatedBy: string,
        workspaceRoot: string,
        author: string
    ) {
        const absolutePath = path.join(workspaceRoot, relativePath);

        let currentContent = '';
        try {
            if (fs.existsSync(absolutePath)) {
                currentContent = fs.readFileSync(absolutePath, 'utf8');
            }
        } catch (err) {
            console.error('[Env Sync] Read local file error:', err);
        }

        // If content already matches, we are done
        if (currentContent === newContent) {
            return;
        }

        // Skip writing back changes made by ourselves to prevent loop conditions
        if (updatedBy === author) {
            return;
        }

        // Cache before writing to disk
        lastReceivedContent.set(absolutePath, newContent);

        // Ensure target directory exists
        const dir = path.dirname(absolutePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Write the updated content to disk
        fs.writeFileSync(absolutePath, newContent, 'utf8');
        vscode.window.showInformationMessage(`[Env Sync] Synchronized ${relativePath} (from ${updatedBy})`);
        if (historyProvider) {
            historyProvider.refresh();
        }

        // Apply highlighting to active editor if file is currently open
        const visibleEditors = vscode.window.visibleTextEditors;
        const matchingEditor = visibleEditors.find(editor => editor.document.fileName === absolutePath);
        if (matchingEditor) {
            const changedLines = getLineDiffs(currentContent, newContent);
            if (changedLines.length > 0) {
                highlightChanges(matchingEditor, changedLines);
            }
        }
    }
}

// Keep active sync sessions for each workspace folder
let activeSessions: WorkspaceSyncSession[] = [];

function runSyncSessions() {
    // Stop any active sessions
    for (const session of activeSessions) {
        session.stop();
    }
    activeSessions = [];

    const config = vscode.workspace.getConfiguration('envSync');
    const enabled = config.get<boolean>('enabled', true);
    const dbUrl = config.get<string>('databaseUrl', '');

    if (!enabled) {
        return;
    }

    if (!dbUrl) {
        vscode.window.showWarningMessage('[Env Sync] Database URL is not configured. Please set envSync.databaseUrl.');
        return;
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return;

    for (const folder of folders) {
        const session = new WorkspaceSyncSession(folder, dbUrl);
        session.start();
        activeSessions.push(session);
    }
}

export function activate(context: vscode.ExtensionContext) {
    runSyncSessions();

    const config = vscode.workspace.getConfiguration('envSync');
    const dbUrl = config.get<string>('databaseUrl', '');

    if (dbUrl) {
        // 1. Register the virtual document provider for history scheme
        const docProvider = new EnvSyncHistoryDocProvider();
        context.subscriptions.push(
            vscode.workspace.registerTextDocumentContentProvider('env-sync-history', docProvider)
        );

        // 2. Register the tree view provider
        historyProvider = new EnvSyncHistoryProvider();
        context.subscriptions.push(
            vscode.window.registerTreeDataProvider('envSyncHistory', historyProvider)
        );

        // 3. Register command for refresh
        context.subscriptions.push(
            vscode.commands.registerCommand('envSync.refreshHistory', () => {
                if (historyProvider) {
                    historyProvider.refresh();
                }
            })
        );

        // 4. Register command for manual pullFile
        context.subscriptions.push(
            vscode.commands.registerCommand('envSync.pullFile', async (item: FileItem) => {
                const dbUrl = vscode.workspace.getConfiguration('envSync').get<string>('databaseUrl', '') || '';
                if (!dbUrl || !item) return;

                const fileUrl = `${dbUrl.replace(/\/$/, '')}/env-sync/projects/${item.projectName}/files/${item.fileKey}.json`;
                try {
                    const fileInfo = await httpGetJson(fileUrl);
                    if (fileInfo && fileInfo.content !== undefined) {
                        const folder = vscode.workspace.workspaceFolders?.find(f => getProjectNamespace(f.uri.fsPath) === item.projectName);
                        if (folder) {
                            const absolutePath = path.join(folder.uri.fsPath, fileInfo.path);
                            const dir = path.dirname(absolutePath);
                            if (!fs.existsSync(dir)) {
                                fs.mkdirSync(dir, { recursive: true });
                            }
                            lastReceivedContent.set(absolutePath, fileInfo.content);
                            fs.writeFileSync(absolutePath, fileInfo.content, 'utf8');
                            vscode.window.showInformationMessage(`[Env Sync] Successfully pulled ${fileInfo.path} from database.`);
                            if (historyProvider) {
                                historyProvider.refresh();
                            }
                        }
                    }
                } catch (err: any) {
                    vscode.window.showErrorMessage(`[Env Sync] Failed to pull file: ${err.message}`);
                }
            })
        );

        // 5. Register command for manual pullAll
        context.subscriptions.push(
            vscode.commands.registerCommand('envSync.pullAll', async () => {
                const dbUrl = vscode.workspace.getConfiguration('envSync').get<string>('databaseUrl', '') || '';
                if (!dbUrl) {
                    vscode.window.showWarningMessage('[Env Sync] Database URL is not configured.');
                    return;
                }

                const folders = vscode.workspace.workspaceFolders;
                if (!folders) return;

                let pulledCount = 0;
                for (const folder of folders) {
                    const workspaceRoot = folder.uri.fsPath;
                    const projectName = getProjectNamespace(workspaceRoot);
                    const filesUrl = `${dbUrl.replace(/\/$/, '')}/env-sync/projects/${projectName}/files.json`;

                    try {
                        const filesData = await httpGetJson(filesUrl);
                        if (filesData && typeof filesData === 'object') {
                            for (const key in filesData) {
                                const fileInfo = filesData[key];
                                if (fileInfo && fileInfo.path && fileInfo.content !== undefined) {
                                    const absolutePath = path.join(workspaceRoot, fileInfo.path);
                                    const dir = path.dirname(absolutePath);
                                    if (!fs.existsSync(dir)) {
                                        fs.mkdirSync(dir, { recursive: true });
                                    }
                                    lastReceivedContent.set(absolutePath, fileInfo.content);
                                    fs.writeFileSync(absolutePath, fileInfo.content, 'utf8');
                                    pulledCount++;
                                }
                            }
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`[Env Sync] Failed to pull files for ${folder.name}: ${err.message}`);
                    }
                }

                if (pulledCount > 0) {
                    vscode.window.showInformationMessage(`[Env Sync] Successfully pulled ${pulledCount} .env file(s) from database.`);
                    if (historyProvider) {
                        historyProvider.refresh();
                    }
                } else {
                    vscode.window.showInformationMessage(`[Env Sync] No files found in database to pull.`);
                }
            })
        );
    }

    // Re-initialize if the user modifies our settings
    const configListener = vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('envSync')) {
            runSyncSessions();
            vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
    });
    context.subscriptions.push(configListener);

    // Clear decorations immediately when document is modified by the user
    const docChangeListener = vscode.workspace.onDidChangeTextDocument(event => {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document === event.document) {
            activeEditor.setDecorations(changeDecorationType, []);
        }
    });
    context.subscriptions.push(docChangeListener);
}

export function deactivate() {
    for (const session of activeSessions) {
        session.stop();
    }
    activeSessions = [];
}

/**
 * Custom URI document provider to serve historical versions from Firebase to the diff tool.
 */
class EnvSyncHistoryDocProvider implements vscode.TextDocumentContentProvider {
    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        // Uri format: env-sync-history://[projectName]/[fileKey]/[pushKey]
        const projectName = uri.authority;
        const parts = uri.path.split('/').filter(Boolean);
        if (parts.length < 2) return '';
        const [fileKey, pushKey] = parts;

        const dbUrl = vscode.workspace.getConfiguration('envSync').get<string>('databaseUrl', '') || '';
        if (!dbUrl) return 'Database URL is not configured.';

        const fileUrl = `${dbUrl.replace(/\/$/, '')}/env-sync/projects/${projectName}/history/${fileKey}/${pushKey}/content.json`;
        try {
            const data = await httpGetJson(fileUrl);
            return typeof data === 'string' ? data : '';
        } catch (err: any) {
            return `Failed to fetch history content: ${err.message}`;
        }
    }
}

/**
 * VS Code Tree Data Provider for displaying env sync history in the side bar explorer.
 */
class EnvSyncHistoryProvider implements vscode.TreeDataProvider<TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private activeProjectName = '';
    private activeWorkspaceRoot = '';

    constructor() {
        this.updateActiveWorkspace();
        vscode.window.onDidChangeActiveTextEditor(() => {
            this.updateActiveWorkspace();
        });
    }

    private updateActiveWorkspace() {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
            if (folder) {
                const workspaceRoot = folder.uri.fsPath;
                const projectName = getProjectNamespace(workspaceRoot);
                if (projectName !== this.activeProjectName) {
                    this.activeProjectName = projectName;
                    this.activeWorkspaceRoot = workspaceRoot;
                    this.refresh();
                }
            }
        } else if (!this.activeProjectName) {
            const folder = vscode.workspace.workspaceFolders?.[0];
            if (folder) {
                this.activeWorkspaceRoot = folder.uri.fsPath;
                this.activeProjectName = getProjectNamespace(this.activeWorkspaceRoot);
                this.refresh();
            }
        }
    }

    refresh(): void {
        this.updateActiveWorkspace();
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: TreeItem): Promise<TreeItem[]> {
        const dbUrl = vscode.workspace.getConfiguration('envSync').get<string>('databaseUrl', '') || '';
        if (!dbUrl || !this.activeProjectName) {
            return [];
        }

        if (!element) {
            // Root elements: File items
            const filesUrl = `${dbUrl.replace(/\/$/, '')}/env-sync/projects/${this.activeProjectName}/files.json`;
            try {
                const responseData = await httpGetJson(filesUrl);
                if (!responseData || typeof responseData !== 'object') {
                    return [new TreeItem('No synced env files found', vscode.TreeItemCollapsibleState.None)];
                }

                const items: TreeItem[] = [];
                for (const key in responseData) {
                    const fileInfo = responseData[key];
                    if (fileInfo && fileInfo.path) {
                        items.push(new FileItem(fileInfo.path, key, this.activeProjectName));
                    }
                }
                return items;
            } catch (err: any) {
                return [new TreeItem(`Error loading files: ${err.message}`, vscode.TreeItemCollapsibleState.None)];
            }
        } else if (element instanceof FileItem) {
            // Child elements: History records for the file
            const historyUrl = `${dbUrl.replace(/\/$/, '')}/env-sync/projects/${this.activeProjectName}/history/${element.fileKey}.json`;
            try {
                const responseData = await httpGetJson(historyUrl);
                if (!responseData || typeof responseData !== 'object') {
                    return [new TreeItem('No history records', vscode.TreeItemCollapsibleState.None)];
                }

                const items: HistoryItem[] = [];
                for (const pushKey in responseData) {
                    const record = responseData[pushKey];
                    if (record) {
                        items.push(new HistoryItem(
                            record.updatedAt,
                            record.updatedBy,
                            element.fileKey,
                            pushKey,
                            element.relativePath,
                            this.activeProjectName,
                            this.activeWorkspaceRoot
                        ));
                    }
                }
                // Sort by timestamp descending
                items.sort((a, b) => b.timestamp - a.timestamp);
                return items;
            } catch (err: any) {
                return [new TreeItem(`Error: ${err.message}`, vscode.TreeItemCollapsibleState.None)];
            }
        }

        return [];
    }
}

class TreeItem extends vscode.TreeItem {}

class FileItem extends TreeItem {
    constructor(
        public readonly relativePath: string,
        public readonly fileKey: string,
        public readonly projectName: string
    ) {
        super(relativePath, vscode.TreeItemCollapsibleState.Collapsed);
        this.iconPath = new vscode.ThemeIcon('file-code');
        this.contextValue = 'fileItem';
    }
}

class HistoryItem extends TreeItem {
    constructor(
        public readonly timestamp: number,
        public readonly updatedBy: string,
        public readonly fileKey: string,
        public readonly pushKey: string,
        public readonly relativePath: string,
        public readonly projectName: string,
        public readonly workspaceRoot: string
    ) {
        const timeStr = new Date(timestamp).toLocaleString();
        const shortAuthor = updatedBy.split(' ')[0];
        super(`${timeStr} - ${shortAuthor}`, vscode.TreeItemCollapsibleState.None);

        this.description = updatedBy.includes('(') ? updatedBy.substring(updatedBy.indexOf('(')) : '';
        this.iconPath = new vscode.ThemeIcon('history');
        this.tooltip = `Modified by: ${updatedBy}\nTime: ${timeStr}`;

        // Uris for comparing the version
        const historyUri = vscode.Uri.parse(`env-sync-history://${projectName}/${fileKey}/${pushKey}`);
        const localUri = vscode.Uri.file(path.join(workspaceRoot, relativePath));

        this.command = {
            command: 'vscode.diff',
            title: 'Compare with local',
            arguments: [
                historyUri, // Left pane (historical version)
                localUri,    // Right pane (local current file)
                `${relativePath} (Database Version) ↔ (Local)`
            ]
        };
    }
}

/**
 * Standard HTTPS GET utility that handles HTTP redirects automatically.
 */
function httpGetJson(urlStr: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const fetchUrl = (currentUrl: string) => {
            const parsedUrl = new URL(currentUrl);
            const options = {
                hostname: parsedUrl.hostname,
                path: parsedUrl.pathname + parsedUrl.search,
                method: 'GET',
                headers: {
                    'Accept': 'application/json'
                }
            };

            const req = https.request(options, (res) => {
                // Follow HTTP Redirects (such as 307 Temporary Redirects)
                if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    fetchUrl(res.headers.location);
                    return;
                }

                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            resolve(JSON.parse(body));
                        } catch (e) {
                            resolve(null);
                        }
                    } else {
                        reject(new Error(`HTTP ${res.statusCode} at ${currentUrl}`));
                    }
                });
            });
            req.on('error', reject);
            req.end();
        };

        fetchUrl(urlStr);
    });
}
