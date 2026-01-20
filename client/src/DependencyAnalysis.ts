import { mkdir, writeFile, readFile } from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import * as fs from 'fs';
import { Log } from './Log';
import { LogLevel } from './ViperProtocol';
import { State } from './ExtensionState';
import { Helper } from './Helper';
import { Color } from './StatusBar';
import { TaskType, Task } from './VerificationController';

const selectedDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: '#00fffb30',
    isWholeLine: true
});

const directDependencyDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: '#bfff0030',
    isWholeLine: true
});

const indirectDependencyDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: '#2b3312',
    isWholeLine: true
});

const directDependantDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: '#ffdd0030',
    isWholeLine: true
});

const indirectDependantDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: '#332f12',
    isWholeLine: true
});

interface GraphNode {
    data: {
        id: string;
        lineNumber: number;
        lineType: string;
        assignmentVariable: string;
        nodeCategories: string[];
        content?: string;
    };
}

interface GraphEdge {
    data: {
        id: string;
        source: string;
        target: string;
    };
}

interface GraphData {
    nodes: GraphNode[];
    edges: GraphEdge[];
}

export class DependencyAnalysis {
    private static currentPanel: vscode.WebviewPanel | undefined = undefined;
    private static selectionChangeListener: vscode.Disposable | undefined = undefined;
    private static documentChangeListener: vscode.Disposable | undefined = undefined;
    private static fileChangeListener: vscode.Disposable | undefined = undefined;
    private static highlightsEnabled: boolean = false;
    private static analyzedFileUri: vscode.Uri | undefined = undefined;
    private static isUpdatingHighlights: boolean = false;   // Prevents selection change loops when changing state

    private static getExportDir(fileUri: vscode.Uri): string {
        const workspaceFolder = vscode.workspace.workspaceFolders 
            ? vscode.workspace.workspaceFolders[0].uri.fsPath 
            : path.dirname(fileUri.fsPath);
        return path.join(workspaceFolder, 'graphExports', 'joined');
    }
    
    public static async performDependencyAnalysis(fileUri: vscode.Uri): Promise<void> {
        try {
            Log.log(`Starting dependency analysis for ${path.basename(fileUri.fsPath)}`, LogLevel.Info);
            
            const exportDir = await this.exportLinesToCSV(fileUri);
            await this.translateEdgesToLineNumbers(exportDir);
            
            // Ensure the opened file is open in the code view before showing the graph (that is, does not replace previously opened graph view)
            const document = await vscode.workspace.openTextDocument(fileUri);
            await vscode.window.showTextDocument(document, vscode.ViewColumn.One, false);
            
            await this.showDependencyGraph(fileUri, exportDir);
            
            // Store the analyzed file and re-enable highlights after successful analysis
            this.analyzedFileUri = fileUri;
            this.highlightsEnabled = true;
            
            Log.log(`Dependency analysis completed for ${path.basename(fileUri.fsPath)}`, LogLevel.Info);
        } catch (error) {
            Log.error(`Failed to perform dependency analysis: ${error}`);
            vscode.window.showErrorMessage(`Dependency analysis failed: ${error}`);
        }
    }

    /*
    Generate graphExports/lines.csv file with the following format:
    lineNumber,"lineText"
    */
    private static async exportLinesToCSV(fileUri: vscode.Uri): Promise<string> {
        // Get file content
        const fileContent = await readFile(fileUri.fsPath, 'utf-8');
        const lines = fileContent.split('\n');

        // Create graphExports/joined/ directory if it does not exist
        const exportDir = this.getExportDir(fileUri);
        await mkdir(exportDir, { recursive: true });

        const csvLines = lines.map((line, index) => {
            const escapedLine = line.trim().replace(/"/g, '""');
            return `${index + 1},"${escapedLine}"`;
        });
        const csvContent = csvLines.join('\n');

        const csvPath = path.join(exportDir, 'lines.csv');
        await writeFile(csvPath, csvContent, 'utf-8');
        Log.log(`Exported ${lines.length} lines to ${csvPath}`, LogLevel.Debug);
        
        return exportDir;
    }

    /*
    Generate graphExports/edges_translated.csv file with the following format:
    sourceLineNumber, targetLineNumber, dependencyLabel
    */
    private static async translateEdgesToLineNumbers(exportDir: string): Promise<void> {
        try {
            const nodesPath = path.join(exportDir, 'nodes.csv');
            const edgesPath = path.join(exportDir, 'edges.csv');

            const nodesContent = await readFile(nodesPath, 'utf-8').catch(() => null);
            const edgesContent = await readFile(edgesPath, 'utf-8').catch(() => null);

            if (!nodesContent || !edgesContent) {
                Log.log('Nodes or edges CSV not found, skipping translation', LogLevel.Debug);
                return;
            }

            // Node ID to line number mapping
            const nodeToLine = new Map<string, number>();
            const nodeLines = nodesContent.split('\n').slice(1); // Skip header
            
            for (const line of nodeLines) {
                if (!line.trim()) continue;
                
                const parts = line.split('#');
                if (parts.length < 6) continue;
                
                const nodeId = parts[0].trim();
                const position = parts[5].trim();
                
                // Extract line number from position (e.g., "file.vpr @ line 4")
                const lineMatch = position.match(/line (\d+)/);
                if (lineMatch) {
                    const lineNumber = parseInt(lineMatch[1], 10);
                    nodeToLine.set(nodeId, lineNumber);
                }
            }

            // Parse edges.csv for translation and remove duplicates
            const edgeLines = edgesContent.split('\n');
            const header = edgeLines[0];
            const translatedEdges = [header];
            const seenEdges = new Set<string>(); // Track unique edges

            for (let i = 1; i < edgeLines.length; i++) {
                const line = edgeLines[i].trim();
                if (!line) continue;

                const parts = line.split(',');
                if (parts.length < 3) continue;

                const sourceId = parts[0].trim();
                const targetId = parts[1].trim();
                const label = parts[2].trim();

                const sourceLine = nodeToLine.get(sourceId);
                const targetLine = nodeToLine.get(targetId);

                // Only include edges where both nodes have line numbers and it's not a self-edge
                if (sourceLine !== undefined && targetLine !== undefined && sourceLine !== targetLine) {
                    // Create unique key for this edge
                    const edgeKey = `${sourceLine},${targetLine},${label}`;
                    
                    // Only add if we haven't seen this exact edge before
                    if (!seenEdges.has(edgeKey)) {
                        seenEdges.add(edgeKey);
                        translatedEdges.push(edgeKey);
                    }
                }
            }

            const translatedPath = path.join(exportDir, 'edges_translated.csv');
            await writeFile(translatedPath, translatedEdges.join('\n'), 'utf-8');

            Log.log(`Translated ${translatedEdges.length - 1} edges to line numbers at ${translatedPath}`, LogLevel.Debug);
        } catch (error) {
            Log.error(`Failed to translate edges to line numbers: ${error}`);
        }
    }

    public static async showDependencyGraph(fileUri: vscode.Uri, exportDir?: string): Promise<void> {
        try {
            // Get export directory if not provided
            if (!exportDir) {
                exportDir = this.getExportDir(fileUri);
            }

            // Check if translated edges file exists
            const translatedEdgesPath = path.join(exportDir, 'edges_translated.csv');
            if (!fs.existsSync(translatedEdgesPath)) {
                Log.log('Translated edges CSV not found, cannot display graph', LogLevel.Info);
                vscode.window.showInformationMessage('Dependency graph data not available. Please verify the file first.');
                return;
            }

            // Create or reuse webview panel
            if (this.currentPanel) {
                this.currentPanel.reveal(vscode.ViewColumn.Two);
            } else {
                this.currentPanel = vscode.window.createWebviewPanel(
                    'dependencyGraph',
                    'Dependency Graph',
                    vscode.ViewColumn.Two,
                    {
                        enableScripts: true,
                        retainContextWhenHidden: true
                    }
                );

                // Clean up when panel is closed
                this.currentPanel.onDidDispose(() => {
                    this.clearHighlights();
                    this.currentPanel = undefined;
                    this.highlightsEnabled = false;
                    this.analyzedFileUri = undefined;
                    if (this.selectionChangeListener) {
                        this.selectionChangeListener.dispose();
                        this.selectionChangeListener = undefined;
                    }
                    if (this.documentChangeListener) {
                        this.documentChangeListener.dispose();
                        this.documentChangeListener = undefined;
                    }
                    if (this.fileChangeListener) {
                        this.fileChangeListener.dispose();
                        this.fileChangeListener = undefined;
                    }
                });
            }

            // Load graph data from translated edges CSV
            const graphData = this.loadGraphFromCSV(translatedEdgesPath);
            this.currentPanel.webview.html = this.getWebviewContent(graphData);

            // Handle messages from webview
            this.currentPanel.webview.onDidReceiveMessage(
                message => {
                    Log.log(`Received message from webview: ${JSON.stringify(message)}`, LogLevel.LowLevelDebug);
                    switch (message.command) {
                        case 'highlightLines':
                            // User clicked a node in the graph - don't focus/scroll the editor
                            if (!this.highlightsEnabled) {
                                return;
                            }
                            this.highlightLines(
                                message.lineNumber, 
                                message.neighbors,
                                message.indirectNeighbors,
                                message.showDependents
                            );
                            return;
                    }
                }
            );

            // Clear previous listener
            if (this.selectionChangeListener) {
                this.selectionChangeListener.dispose();
            }
            
            this.selectionChangeListener = vscode.window.onDidChangeTextEditorSelection(event => {
                if (!this.currentPanel || !this.highlightsEnabled) {
                    return;
                }
                
                // Skip if highlights are being updated
                if (this.isUpdatingHighlights) {
                    return;
                }

                const editor = event.textEditor;
                
                // Only highlight if we're viewing the analyzed file
                if (!this.analyzedFileUri || editor.document.uri.fsPath !== this.analyzedFileUri.fsPath) {
                    return;
                }
                
                const selection = editor.selection;
                
                // Get the line number (1-indexed)
                const lineNumber = selection.active.line + 1;
                
                Log.log(`Selection changed to line ${lineNumber}`, LogLevel.LowLevelDebug);
                
                // Send message to webview (graph view) to highlight node and calculate dependencies
                // The webview will calculate dependencies using Cytoscape and send them back
                // via 'highLightLines' message for code highlighting
                this.currentPanel.webview.postMessage({
                    command: 'highlightLines',
                    lineNumber: lineNumber
                });
            });

            if (this.documentChangeListener) {
                this.documentChangeListener.dispose();
            }

            this.documentChangeListener = vscode.workspace.onDidChangeTextDocument(event => {
                if (!this.currentPanel) {
                    return;
                }

                const editor = vscode.window.activeTextEditor;
                // Only clear if the changed document is the analyzed file
                if (editor && event.document === editor.document && 
                    this.analyzedFileUri && event.document.uri.fsPath === this.analyzedFileUri.fsPath) {
                    this.clearHighlights();
                    this.highlightsEnabled = false;
                }
            });

            if (this.fileChangeListener) {
                this.fileChangeListener.dispose();
            }

            // Clear highlights when switching to a different file
            this.fileChangeListener = vscode.window.onDidChangeActiveTextEditor(editor => {
                if (!this.currentPanel) {
                    return;
                }

                // Only clear if switching to a different file (not when focusing webview or same file)
                if (editor && this.analyzedFileUri && editor.document.uri.fsPath !== this.analyzedFileUri.fsPath) {
                    this.clearHighlights();
                }
            });

            Log.log('Dependency graph view opened successfully', LogLevel.Info);
        } catch (error) {
            Log.error(`Failed to show dependency graph: ${error}`);
            vscode.window.showErrorMessage(`Failed to open dependency graph: ${error}`);
        }
    }

    public static registerCommands(context: vscode.ExtensionContext): void {
        context.subscriptions.push(selectedDecoration, directDependencyDecoration, indirectDependencyDecoration,
            directDependantDecoration, indirectDependantDecoration);

        const showGraphCommand = vscode.commands.registerCommand('viper.showDependencyGraph', async () => {
            const activeEditor = vscode.window.activeTextEditor;
            if (!activeEditor) {
                vscode.window.showWarningMessage('No active file found.');
                return;
            }

            await this.showDependencyGraph(activeEditor.document.uri);
        });

        const toggleCommand = vscode.commands.registerCommand('viper.toggleDependencyAnalysis', () => {
            this.toggleDependencyAnalysis();
        });

        context.subscriptions.push(showGraphCommand, toggleCommand);
    }

    public static toggleDependencyAnalysis(): void {
        const newDependencyAnalysisEnabled = !State.dependencyAnalysis;
        
        if (newDependencyAnalysisEnabled && !State.activeBackend) {
            vscode.window.showWarningMessage("No backend is active yet. Please wait for backend initialization.");
            return;
        }

        if (newDependencyAnalysisEnabled && State.activeBackend && State.activeBackend.type.toLowerCase() !== "silicon") {
            vscode.window.showWarningMessage(
                "Dependency Analysis can only be enabled with the Silicon backend. Current backend: " + State.activeBackend.name,
                "Switch to Silicon"
            ).then(selection => {
                if (selection === "Switch to Silicon") {
                    State.dependencyAnalysis = true;
                    vscode.commands.executeCommand('viper.selectBackend', 'silicon');
                }
            });
            return;
        }
        
        State.dependencyAnalysis = newDependencyAnalysisEnabled;
        State.statusBarItem.update("Dependency Analysis is " + (State.dependencyAnalysis ? "on" : "off"), Color.SUCCESS);
        Log.log("Dependency Analysis " + (State.dependencyAnalysis ? "enabled" : "disabled"), LogLevel.Info);
        
        // Trigger reverification when dependency analysis is enabled
        if (newDependencyAnalysisEnabled) {
            const fileUri = Helper.getActiveFileUri();
            if (fileUri && Helper.isViperSourceFile(fileUri)) {
                Log.log("Dependency Analysis enabled - triggering reverification", LogLevel.Info);
                State.addToWorklist(new Task({ type: TaskType.Verify, uri: fileUri, manuallyTriggered: true }));
            }
        } else {
            // Close the dependency graph panel when dependency analysis is disabled
            if (this.currentPanel) {
                this.currentPanel.dispose();
            }
        }
    }

    private static loadGraphFromCSV(csvPath: string): GraphData {
        if (!fs.existsSync(csvPath)) {
            return { nodes: [], edges: [] };
        }

        const exportDir = path.dirname(csvPath);

        const linesPath = path.join(exportDir, 'lines.csv');
        const lineContents = new Map<number, string>();
        
        if (fs.existsSync(linesPath)) {
            const linesContent = fs.readFileSync(linesPath, 'utf-8');
            const linesLines = linesContent.trim().split('\n');
            
            for (const line of linesLines) {
                const match = line.match(/^(\d+),"(.*)"/);
                if (match) {
                    const lineNum = parseInt(match[1]);
                    const content = match[2].replace(/""/g, '"'); // Unescape double quotes
                    lineContents.set(lineNum, content);
                }
            }
        }

        // Load node categories from nodes.csv
        const nodesPath = path.join(exportDir, 'nodes.csv');
        const nodeCategories = new Map<number, string[]>();
        
        if (fs.existsSync(nodesPath)) {
            const nodesContent = fs.readFileSync(nodesPath, 'utf-8');
            const nodesLines = nodesContent.trim().split('\n').slice(1); // Skip header
            
            for (const line of nodesLines) {
                if (!line.trim()) continue;
                
                const parts = line.split('#');
                if (parts.length < 6) continue;
                
                const nodeId = parts[0].trim();
                const nodeType = parts[1].trim();
                const assumptionType = parts[2].trim();
                const position = parts[5].trim();
                
                // Extract line number from position (e.g., "file.vpr @ line 4")
                const lineMatch = position.match(/line (\d+)/);
                if (lineMatch) {
                    const lineNumber = parseInt(lineMatch[1], 10);
                    const categories = this.getNodeCategories(nodeType, assumptionType);
                    
                    // Merge categories if line already exists
                    if (nodeCategories.has(lineNumber)) {
                        const existing = nodeCategories.get(lineNumber)!;
                        const merged = Array.from(new Set([...existing, ...categories]));
                        nodeCategories.set(lineNumber, merged);
                    } else {
                        nodeCategories.set(lineNumber, categories);
                    }
                }
            }
        }

        // Load edges from edges_translated.csv
        const csvContent = fs.readFileSync(csvPath, 'utf-8');
        const lines = csvContent.trim().split('\n');
        
        const nodes = new Set<number>();
        const edges: Array<{source: number, target: number}> = [];

        // Skip header if present
        const startIndex = lines[0].includes('source') ? 1 : 0;

        for (let i = startIndex; i < lines.length; i++) {
            const parts = lines[i].split(',');
            if (parts.length < 2) continue;
            
            const source = parseInt(parts[0].trim());
            const target = parseInt(parts[1].trim());
            
            if (!isNaN(source) && !isNaN(target)) {
                nodes.add(source);
                nodes.add(target);
                edges.push({ source, target });
            }
        }

        return {
            nodes: Array.from(nodes).map(id => {
                const { lineType, assignmentVariable } = this.getLineType(lineContents.get(id) || '');
                return { 
                    data: { 
                        id: id.toString(), 
                        lineNumber: id,
                        lineType: lineType,
                        assignmentVariable: assignmentVariable,
                        nodeCategories: nodeCategories.get(id) || ['Unknown'],
                        content: lineContents.get(id) || '' 
                    } 
                };
            }),
            edges: edges.map((e, i) => ({ 
                data: { 
                    id: `e${i}`, 
                    source: e.source.toString(), 
                    target: e.target.toString() 
                } 
            }))
        };
    }

    private static getNodeCategories(nodeType: string, assumptionType: string): string[] {
        const categories: string[] = [];
        
        if (nodeType === 'Assumption') {
            if (assumptionType === 'Explicit') {
                categories.push('ExplicitAssumption');
            } else if (assumptionType === 'Internal') {
                categories.push('InternalAssumption');
            } else {
                categories.push('ImplicitAssumption');  // PathCondition, LoopInvariant, Implicit, and all other fine-grained assumption types
            }
        }
        
        if (nodeType === 'Assertion') {
            if (assumptionType === 'Explicit' || assumptionType === 'ImplicitPostcondition' || assumptionType === 'ExplicitPostcondition') {
                categories.push('ExplicitAssertion');
            } else {
                categories.push('ImplicitAssertion');
            }
        }

        if (nodeType === 'Infeasible') {
            categories.push('Infeasible');
        }
        
        return categories.length > 0 ? categories : ['Unknown'];
    }

    private static getLineType(lineContent: string): { lineType: string; assignmentVariable: string } {
        const trimmedLine = lineContent.trim();
        
        if (!trimmedLine) {
            return { lineType: 'other', assignmentVariable: '' };
        }
        
        // Match the first word
        const match = trimmedLine.match(/^\S+/);
        let lineType = match ? match[0] : 'other';
        let assignmentVariable = "";

        if (lineContent.includes(":=")) {
            assignmentVariable = lineType;
            
            if (lineType === 'var') {
                // Include the variable name (second word)
                const secondWordMatch = trimmedLine.match(/^\S+\s+(\S+)/);
                if (secondWordMatch) {
                    let secondWord = secondWordMatch[1];
                    if (secondWord.endsWith(':')) {
                        secondWord = secondWord.slice(0, -1);
                    }
                    assignmentVariable = secondWord;
                }
            }
            if (assignmentVariable.length > 11) {
                assignmentVariable = assignmentVariable.slice(0, 10) + "…";
            }

            lineType = "assignment";
        }

        if (lineType.length > 10) {
            lineType = lineType.slice(0, 9) + "…";
        }
        
        return { lineType, assignmentVariable };
    }

    private static highlightLines(lineNumber: number, neighbors: number[], indirectNeighbors: number[] = [], showDependents: boolean = false): void {
        // Set flag to prevent selection change listener from triggering while updating
        this.isUpdatingHighlights = true;
        
        try {
            // Find the editor for the analyzed file, not just the active editor
            // This is important when the webview panel is focused instead of the text editor
            let editor = vscode.window.activeTextEditor;
            
            // If no active editor or it's not the analyzed file, find the correct editor
            if (!editor || !this.analyzedFileUri || editor.document.uri.fsPath !== this.analyzedFileUri.fsPath) {
                // Look for an editor with the analyzed file
                editor = vscode.window.visibleTextEditors.find(
                    e => this.analyzedFileUri && e.document.uri.fsPath === this.analyzedFileUri.fsPath
                );
            }
            
            if (!editor) {
                Log.log('No editor found for analyzed file', LogLevel.Debug);
                return;
            }

            Log.log(`Highlighting line ${lineNumber} with neighbors: ${neighbors}, indirect: ${indirectNeighbors}`, LogLevel.LowLevelDebug);

            // Check if line numbers are valid
            const lineCount = editor.document.lineCount;
            if (lineNumber < 0 || lineNumber > lineCount) {
                Log.log(`Invalid line number: ${lineNumber} (document has ${lineCount} lines)`, LogLevel.Debug);
                vscode.window.showWarningMessage(`Line ${lineNumber} is out of range`);
                return;
            }
            
            this.clearEditorDecorations(editor);

            if (lineNumber == 0)
                return;

            const selectedLine = [{ range: editor.document.lineAt(lineNumber - 1).range }];
            const directLines = neighbors
                .filter(n => n >= 1 && n <= lineCount && n !== lineNumber)
                .map(n => ({ 
                    range: editor.document.lineAt(n - 1).range 
                }));
            const indirectLines = indirectNeighbors
                .filter(n => n >= 1 && n <= lineCount && n !== lineNumber)
                .map(n => ({ 
                    range: editor.document.lineAt(n - 1).range 
                }));

            // Choose decorations based on direction mode
            const directDecoration = showDependents ? directDependantDecoration : directDependencyDecoration;
            const indirectDecoration = showDependents ? indirectDependantDecoration : indirectDependencyDecoration;

            // Apply new decorations
            editor.setDecorations(directDecoration, directLines);
            editor.setDecorations(indirectDecoration, indirectLines);
            editor.setDecorations(selectedDecoration, selectedLine);

            // Scroll to the line and focus the editor
            editor.revealRange(editor.document.lineAt(lineNumber - 1).range, vscode.TextEditorRevealType.InCenter);
            
            const modeText = showDependents ? 'dependents' : 'dependencies';
            Log.log(`Successfully highlighted line ${lineNumber}, ${directLines.length} direct ${modeText}, and ${indirectLines.length} indirect ${modeText}`, LogLevel.LowLevelDebug);
        } catch (error) {
            Log.error(`Error highlighting lines: ${error}`);
            vscode.window.showErrorMessage(`Error highlighting lines: ${error}`);
        } finally {
            // Reset flag after a short delay to allow any triggered events to be ignored
            setTimeout(() => {
                this.isUpdatingHighlights = false;
            }, 100);
        }
    }

    private static clearHighlights(): void {
        // Find the editor for the analyzed file, similar to highlightLines()
        let editor = vscode.window.activeTextEditor;
        
        if (!editor || !this.analyzedFileUri || editor.document.uri.fsPath !== this.analyzedFileUri.fsPath) {
            editor = vscode.window.visibleTextEditors.find(
                e => this.analyzedFileUri && e.document.uri.fsPath === this.analyzedFileUri.fsPath
            );
        }
        
        if (editor) {
            // Clear all decoration types
            this.clearEditorDecorations(editor);
            Log.log('Cleared dependency highlights', LogLevel.LowLevelDebug);
        }
    }

    private static clearEditorDecorations(editor: vscode.TextEditor): void {
        editor.setDecorations(directDependencyDecoration, []);
        editor.setDecorations(indirectDependencyDecoration, []);
        editor.setDecorations(directDependantDecoration, []);
        editor.setDecorations(indirectDependantDecoration, []);
        editor.setDecorations(selectedDecoration, []);
    }

    private static getWebviewContent(graphData: GraphData): string {
        const styles = this.getStyles();
        const graphScript = this.getGraphScript(graphData);
        
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Dependency Graph</title>
            <script src="https://unpkg.com/cytoscape@3.26.0/dist/cytoscape.min.js"></script>
            ${styles}
        </head>
        <body>
            <div id="zoom-controls">
                <button id="zoomIn" title="Zoom in">+</button>
                <button id="zoomOut" title="Zoom out">−</button>
                <button id="zoomReset" title="Reset zoom (Fit graph to the canvas)">⊙</button>
            </div>
            <div id="controls">
                <button id="toggleIndirect" title="Toggle indirect dependencies">Show Indirect</button>
                <button id="toggleDirection" title="Switch between dependencies and dependents">Show Dependents</button>
                <button id="filterDropdown" title="Filter node types">⚙ Node Filters ▼</button>
            </div>
            <div id="filterPanel" class="hidden">
                <label>
                    <input type="checkbox" id="filter-ExplicitAssumption" checked>
                    Explicit Assumptions <span class="count">(0)</span>
                </label>
                <label>
                    <input type="checkbox" id="filter-ImplicitAssumption" checked>
                    Implicit Assumptions <span class="count">(0)</span>
                </label>
                <label>
                    <input type="checkbox" id="filter-InternalAssumption" checked>
                    Internal Assumptions <span class="count">(0)</span>
                </label>
                <label>
                    <input type="checkbox" id="filter-ExplicitAssertion" checked>
                    Explicit Assertions <span class="count">(0)</span>
                </label>
                <label>
                    <input type="checkbox" id="filter-ImplicitAssertion" checked>
                    Implicit Assertions <span class="count">(0)</span>
                </label>
                <div class="filter-actions">
                    <button id="deselectAll">Deselect All</button>
                    <button id="selectAll">Select All</button>
                </div>
            </div>
            <div id="cy"></div>
            <div id="tooltip"></div>
            ${graphScript}
        </body>
        </html>`;
    }

    private static getStyles(): string {
        return `<style>
            body {
                margin: 0;
                padding: 0;
                overflow: hidden;
            }
            #cy {
                width: 100%;
                height: 100vh;
                background-color: #1e1e1e;
            }
            #zoom-controls {
                position: absolute;
                top: 10px;
                left: 10px;
                z-index: 1000;
                display: flex;
                flex-direction: column;
                gap: 4px;
            }
            #zoom-controls button {
                background-color: #2d2d30;
                color: #cccccc;
                border: 1px solid #454545;
                border-radius: 4px;
                padding: 8px;
                width: 36px;
                height: 36px;
                font-size: 18px;
                cursor: pointer;
                transition: background-color 0.2s;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            #zoom-controls button:hover {
                background-color: #3e3e42;
            }
            #controls {
                position: absolute;
                top: 10px;
                right: 10px;
                z-index: 1000;
                display: flex;
                gap: 8px;
            }
            #controls button {
                background-color: #2d2d30;
                color: #cccccc;
                border: 1px solid #454545;
                border-radius: 4px;
                padding: 8px 12px;
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                font-size: 12px;
                cursor: pointer;
                transition: background-color 0.2s;
            }
            #controls button:hover {
                background-color: #3e3e42;
            }
            #controls button.active {
                background-color: #0e639c;
                border-color: #007acc;
            }
            #tooltip {
                position: absolute;
                display: none;
                background-color: #2d2d30;
                color: #cccccc;
                border: 1px solid #454545;
                border-radius: 4px;
                padding: 8px 12px;
                font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
                font-size: 12px;
                white-space: pre-wrap;
                word-wrap: break-word;
                max-width: 500px;
                z-index: 1000;
                pointer-events: none;
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
            }
            #tooltip .line-number {
                color: #569cd6;
                font-weight: bold;
                margin-right: 8px;
            }
            #tooltip .line-content {
                color: #d4d4d4;
            }
            #filterPanel {
                position: absolute;
                top: 50px;
                right: 10px;
                background-color: #2d2d30;
                border: 1px solid #454545;
                border-radius: 4px;
                padding: 12px;
                display: flex;
                flex-direction: column;
                gap: 8px;
                width: 225px;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
                z-index: 1001;
                transition: opacity 0.2s, visibility 0.2s;
            }
            #filterPanel.hidden {
                display: none;
            }
            #filterPanel label {
                display: flex;
                align-items: center;
                gap: 8px;
                color: #cccccc;
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                font-size: 12px;
                cursor: pointer;
                padding: 4px;
                border-radius: 3px;
                transition: background-color 0.15s;
            }
            #filterPanel label:hover {
                background-color: #3e3e42;
            }
            #filterPanel input[type="checkbox"] {
                cursor: pointer;
                width: 16px;
                height: 16px;
                margin: 0;
            }
            #filterPanel .count {
                margin-left: auto;
                color: #858585;
                font-size: 11px;
            }
            #filterPanel .filter-actions {
                display: flex;
                gap: 6px;
                margin-top: 4px;
                padding-top: 8px;
                border-top: 1px solid #454545;
            }
            #filterPanel .filter-actions button {
                flex: 1;
                background-color: #3e3e42;
                color: #cccccc;
                border: 1px solid #555555;
                border-radius: 3px;
                padding: 6px 8px;
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                font-size: 11px;
                cursor: pointer;
                transition: background-color 0.15s;
            }
            #filterPanel .filter-actions button:hover {
                background-color: #4e4e52;
            }
        </style>`;
    }

    private static getGraphScript(graphData: GraphData): string {
        const graphDataJson = JSON.stringify(graphData);
        
        return /* javascript */`<script>                                // Tip: install VSC extension 'es6-string-html' to see syntax highlighting for these multi-line strings
            const vscode = acquireVsCodeApi();
            
            // Allow zooming out to 40% and zooming in to 500% of initial zoom level
            const ZOOM_OUT_FACTOR = 0.4;
            const ZOOM_IN_FACTOR = 5.0;
            
            const cy = cytoscape({
                container: document.getElementById('cy'),
                elements: ${graphDataJson},
                style: [
                    {
                        selector: 'node',
                        style: {
                            'background-color': '#474747',
                            'background-image': function(element) {
                                const lineNum = element.data('lineNumber');
                                const lineType = element.data('lineType');
                                const assignmentVariable = element.data('assignmentVariable');
                                
                                let svg;
                                if (assignmentVariable === '') {
                                    svg = '<svg width="80" height="80" xmlns="http://www.w3.org/2000/svg">' +
                                          '<text x="40" y="35" text-anchor="middle" font-size="16" fill="white" font-family="Arial, sans-serif">' + lineNum + '</text>' +
                                          '<text x="40" y="52" text-anchor="middle" font-size="12" fill="white" font-family="Arial, sans-serif">' + lineType + '</text>' +
                                          '</svg>';
                                } else {
                                    svg = '<svg width="80" height="80" xmlns="http://www.w3.org/2000/svg">' +
                                          '<text x="40" y="26" text-anchor="middle" font-size="16" fill="white" font-family="Arial, sans-serif">' + lineNum + '</text>' +
                                          '<text x="40" y="43" text-anchor="middle" font-size="12" fill="white" font-family="Arial, sans-serif">' + lineType + '</text>' +
                                          '<text x="40" y="58" text-anchor="middle" font-size="10" fill="white" font-style="italic" font-family="Consolas, Monaco, Courier New, monospace">' + assignmentVariable + '</text>' +
                                          '</svg>';
                                }
                                
                                return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
                            },
                            'background-fit': 'contain',
                            'background-clip': 'none',
                            'width': 50,
                            'height': 50
                        }
                    },
                    {
                        selector: 'edge',
                        style: {
                            'width': 2,
                            'line-color': '#505050',
                            'target-arrow-color': '#505050',
                            'target-arrow-shape': 'triangle',
                            'curve-style': 'bezier'
                        }
                    },
                    {
                        selector: '.direct',
                        style: {
                            'background-color': '#505f21',
                            'width': 55,
                            'height': 55
                        }
                    },
                    {
                        selector: '.indirect',
                        style: {
                            'background-color': '#2d3312',
                            'width': 52,
                            'height': 52
                        }
                    },
                    {
                        selector: '.direct-dependent',
                        style: {
                            'background-color': '#5f5721',
                            'width': 55,
                            'height': 55
                        }
                    },
                    {
                        selector: '.indirect-dependent',
                        style: {
                            'background-color': '#332f12',
                            'width': 52,
                            'height': 52
                        }
                    },
                    {
                        selector: '.selected',
                        style: {
                            'background-color': '#2b7372',
                            'width': 60,
                            'height': 60
                        }
                    },
                    {
                        selector: '.dimmed',
                        style: {
                            'opacity': 0.3
                        }
                    },
                    {
                        selector: '.filtered',
                        style: {
                            'background-color': '#4e4e4e',
                            'opacity': 0.8
                        }
                    }
                ],
                layout: ${this.getGraphLayout()},
                wheelSensitivity: 0.2,
                minZoom: ZOOM_OUT_FACTOR,
                maxZoom: ZOOM_IN_FACTOR
            });

            // Track whether indirect dependencies are shown
            let showIndirect = false;
            
            // Track direction: false = dependencies (incoming), true = dependents (outgoing)
            let showDependents = false;
            
            // Track the currently selected node for toggle button recalculation
            let selectedNode = null;
            
            // Update zoom limits after layout settles
            cy.one('layoutstop', function() {
                const initialZoom = cy.zoom();
                cy.minZoom(initialZoom * ZOOM_OUT_FACTOR);
                cy.maxZoom(initialZoom * ZOOM_IN_FACTOR);
            });


            // Shared function to highlight a node and its dependencies/dependents
            function highlightNodeAndDependencies(node, sendMessage = true) {
                if (!node || node.length === 0) return;
                
                const lineNumber = parseInt(node.id());
                
                // Clear previous highlights and dimming
                cy.elements().removeClass('selected direct indirect direct-dependent indirect-dependent dimmed filtered');
                
                // Get related nodes based on direction and mode
                let related, directRelated;
                if (showDependents) {
                    // Dependents mode: show outgoing edges
                    if (showIndirect) {
                        related = node.successors();
                        directRelated = node.outgoers();
                    } else {
                        related = node.outgoers();
                        directRelated = related;
                    }
                } else {
                    // Dependencies mode: show incoming edges
                    if (showIndirect) {
                        related = node.predecessors();
                        directRelated = node.incomers();
                    } else {
                        related = node.incomers();
                        directRelated = related;
                    }
                }
                
                // Get connected elements (node, related nodes, and edges between them)
                const connectedElements = node.union(related);
                
                // Dim all elements first
                cy.elements().addClass('dimmed');
                
                // Remove dimming from connected elements (includes edges automatically)
                connectedElements.removeClass('dimmed');
                
                // Choose CSS classes based on direction mode
                const indirectClass = showDependents ? 'indirect-dependent' : 'indirect';
                const directClass = showDependents ? 'direct-dependent' : 'direct';
                
                // Highlight indirect nodes (if in indirect mode)
                if (showIndirect) {
                    const indirectNodes = related.nodes().difference(directRelated.nodes());
                    indirectNodes.addClass(indirectClass);
                }

                // Highlight direct related nodes
                directRelated.nodes().addClass(directClass);

                node.addClass('selected');
                
                // Apply filters AFTER highlight classes are set
                applyFilters();
                
                // Send message to extension for code highlighting
                if (sendMessage) {
                    // Only include nodes that are not filtered
                    const directNeighbors = directRelated.nodes()
                        .filter(n => !n.hasClass('filtered'))
                        .map(n => parseInt(n.id()));
                    const indirectNeighbors = showIndirect 
                        ? related.nodes()
                            .difference(directRelated.nodes())
                            .filter(n => !n.hasClass('filtered'))
                            .map(n => parseInt(n.id()))
                        : [];
                    
                    vscode.postMessage({
                        command: 'highlightLines',
                        lineNumber: lineNumber,
                        neighbors: directNeighbors,
                        indirectNeighbors: indirectNeighbors,
                        showDependents: showDependents
                    });
                }
            }

            ${this.getZoomButtonHandlers()}
            ${this.getFilterDropdownHandler()}
            ${this.getFilterLogicHandler()}
            ${this.getDirectionToggleHandler()}
            ${this.getToggleButtonHandler()}
            ${this.getTooltipHandlers()}
            ${this.getNodeClickHandler()}
            ${this.getMessageHandler()}
        </script>`;
    }

    private static getGraphLayout(): string {
        return JSON.stringify({
            name: 'cose',
            animate: true,
            idealEdgeLength: 100,
            nodeOverlap: 20
        });
    }

    private static getZoomButtonHandlers(): string {
        return /* javascript */`
            const zoomInBtn = document.getElementById('zoomIn');
            const zoomOutBtn = document.getElementById('zoomOut');
            const zoomResetBtn = document.getElementById('zoomReset');
            
            zoomInBtn.addEventListener('click', function() {
                const extent = cy.extent();
                const centerX = (extent.x1 + extent.x2) / 2;
                const centerY = (extent.y1 + extent.y2) / 2;
                const newZoom = Math.min(cy.zoom() * (1.0 / 0.7), cy.maxZoom());
                cy.zoom({
                    level: newZoom,
                    position: { x: centerX, y: centerY }
                });
            });
            
            zoomOutBtn.addEventListener('click', function() {
                const extent = cy.extent();
                const centerX = (extent.x1 + extent.x2) / 2;
                const centerY = (extent.y1 + extent.y2) / 2;
                const newZoom = Math.max(cy.zoom() * 0.7, cy.minZoom());
                cy.zoom({
                    level: newZoom,
                    position: { x: centerX, y: centerY }
                });
            });
            
            zoomResetBtn.addEventListener('click', function() {
                cy.fit();
            });`;
    }

    private static getFilterDropdownHandler(): string {
        return /* javascript */`
            const filterDropdownBtn = document.getElementById('filterDropdown');
            const filterPanel = document.getElementById('filterPanel');
            
            // Toggle filter panel visibility
            filterDropdownBtn.addEventListener('click', function() {
                filterPanel.classList.toggle('hidden');
                this.classList.toggle('active', !filterPanel.classList.contains('hidden'));
            });
            
            // Close panel when clicking outside
            document.addEventListener('click', function(event) {
                const isClickInside = filterDropdownBtn.contains(event.target) || filterPanel.contains(event.target);
                if (!isClickInside && !filterPanel.classList.contains('hidden')) {
                    filterPanel.classList.add('hidden');
                    filterDropdownBtn.classList.remove('active');
                }
            });`;
    }

    private static getFilterLogicHandler(): string {
        return /* javascript */`
            // Track enabled filter categories
            const filterState = {
                'ExplicitAssumption': true,
                'ImplicitAssumption': true,
                'InternalAssumption': true,
                'ExplicitAssertion': true,
                'ImplicitAssertion': true
            };
            
            // Calculate node counts for each category
            const categoryCounts = {
                'ExplicitAssumption': 0,
                'ImplicitAssumption': 0,
                'InternalAssumption': 0,
                'ExplicitAssertion': 0,
                'ImplicitAssertion': 0
            };
            
            cy.nodes().forEach(function(node) {
                const categories = node.data('nodeCategories') || [];
                categories.forEach(function(category) {
                    if (categoryCounts[category] !== undefined) {
                        categoryCounts[category]++;
                    }
                });
            });
            
            // Update count displays
            document.querySelector('#filter-ExplicitAssumption + .count').textContent = '(' + categoryCounts.ExplicitAssumption + ')';
            document.querySelector('#filter-ImplicitAssumption + .count').textContent = '(' + categoryCounts.ImplicitAssumption + ')';
            document.querySelector('#filter-InternalAssumption + .count').textContent = '(' + categoryCounts.InternalAssumption + ')';
            document.querySelector('#filter-ExplicitAssertion + .count').textContent = '(' + categoryCounts.ExplicitAssertion + ')';
            document.querySelector('#filter-ImplicitAssertion + .count').textContent = '(' + categoryCounts.ImplicitAssertion + ')';
            
            // Function to apply filters to nodes
            function applyFilters() {
                cy.nodes().forEach(function(node) {
                    const categories = node.data('nodeCategories') || [];
                    
                    // Only apply filtering to direct/indirect dependency nodes
                    const isHighlightedDependency = node.hasClass('direct') || 
                                                     node.hasClass('indirect') ||
                                                     node.hasClass('direct-dependent') ||
                                                     node.hasClass('indirect-dependent');
                    
                    if (!isHighlightedDependency || node.hasClass('selected')) {
                        // Skip nodes that are not highlighted dependencies
                        return;
                    }
                    
                    // Node is visible if ANY of its categories are enabled
                    const isVisible = categories.some(function(category) {
                        return filterState[category] === true;
                    });
                    
                    if (isVisible) {
                        node.removeClass('filtered');
                    } else {
                        node.addClass('filtered');
                    }
                });
            }
            
            // Add event listeners to checkboxes
            const checkboxes = ['ExplicitAssumption', 'ImplicitAssumption', 'InternalAssumption', 'ExplicitAssertion', 'ImplicitAssertion'];
            checkboxes.forEach(function(category) {
                const checkbox = document.getElementById('filter-' + category);
                checkbox.addEventListener('change', function() {
                    filterState[category] = this.checked;
                    applyFilters();
                    // Re-highlight current node to update code view with filtered nodes
                    if (selectedNode && selectedNode.length > 0) {
                        highlightNodeAndDependencies(selectedNode, true);
                    }
                });
            });
            
            // Helper function to set all checkboxes
            function setAllCheckboxes(checked) {
                checkboxes.forEach(function(category) {
                    filterState[category] = checked;
                    document.getElementById('filter-' + category).checked = checked;
                });
                applyFilters();
                // Re-highlight current node to update code view with filtered nodes
                if (selectedNode && selectedNode.length > 0) {
                    highlightNodeAndDependencies(selectedNode, true);
                }
            }
            
            // Select All button
            document.getElementById('selectAll').addEventListener('click', function() {
                setAllCheckboxes(true);
            });
            
            // Deselect All button
            document.getElementById('deselectAll').addEventListener('click', function() {
                setAllCheckboxes(false);
            });`;
    }

    private static getDirectionToggleHandler(): string {
        return /* javascript */`const toggleDirectionBtn = document.getElementById('toggleDirection');
            
            toggleDirectionBtn.addEventListener('click', function() {
                showDependents = !showDependents;
                this.classList.toggle('active', showDependents);
                this.textContent = showDependents ? 'Show Dependencies' : 'Show Dependents';
                
                // Recalculate and highlight for the currently selected node
                if (selectedNode && selectedNode.length > 0) {
                    highlightNodeAndDependencies(selectedNode, true);
                } else {
                    // Just clear highlights if no node is selected
                    cy.elements().removeClass('selected direct indirect dimmed');
                }
            });`;
    }

    private static getToggleButtonHandler(): string {
        return /* javascript */`const toggleBtn = document.getElementById('toggleIndirect');
            
            toggleBtn.addEventListener('click', function() {
                showIndirect = !showIndirect;
                this.classList.toggle('active', showIndirect);
                this.textContent = showIndirect ? 'Hide Indirect' : 'Show Indirect';
                
                // Recalculate and highlight dependencies for the currently selected node
                if (selectedNode && selectedNode.length > 0) {
                    highlightNodeAndDependencies(selectedNode, true);
                } else {
                    // Just clear highlights if no node is selected
                    cy.elements().removeClass('selected direct indirect dimmed');
                }
            });`;
    }

    private static getTooltipHandlers(): string {
        return /* javascript */`const tooltip = document.getElementById('tooltip');
            
            cy.on('mouseover', 'node', function(evt) {
                const node = evt.target;
                const lineNumber = node.id();
                const content = node.data('content') || '';
                
                if (content) {
                    tooltip.innerHTML = '<span class="line-number">Line ' + lineNumber + ':</span>' +
                                       '<span class="line-content">' + escapeHtml(content) + '</span>';
                    tooltip.style.display = 'block';
                }
            });
            
            cy.on('mousemove', 'node', function(evt) {
                tooltip.style.left = (evt.originalEvent.pageX + 15) + 'px';
                tooltip.style.top = (evt.originalEvent.pageY + 15) + 'px';
            });
            
            cy.on('mouseout', 'node', function(evt) {
                tooltip.style.display = 'none';
            });
            
            function escapeHtml(text) {
                const div = document.createElement('div');
                div.textContent = text;
                return div.innerHTML;
            }`;
    }

    private static getNodeClickHandler(): string {
        return /* javascript */`cy.on('tap', 'node', function(evt) {
                const node = evt.target;
                
                // If clicking the already selected node, clear all highlights
                if (selectedNode && selectedNode.id() === node.id()) {
                    selectedNode = null;
                    cy.elements().removeClass('selected direct indirect direct-dependent indirect-dependent dimmed filtered');
                    
                    // Send message to code view to clear code highlights
                    vscode.postMessage({
                        command: 'highlightLines',
                        lineNumber: 0,
                        neighbors: [],
                        indirectNeighbors: [],
                        showDependents: showDependents
                    });
                } else {
                    // Track the selected node for toggle button recalculation
                    selectedNode = node;
                    
                    // Highlight the node and its dependencies
                    highlightNodeAndDependencies(node, true);
                }
            });`;
    }

    private static getMessageHandler(): string {
        return /* javascript */`// Listen for messages from extension to highlight nodes
            window.addEventListener('message', event => {
                const message = event.data;
                
                switch (message.command) {
                    case 'highlightLines':
                        const nodeId = message.lineNumber.toString();
                        const node = cy.getElementById(nodeId);
                        
                        if (node.length > 0) {
                            // Track the selected node for toggle button recalculation
                            selectedNode = node;
                            
                            // Highlight the node and its dependencies
                            highlightNodeAndDependencies(node, true);
                            
                            // Only center if node is far from the viewport center
                            const extent = cy.extent();
                            const viewportCenter = {
                                x: (extent.x1 + extent.x2) / 2,
                                y: (extent.y1 + extent.y2) / 2
                            };
                            const nodePosition = node.position();
                            const viewportWidth = extent.x2 - extent.x1;
                            const viewportHeight = extent.y2 - extent.y1;
                            
                            // Calculate distance from center as percentage of viewport size
                            const dx = Math.abs(nodePosition.x - viewportCenter.x) / viewportWidth;
                            const dy = Math.abs(nodePosition.y - viewportCenter.y) / viewportHeight;
                            const distanceFromCenter = Math.sqrt(dx * dx + dy * dy);
                            
                            // Only center if node is more than 45% away from center
                            if (distanceFromCenter > 0.45) {
                                cy.center(node);
                            }
                        }
                        break;
                }
            });`;
    }
}
