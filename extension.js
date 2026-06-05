// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    const disposable = vscode.commands.registerCommand('opncreator.create', function () {
        OpnCreatorPanel.createOrShow(context);
    });
    context.subscriptions.push(disposable);
}

function deactivate() {}

// ─── Webview Panel ────────────────────────────────────────────────────────────

class OpnCreatorPanel {
    /** @type {OpnCreatorPanel | undefined} */
    static currentPanel;

    /** @param {vscode.ExtensionContext} context */
    static createOrShow(context) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (OpnCreatorPanel.currentPanel) {
            OpnCreatorPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'opnCreator',
            'Operation Code Generation Parameters',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                // Keep the webview alive when switching to another tab so
                // typed parameters are not lost when the panel is hidden.
                retainContextWhenHidden: true,
            }
        );

        OpnCreatorPanel.currentPanel = new OpnCreatorPanel(panel, context);
    }

    /** @param {vscode.WebviewPanel} panel @param {vscode.ExtensionContext} context */
    constructor(panel, context) {
        this._panel = panel;
        this._context = context;
        this._disposables = [];

        this._panel.webview.html = this._getHtmlForWebview();

        // Send project list after panel is ready
        this._panel.webview.onDidReceiveMessage(
            (message) => this._handleMessage(message),
            null,
            this._disposables
        );

        // Send initial data
        setTimeout(() => {
            const projects = getProjectsFromSln();
            const today = getTodayString();
            this._panel.webview.postMessage({ command: 'init', projects, today });
        }, 300);

        this._panel.onDidDispose(() => this._dispose(), null, this._disposables);
    }

    /** @param {any} message */
    async _handleMessage(message) {
        switch (message.command) {
            case 'ok':
                await this._generateOperation(message.data);
                break;
            case 'cancel':
                this._panel.dispose();
                break;
        }
    }

    /** @param {any} data */
    async _generateOperation(data) {
        const workspaceRoot = getWorkspaceRoot();
        if (!workspaceRoot) {
            vscode.window.showErrorMessage('No workspace folder open. Please open H:\\Trunk.');
            return;
        }

        const {
            projectOpn,    // e.g. DCAD_main2015
            projectCmd,    // e.g. DCAD_cmd2015
            opnId,         // e.g. ID_AAAAAAAAAAAAA
            opnName,       // e.g. BooleanEx
            useOpn,
            useOpnDlg,
            useSelectionList,
            useCmd,
            addNewFiles,   // whether to write files to disk and git-stage them
            project,
            taskId,
            author,
            date,
        } = data;

        if (!opnName) {
            vscode.window.showErrorMessage('Operation Name is required.');
            return;
        }

        const opnDir = getProjectFolder(projectOpn);
        const cmdDir = getProjectFolder(projectCmd);

        const createdFiles = [];
        const modifiedFiles = [];
        const errors = [];

        try {
            // ── 1. Create Opn files ──────────────────────────────────────────
            if (useOpn) {
                {
                    const filesToCreate = buildOpnFiles(opnName, opnId, useOpnDlg, useSelectionList, project, taskId, author, date);
                    for (const [filename, content] of Object.entries(filesToCreate)) {
                        const filePath = path.join(opnDir, filename);
                        if (fs.existsSync(filePath)) {
                            errors.push(`File already exists: ${filePath}`);
                            continue;
                        }
                        fs.writeFileSync(filePath, content, 'utf8');
                        createdFiles.push(filePath);
                    }
                }

                // Add to vcxproj (use actual path from sln, not constructed)
                const { vcxprojPath: opnVcxproj, filtersPath: opnFilters } = getProjectVcxprojPath(projectOpn);

                const opnHeaders = [
                    `${opnName}Opn.h`,
                    ...(useOpnDlg ? [`${opnName}OpnDlg.h`] : []),
                    `${opnName}OpnDoc.h`,
                    `${opnName}OpnView.h`,
                ];
                const opnSources = [
                    `${opnName}Opn.cpp`,
                    ...(useOpnDlg ? [`${opnName}OpnDlg.cpp`] : []),
                    `${opnName}OpnDoc.cpp`,
                    `${opnName}OpnView.cpp`,
                ];

                if (fs.existsSync(opnVcxproj)) {
                    insertIntoVcxproj(opnVcxproj, opnHeaders, opnSources);
                    modifiedFiles.push(opnVcxproj);
                }
                if (fs.existsSync(opnFilters)) {
                    insertIntoFilters(opnFilters, opnHeaders, opnSources);
                    modifiedFiles.push(opnFilters);
                }
            }

            // ── 2. Create Cmd files ──────────────────────────────────────────
            if (useCmd) {
                {
                    const cmdFiles = buildCmdFiles(opnName, opnId, project, taskId, author, date);
                    for (const [filename, content] of Object.entries(cmdFiles)) {
                        const filePath = path.join(cmdDir, filename);
                        if (fs.existsSync(filePath)) {
                            errors.push(`File already exists: ${filePath}`);
                            continue;
                        }
                        fs.writeFileSync(filePath, content, 'utf8');
                        createdFiles.push(filePath);
                    }
                }

                // Add to vcxproj (use actual path from sln, not constructed)
                const { vcxprojPath: cmdVcxproj, filtersPath: cmdFilters } = getProjectVcxprojPath(projectCmd);

                const cmdHeaders = [`Cmd${opnName}.h`];
                const cmdSources = [`Cmd${opnName}.cpp`];

                if (fs.existsSync(cmdVcxproj)) {
                    insertIntoVcxproj(cmdVcxproj, cmdHeaders, cmdSources);
                    modifiedFiles.push(cmdVcxproj);
                }
                if (fs.existsSync(cmdFilters)) {
                    insertIntoFilters(cmdFilters, cmdHeaders, cmdSources);
                    modifiedFiles.push(cmdFilters);
                }
            }

            // ── 3. Stage new files (Git first, then SVN) ─────────────────────
            if (addNewFiles && createdFiles.length > 0) {
                const vcs = detectVcs(workspaceRoot);
                if (vcs === 'git') {
                    try {
                        for (const f of createdFiles) {
                            execSync(`git add "${f}"`, { cwd: workspaceRoot, stdio: 'pipe' });
                        }
                    } catch (gitErr) {
                        errors.push(`Git staging warning: ${gitErr.message}`);
                    }
                } else if (vcs === 'svn') {
                    try {
                        for (const f of createdFiles) {
                            execSync(`svn add --parents "${f}"`, { cwd: workspaceRoot, stdio: 'pipe' });
                        }
                    } catch (svnErr) {
                        errors.push(`SVN add warning: ${svnErr.message}`);
                    }
                } else {
                    errors.push('Add new files: no Git or SVN working copy detected; files were created but not added to version control.');
                }
            }

            // ── 4. Show result ───────────────────────────────────────────────
            if (errors.length > 0) {
                vscode.window.showWarningMessage(`OpnCreator: Done with warnings:\n${errors.join('\n')}`);
            } else {
                const msg = [
                    `OpnCreator: Successfully created ${createdFiles.length} file(s) and modified ${modifiedFiles.length} project file(s).`,
                    '',
                    'Created files:',
                    ...createdFiles.map(f => '  ' + f),
                    '',
                    'Modified files:',
                    ...modifiedFiles.map(f => '  ' + f),
                ].join('\n');

                vscode.window.showInformationMessage(
                    `OpnCreator: Created ${createdFiles.length} files, modified ${modifiedFiles.length} project files.`,
                    'Show Details'
                ).then(sel => {
                    if (sel === 'Show Details') {
                        const doc = vscode.workspace.openTextDocument({ content: msg, language: 'plaintext' });
                        doc.then(d => vscode.window.showTextDocument(d));
                    }
                });
            }

            this._panel.dispose();

        } catch (err) {
            vscode.window.showErrorMessage(`OpnCreator error: ${err.message}`);
        }
    }

    _dispose() {
        OpnCreatorPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
    }

    _getHtmlForWebview() {
        return getWebviewHtml();
    }
}

// ─── Helper: get workspace root ───────────────────────────────────────────────

function getWorkspaceRoot() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    return folders[0].uri.fsPath;
}

// ─── Helper: detect version control system ────────────────────────────────────

/**
 * Detect which version control system manages the workspace.
 * Prefers Git; falls back to SVN. Returns 'git' | 'svn' | null.
 * @param {string} workspaceRoot
 */
function detectVcs(workspaceRoot) {
    // Git: prefer the authoritative check, fall back to a .git marker.
    try {
        execSync('git rev-parse --is-inside-work-tree', { cwd: workspaceRoot, stdio: 'pipe' });
        return 'git';
    } catch {
        // not a git working tree
    }
    if (fs.existsSync(path.join(workspaceRoot, '.git'))) {
        return 'git';
    }

    // SVN: prefer `svn info`, fall back to a .svn marker.
    try {
        execSync('svn info', { cwd: workspaceRoot, stdio: 'pipe' });
        return 'svn';
    } catch {
        // not an svn working copy (or svn not installed)
    }
    if (fs.existsSync(path.join(workspaceRoot, '.svn'))) {
        return 'svn';
    }

    return null;
}

// ─── Helper: parse .sln for project names and paths ──────────────────────────

/** @type {{name: string, folder: string, vcxprojPath: string, filtersPath: string}[]} */
let _slnProjectCache = null;

function getSlnProjects() {
    if (_slnProjectCache) return _slnProjectCache;

    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return [];

    const slnPath = path.join(workspaceRoot, 'src', 'DCAD2022.sln');
    if (!fs.existsSync(slnPath)) return [];

    try {
        const content = fs.readFileSync(slnPath, 'utf8');
        // Match: Project("...") = "Name", "RelPath\Name.vcxproj", "{...}"
        const re = /Project\("\{[^}]+\}"\)\s*=\s*"([^"]+)",\s*"([^"]+\.vcxproj)"/g;
        const projects = [];
        let m;
        while ((m = re.exec(content)) !== null) {
            const name = m[1];
            const vcxprojRelPath = m[2].replace(/\\/g, path.sep);
            const vcxprojPath = path.join(workspaceRoot, 'src', vcxprojRelPath);
            const folder = path.dirname(vcxprojPath);
            const filtersPath = vcxprojPath + '.filters';
            if (!projects.find(p => p.name === name)) {
                projects.push({ name, folder, vcxprojPath, filtersPath });
            }
        }
        _slnProjectCache = projects.sort((a, b) => a.name.localeCompare(b.name));
        return _slnProjectCache;
    } catch {
        return [];
    }
}

function getProjectsFromSln() {
    return getSlnProjects().map(p => p.name);
}

/** Get the folder path for a given project name */
function getProjectFolder(projectName) {
    const found = getSlnProjects().find(p => p.name === projectName);
    if (found) return found.folder;
    const workspaceRoot = getWorkspaceRoot();
    const folderName = projectName.replace(/\d{4}$/, '');
    return path.join(workspaceRoot, 'src', folderName);
}

/** Get the actual vcxproj path for a project (from sln, not constructed) */
function getProjectVcxprojPath(projectName) {
    const found = getSlnProjects().find(p => p.name === projectName);
    if (found) return { vcxprojPath: found.vcxprojPath, filtersPath: found.filtersPath };
    // Fallback
    const folder = getProjectFolder(projectName);
    return {
        vcxprojPath: path.join(folder, `${projectName}.vcxproj`),
        filtersPath: path.join(folder, `${projectName}.vcxproj.filters`),
    };
}

// ─── Helper: today's date ─────────────────────────────────────────────────────

function getTodayString() {
    const d = new Date();
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    return `${y}/${mo}/${da}`;
}

// ─── vcxproj/filters insertion ───────────────────────────────────────────────

/**
 * Insert ClInclude and ClCompile entries into a .vcxproj file.
 * Inserts includes before the closing tag of the ClInclude ItemGroup,
 * and sources before the closing tag of the main ClCompile ItemGroup.
 */
function insertIntoVcxproj(filePath, headers, sources) {
    let content = fs.readFileSync(filePath, 'utf8');

    // Insert headers into the ClInclude ItemGroup (the one with the most entries)
    const headerLines = headers.map(h => `    <ClInclude Include="${h}" />`).join('\r\n');
    content = insertBeforeLastClIncludeGroupEnd(content, headerLines);

    // Insert sources into the ClCompile ItemGroup (source files group)
    const sourceLines = sources.map(s => `    <ClCompile Include="${s}" />`).join('\r\n');
    content = insertBeforeLastClCompileGroupEnd(content, sourceLines);

    fs.writeFileSync(filePath, content, 'utf8');
}

/**
 * Find the ItemGroup that contains ClInclude entries and insert before its closing tag.
 */
function insertBeforeLastClIncludeGroupEnd(content, newLines) {
    // Find the position of the last <ClInclude Include= line
    const lastIdx = content.lastIndexOf('<ClInclude Include=');
    if (lastIdx === -1) return content;

    // Find the </ItemGroup> after this position
    const groupEndIdx = content.indexOf('</ItemGroup>', lastIdx);
    if (groupEndIdx === -1) return content;

    // The slice up to </ItemGroup> ends with the indentation of the closing
    // tag (e.g. "\r\n  "). Strip that trailing inline whitespace so the first
    // inserted line keeps only its own indent instead of doubling up.
    const head = content.slice(0, groupEndIdx).replace(/[ \t]+$/, '');
    return head + newLines + '\r\n  ' + content.slice(groupEndIdx);
}

/**
 * Find the ItemGroup that contains ClCompile entries (source files, not project config)
 * and insert before its closing tag.
 * We detect the "source files" group by looking for ClCompile Include entries (not ClCompile with sub-elements).
 */
function insertBeforeLastClCompileGroupEnd(content, newLines) {
    // Find the last occurrence of <ClCompile Include= (the source files group)
    const lastIdx = content.lastIndexOf('<ClCompile Include=');
    if (lastIdx === -1) return content;

    // Find the </ItemGroup> after this position
    const groupEndIdx = content.indexOf('</ItemGroup>', lastIdx);
    if (groupEndIdx === -1) return content;

    // Strip the trailing indentation of the closing tag so the first inserted
    // line does not get doubled-up indentation (see ClInclude helper above).
    const head = content.slice(0, groupEndIdx).replace(/[ \t]+$/, '');
    return head + newLines + '\r\n  ' + content.slice(groupEndIdx);
}

/**
 * Insert ClInclude and ClCompile entries into a .vcxproj.filters file.
 */
function insertIntoFilters(filePath, headers, sources) {
    let content = fs.readFileSync(filePath, 'utf8');

    const headerLines = headers.map(h => `    <ClInclude Include="${h}" />`).join('\r\n');
    const sourceLines = sources.map(s => `    <ClCompile Include="${s}" />`).join('\r\n');

    content = insertBeforeLastClIncludeGroupEnd(content, headerLines);
    content = insertBeforeLastClCompileGroupEnd(content, sourceLines);

    fs.writeFileSync(filePath, content, 'utf8');
}

// ─── File content generators ──────────────────────────────────────────────────

function fileHeader(filename, description, taskId, author, date) {
    const safeDate = (date || getTodayString());
    return `/**
 * @FileName       : ${filename}
 * @FileDescription: ${description}
 * @TargetVersion  :
 * @FileAuthor     : ${author || ''}
 * @TaskID         : ${taskId || ''}
 * @Language       : C++
 * @ThreadSafe     : no
 * @PlatformDepend : Windows/Intel
 * @CreatedDate    : ${safeDate}
 */
/*********************************************************************
* Copyright (c) 2002-2023 TechnoStar Co., Ltd. All rights reserved.  *
*********************************************************************/
`;
}

/** Build all Opn-side files. Returns {filename: content} */
function buildOpnFiles(opnName, opnId, useOpnDlg, useSelectionList, project, taskId, author, date) {
    const U = opnName.toUpperCase();
    const files = {};

    // ── OpnName.h ──────────────────────────────────────────────────────────────
    files[`${opnName}Opn.h`] = fileHeader(`${opnName}Opn.h`,
        `header file responsible for class, data member, and function declarations implemented in ${opnName}Opn.cpp`,
        taskId, author, date) +
`
#ifndef C${U}OPN_H_
#define C${U}OPN_H_

#include "../DCAD_base/OpnBase.h"
${useOpnDlg ? `\nclass C${opnName}OpnDlg;\n` : ''}
class C${opnName}Opn : public COpnBase
{
    DECLARE_OPERATION(C${opnName}Opn)
public:
    C${opnName}Opn(void);
    virtual ~C${opnName}Opn(void);

protected:

    ///////////////////////////////////////////
    // Create / Destroy Doc and Wnd ( Must be overridden, Memory Alloc/Dealloc selectively )
    virtual COpnDoc* CreateOpnDoc(CDocument* pTargetDoc);
    virtual void DestroyOpnDoc(COpnDoc* pOpnDoc);
    virtual COpnWnd* CreateOpnWnd(CWnd* pTargetWnd);
    virtual void DestroyOpnWnd(COpnWnd* pOpnWnd);

    ///////////////////////////////////////////
    // Operation Event

    // When Create / Destroy
    virtual BOOL OnCreate(BOOL bActivated);        // bActivated = Create with Activated or Not
    virtual void OnDestroy();

    // When Activated or Deactivated
    virtual void OnActivate(BOOL bActivate);
${useOpnDlg ? `
protected:
    C${opnName}OpnDlg*        m_pOpnDlg;` : ''}
};

#endif // C${U}OPN_H_`;

    // ── OpnName.cpp ────────────────────────────────────────────────────────────
    files[`${opnName}Opn.cpp`] = fileHeader(`${opnName}Opn.cpp`,
        `source file responsible for function implementations declared in ${opnName}Opn.h`,
        taskId, author, date) +
`
#include "StdAfx.h"
#include "${opnName}Opn.h"
#include "${opnName}OpnDoc.h"
#include "${opnName}OpnView.h"
${useOpnDlg ? `#include "${opnName}OpnDlg.h"` : ''}
#include "../DCAD_base/DCADDocBase.h"
#include "../DCAD_base/DCADViewBase.h"
#include "../JPTR_lib/msgout.h"

#include "LicenseFeatureDef.h"
namespace
{
    const char* features[] = { JPT_BASE, 0};
}
IMPLEMENT_OPERATION_LICENSE(C${opnName}Opn, COpnBase, _T("${opnId || opnName.toUpperCase()}"), features )

C${opnName}Opn::C${opnName}Opn(void)
{
${useOpnDlg ? '    m_pOpnDlg = NULL;' : ''}
}

C${opnName}Opn::~C${opnName}Opn(void)
{
${useOpnDlg ? `    ASSERT(m_pOpnDlg == NULL);` : ''}
}

COpnDoc* C${opnName}Opn::CreateOpnDoc( CDocument* pTargetDoc )
{
    if( pTargetDoc->IsKindOf(RUNTIME_CLASS(CDCADDocBase)) )
    {
        return (new C${opnName}OpnDoc(pTargetDoc));
    }
    return NULL;
}

void C${opnName}Opn::DestroyOpnDoc( COpnDoc* pOpnDoc )
{
    if( pOpnDoc != NULL )
    {
        delete pOpnDoc;
    }
}

COpnWnd* C${opnName}Opn::CreateOpnWnd( CWnd* pTargetWnd )
{
    if( pTargetWnd->IsKindOf(RUNTIME_CLASS(CDCADViewBase)) )
    {
        return (new C${opnName}OpnView(GetOpnDoc(),pTargetWnd));
    }
    return NULL;
}

void C${opnName}Opn::DestroyOpnWnd( COpnWnd* pOpnWnd )
{
    if( pOpnWnd != NULL )
    {
        delete pOpnWnd;
    }
}

BOOL C${opnName}Opn::OnCreate( BOOL bActivated )
{
    if( !COpnBase::OnCreate(bActivated) )
    {
        return FALSE;
    }

    // TODO : Core Here...
${useOpnDlg ? `    m_pOpnDlg = new C${opnName}OpnDlg(GetOpnDoc());
    if( !m_pOpnDlg->Create(C${opnName}OpnDlg::IDD) )
    {
        TRACE(_T("${opnName} Operation Dialog Create Failure!"));
        return FALSE;
    }
    m_pOpnDlg->ShowWindow( bActivated ? SW_SHOW : SW_HIDE );
` : ''}
    return TRUE;
}

void C${opnName}Opn::OnDestroy()
{
    // TODO : Code Here...
${useOpnDlg ? `    C${opnName}OpnDoc* pOpnDoc = (C${opnName}OpnDoc*)GetOpnDoc();
    ASSERT(pOpnDoc);

    if( m_pOpnDlg )
    {
        HWND hwnd = m_pOpnDlg->GetSafeHwnd();
        if(hwnd && ::IsWindow(hwnd))
            m_pOpnDlg->DestroyWindow();
        delete m_pOpnDlg;
        m_pOpnDlg = NULL;
    }
` : ''}
    COpnBase::OnDestroy();
}

void C${opnName}Opn::OnActivate( BOOL bActivate )
{
    COpnBase::OnActivate(bActivate);

    // TODO : Code Here...
}`;

    // ── OpnNameDoc.h ───────────────────────────────────────────────────────────
    files[`${opnName}OpnDoc.h`] = fileHeader(`${opnName}OpnDoc.h`,
        `header file responsible for class, data member, and function declarations implemented in ${opnName}OpnDoc.cpp`,
        taskId, author, date) +
`
#ifndef C${U}OPNDOC_H_
#define C${U}OPNDOC_H_

#include "../DCAD_base/OpnDocBase.h"

class CDCADDocBase;

class C${opnName}OpnDoc : public COpnDocBase
{
public:
    C${opnName}OpnDoc(CDocument* pTargetDoc);
    virtual ~C${opnName}OpnDoc(void);

    CDCADDocBase* GetTargetDoc() { return (CDCADDocBase *)m_pTargetDoc; }
protected:
    virtual void OnUpdateDB();  // when DB update

};

#endif // C${U}OPNDOC_H_`;

    // ── OpnNameDoc.cpp ─────────────────────────────────────────────────────────
    files[`${opnName}OpnDoc.cpp`] = fileHeader(`${opnName}OpnDoc.cpp`,
        `source file responsible for function implementations declared in ${opnName}OpnDoc.h`,
        taskId, author, date) +
`
#include "stdafx.h"
#include "${opnName}OpnDoc.h"
#include "DCADDBSession.h"
#include "../DCAD_base/DCADDocBase.h"

C${opnName}OpnDoc::C${opnName}OpnDoc(CDocument* pTargetDoc)
    : COpnDocBase(pTargetDoc)
{
}

C${opnName}OpnDoc::~C${opnName}OpnDoc(void)
{
}

void C${opnName}OpnDoc::OnUpdateDB(void)
{
}`;

    // ── OpnNameView.h ──────────────────────────────────────────────────────────
    files[`${opnName}OpnView.h`] = fileHeader(`${opnName}OpnView.h`,
        `header file responsible for class, data member, and function declarations implemented in ${opnName}OpnView.cpp`,
        taskId, author, date) +
`
#ifndef C${U}OPNVIEW_H_
#define C${U}OPNVIEW_H_

#include "../DCAD_base/OpnWndBase.h"

class CDCADViewBase;
class C${opnName}OpnDoc;

class C${opnName}OpnView : public COpnWndBase
{

public:
    C${opnName}OpnView(COpnDoc* pOpn, CWnd* pTargetWnd);
    virtual ~C${opnName}OpnView(void);

    // Notification Receiver
    // return value : if TRUE continue base job, if FALSE stop base job
    virtual BOOL OnNotify(UINT uiMsg, WPARAM wParam, LPARAM lParam);

    C${opnName}OpnDoc* GetOpnDoc() { return (C${opnName}OpnDoc *)COpnWndBase::GetOpnDoc(); }
    CDCADViewBase*  GetTargetWnd() { return (CDCADViewBase*)m_pTargetWnd; }

protected:
    ///////////////////////////////////////////
    // Operation Event

    // When Create / Destroy
    virtual BOOL OnCreate();
    virtual void OnDestroy();

    // When Receive Update
    virtual void OnUpdateOpn(UINT uiHint, LPARAM lParam);
};

#endif // C${U}OPNVIEW_H_`;

    // ── OpnNameView.cpp ────────────────────────────────────────────────────────
    files[`${opnName}OpnView.cpp`] = fileHeader(`${opnName}OpnView.cpp`,
        `source file responsible for function implementations declared in ${opnName}OpnView.h`,
        taskId, author, date) +
`
#include "StdAfx.h"
#include "${opnName}OpnView.h"
#include "${opnName}OpnDoc.h"
#include "../DCAD_base/DCADViewBase.h"

C${opnName}OpnView::C${opnName}OpnView(COpnDoc* pOpnDoc, CWnd* pTargetWnd)
    : COpnWndBase(pOpnDoc,pTargetWnd)
{
}

C${opnName}OpnView::~C${opnName}OpnView(void)
{
}

BOOL C${opnName}OpnView::OnCreate()
{
    if( !__super::OnCreate() )
    {
        return FALSE;
    }

    // TODO : Core Here...

    return TRUE;
}

void C${opnName}OpnView::OnDestroy()
{
    // Code Here...
    __super::OnDestroy();

}

BOOL C${opnName}OpnView::OnNotify( UINT uiMsg, WPARAM wParam, LPARAM lParam )
{
    return TRUE;        // continue ( ignore )
}

void C${opnName}OpnView::OnUpdateOpn( UINT uiHint, LPARAM lParam )
{
    GetTargetWnd()->Invalidate(FALSE);
}`;

    // ── OpnNameDlg.h (optional) ────────────────────────────────────────────────
    if (useOpnDlg) {
        files[`${opnName}OpnDlg.h`] = fileHeader(`${opnName}OpnDlg.h`,
            `header file responsible for class, data member, and function declarations implemented in ${opnName}OpnDlg.cpp`,
            taskId, author, date) +
`
#ifndef C${U}OPNDLG_H_
#define C${U}OPNDLG_H_

#include "../DCAD_base/LayoutOpnDlgBase.h"

class C${opnName}OpnDoc;

class C${opnName}OpnDlg : public CLayoutOpnDlgBase
{
    DECLARE_DYNAMIC(C${opnName}OpnDlg)

public:
    C${opnName}OpnDlg(COpnDoc* pOpn);   // standard constructor
    virtual ~C${opnName}OpnDlg();

// Dialog Data
    enum { IDD = IDD_OPN_DLG_TEMPLATE };

    C${opnName}OpnDoc* GetOpnDoc() { return (C${opnName}OpnDoc *)CLayoutOpnDlgBase::GetOpnDoc(); }

protected:

    afx_msg void OnApply();
    virtual void OnCancel();
    virtual void OnOK();
    virtual BOOL OnInitDialog();

    virtual void OnUpdateOpn(UINT uiHint, LPARAM lParam);   // When Receive Update
    virtual void DoDataExchange(CDataExchange* pDX);    // DDX/DDV support

    BOOL DoOperation();

    DECLARE_MESSAGE_MAP()

};

#endif // C${U}OPNDLG_H_`;

        // ── OpnNameDlg.cpp ─────────────────────────────────────────────────────
        files[`${opnName}OpnDlg.cpp`] = fileHeader(`${opnName}OpnDlg.cpp`,
            `source file responsible for function implementations declared in ${opnName}OpnDlg.h`,
            taskId, author, date) +
`
#include "stdafx.h"
#include "${opnName}OpnDlg.h"
#include "${opnName}OpnDoc.h"
#include "../JPTR_gui/OpnDoc.h"
#include "OpnUtil.h"
${useSelectionList ? '#include "SelectionListDlg.h"' : ''}
#include "../JPTR_lib/JPTException.h"

// C${opnName}OpnDlg dialog

IMPLEMENT_DYNAMIC(C${opnName}OpnDlg, CLayoutOpnDlgBase)

C${opnName}OpnDlg::C${opnName}OpnDlg(COpnDoc* pOpnDoc)
    : CLayoutOpnDlgBase(C${opnName}OpnDlg::IDD, pOpnDoc)
{
}

C${opnName}OpnDlg::~C${opnName}OpnDlg()
{
${useSelectionList ? '    _SAFE_DELETE(m_pSelectionListDlg);' : ''}
}


void C${opnName}OpnDlg::DoDataExchange(CDataExchange* pDX)
{
    __super::DoDataExchange(pDX);
}

BEGIN_MESSAGE_MAP(C${opnName}OpnDlg, CLayoutOpnDlgBase)
    ON_BN_CLICKED(IDAPPLY, &C${opnName}OpnDlg::OnApply)
END_MESSAGE_MAP()


void C${opnName}OpnDlg::OnUpdateOpn( UINT uiHint, LPARAM lParam )
{
${useSelectionList ? `    if(OpnUtil::OM_SELECTION_LIST == uiHint)
    {
        CDCADViewBase* pView = (CDCADViewBase *)lParam;
        ASSERT(pView);
        m_pSelectionListDlg = new CSelectionListDlg;
        m_pSelectionListDlg->Create(this, pView);
        m_pSelectionListDlg->AddBodySelector();
        m_pSelectionListDlg->UpdateSelectors();
        m_pSelectionListDlg->SetSelectMethod(SELMTD_BODY);
        UpdateSelection();
    }` : ''}
}

// C${opnName}OpnDlg message handlers

void C${opnName}OpnDlg::OnCancel()
{
    GetOpnDoc()->EndOpn();
}

void C${opnName}OpnDlg::OnOK()
{
    TRY_BEGIN
    DoOperation();
    GetOpnDoc()->EndOpn();
    CATCH_ALL_TRY_OPNDLG_END
}

void C${opnName}OpnDlg::OnApply()
{
    TRY_BEGIN
    DoOperation();
    CATCH_ALL_TRY_OPNDLG_END
}

BOOL C${opnName}OpnDlg::OnInitDialog()
{
    if(!CreateDlgTemplate(this,OpnUtil::GetXMLPath(_T("template/DlgTemplateTest.xml"))))
        return FALSE;
    __super::OnInitDialog();
    // TODO:  Add extra initialization here
    return TRUE;
}

BOOL C${opnName}OpnDlg::DoOperation()
{
    TRY_BEGIN
    // Place Operation processing here.
    return TRUE;
    CATCH_ALL_RETHROW_END
    return FALSE;
}`;
    }

    return files;
}

/** Build Cmd-side files. Returns {filename: content} */
function buildCmdFiles(opnName, opnId, project, taskId, author, date) {
    const U = opnName.toUpperCase();
    const files = {};

    // ── CmdOpnName.h ──────────────────────────────────────────────────────────
    files[`Cmd${opnName}.h`] = fileHeader(`Cmd${opnName}.h`,
        `header file responsible for class, data member, and function declarations implemented in Cmd${opnName}.cpp`,
        taskId, author, date) +
`
#ifndef CCMD${U}_H_
#define CCMD${U}_H_

#include "CmdBase.h"
#include "CmdMacroUtil.h"

class CDBSession;

class AFX_EXT_CLASS CCmd${opnName} : public CCmdBase
{
public:
    DECL_MACRO_CMD_LICENSE( CCmd${opnName} )

    CCmd${opnName}( CDBSession *pDBSession, BOOL bTransaction=TRUE );
    virtual ~CCmd${opnName}(){}

    virtual BOOL Execute();

protected:
    /* m_bTransaction
    TRUE : For Operations (Doc or Dlg)
    FALSE: For execution from within another Cmd.
           (Maybe another Transaction is running in another Cmd)
    */
    virtual BOOL DoCommand();
};

#endif // CCMD${U}_H_`;

    // ── CmdOpnName.cpp ─────────────────────────────────────────────────────────
    files[`Cmd${opnName}.cpp`] = fileHeader(`Cmd${opnName}.cpp`,
        `source file responsible for function implementations declared in Cmd${opnName}.h`,
        taskId, author, date) +
`
#include "StdAfx.h"
#include "Cmd${opnName}.h"
#include "../JPTR_lib/JPTException.h"
#include "../JPTR_dbms/DBSession.h"

#include "../Common/LicenseFeatureDef.h"

namespace
{
    const char* features[] = { JPT_BASE, 0};
}

IMPLEMENT_MACRO_CMD_LICENSE(CCmd${opnName}, ${opnName}, features)

CCmd${opnName}::CCmd${opnName}( CDBSession *pDBSession, BOOL bTransaction )
    : CCmdBase( pDBSession, bTransaction )
{
}

void CCmd${opnName}::macroArgIO( ArgArchive& arga )
{
    // Place User defined Command parameters for Macro here.
    // Example: MACRO_PARAM(arga, m_param1);
}

BOOL CCmd${opnName}::Execute()
{
    TRY_BEGIN
    if (m_bTransaction)
    {
        CTransaction tx(m_pDBSession);
        if(!tx.Begin(_T("CCmd${opnName}"))) throw JPTException(_T("Transaction Begin Error"), _T("CCmd${opnName}"), 0);

        if(!DoCommand())
        {
            tx.Rollback();
            return FALSE;
        }

        LogMacroCommand();

        tx.Commit();
    }
    else
    {
        if(!DoCommand())
        {
            return FALSE;
        }
    }
    return TRUE;
    CATCH_ALL_RETHROW_END
    return FALSE;
}

BOOL CCmd${opnName}::DoCommand()
{
    TRY_BEGIN
    // Place Command processing here.

    return TRUE;
    CATCH_ALL_RETHROW_END
    return FALSE;
}`;

    return files;
}

// ─── Webview HTML ─────────────────────────────────────────────────────────────

function getWebviewHtml() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Operation Code Generation Parameters</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Segoe UI', Arial, sans-serif;
    font-size: 13px;
    padding: 16px;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
  }
  h2 {
    font-size: 14px;
    font-weight: 600;
    margin-bottom: 14px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .row {
    display: flex;
    align-items: center;
    margin-bottom: 7px;
    gap: 8px;
  }
  .row label {
    width: 160px;
    text-align: right;
    flex-shrink: 0;
    color: var(--vscode-descriptionForeground);
  }
  .row input[type="text"] {
    flex: 1;
    padding: 3px 6px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    border-radius: 2px;
    font-size: 13px;
  }
  .row input[type="text"]:focus {
    outline: 1px solid var(--vscode-focusBorder);
    border-color: var(--vscode-focusBorder);
  }
  .row input[type="text"].readonly {
    background: var(--vscode-input-background);
    color: var(--vscode-disabledForeground, #888);
    font-style: italic;
  }
  .row-pair {
    display: flex;
    align-items: center;
    margin-bottom: 7px;
    gap: 16px;
  }
  .row-pair .field {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
  }
  .row-pair .field label {
    white-space: nowrap;
    color: var(--vscode-descriptionForeground);
    font-weight: 500;
  }
  .row-pair .field input {
    flex: 1;
    padding: 3px 6px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    border-radius: 2px;
    font-size: 13px;
  }
  .row-pair .field input:focus {
    outline: 1px solid var(--vscode-focusBorder);
    border-color: var(--vscode-focusBorder);
  }
  .section-divider {
    border-top: 1px solid var(--vscode-panel-border);
    margin: 12px 0;
  }
  .bottom-area {
    display: flex;
    gap: 12px;
    margin-top: 14px;
    align-items: flex-start;
  }
  .option-box {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    padding: 10px 14px;
    min-width: 160px;
  }
  .option-box legend {
    font-weight: 600;
    font-size: 12px;
    padding: 0 4px;
    color: var(--vscode-descriptionForeground);
  }
  .option-box fieldset {
    border: none;
  }
  .checkbox-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 5px;
  }
  .checkbox-row input[type="checkbox"] {
    width: 14px;
    height: 14px;
    cursor: pointer;
    accent-color: var(--vscode-button-background);
  }
  .info-box {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    padding: 10px 14px;
    flex: 1;
  }
  .info-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }
  .info-row label {
    width: 60px;
    text-align: right;
    color: var(--vscode-descriptionForeground);
    flex-shrink: 0;
    font-size: 12px;
  }
  .info-row input {
    flex: 1;
    padding: 2px 6px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    border-radius: 2px;
    font-size: 12px;
  }
  .info-row input:focus {
    outline: 1px solid var(--vscode-focusBorder);
    border-color: var(--vscode-focusBorder);
  }
  .btn-row {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 10px;
  }
  button {
    padding: 5px 20px;
    font-size: 13px;
    border-radius: 3px;
    cursor: pointer;
    border: 1px solid transparent;
  }
  button.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  button.primary:hover {
    background: var(--vscode-button-hoverBackground);
  }
  button.secondary {
    background: var(--vscode-button-secondaryBackground, #5a5a5a);
    color: var(--vscode-button-secondaryForeground, #fff);
    border-color: var(--vscode-button-border, transparent);
  }
  button.secondary:hover {
    background: var(--vscode-button-secondaryHoverBackground, #6a6a6a);
  }
  .suggest-list {
    position: absolute;
    background: var(--vscode-dropdown-background, #252526);
    border: 1px solid var(--vscode-dropdown-border, #454545);
    max-height: 200px;
    overflow-y: auto;
    z-index: 1000;
    width: 100%;
    left: 0;
    top: 100%;
    border-radius: 2px;
  }
  .suggest-item {
    padding: 4px 8px;
    cursor: pointer;
    font-size: 12px;
    color: var(--vscode-dropdown-foreground, #cccccc);
  }
  .suggest-item:hover, .suggest-item.active {
    background: var(--vscode-list-activeSelectionBackground, #094771);
    color: var(--vscode-list-activeSelectionForeground, #fff);
  }
  .suggest-wrap {
    position: relative;
    flex: 1;
  }
</style>
</head>
<body>
<h2>Operation Code Generation Parameters</h2>

<!-- Project names row -->
<div class="row-pair">
  <div class="field">
    <label>Project Name (Opn)</label>
    <div class="suggest-wrap">
      <input type="text" id="projectOpn" value="DCAD_main2015" autocomplete="off" />
      <div class="suggest-list" id="suggestOpn" style="display:none"></div>
    </div>
  </div>
  <div class="field">
    <label>Project Name (Cmd)</label>
    <div class="suggest-wrap">
      <input type="text" id="projectCmd" value="DCAD_cmd2015" autocomplete="off" />
      <div class="suggest-list" id="suggestCmd" style="display:none"></div>
    </div>
  </div>
</div>

<!-- Operation Identity -->
<div class="row">
  <label>Operation Identity</label>
  <input type="text" id="opnId" placeholder="e.g. ID_MY_OPERATION" />
</div>

<!-- Operation Name -->
<div class="row">
  <label>Operation Name</label>
  <input type="text" id="opnName" placeholder="e.g. BooleanEx" />
</div>

<div class="section-divider"></div>

<!-- Class names (read-only, computed) -->
<div class="row">
  <label>Opn ClassName</label>
  <input type="text" id="opnClassName" class="readonly" readonly />
</div>
<div class="row">
  <label>OpnDoc ClassName</label>
  <input type="text" id="opnDocName" class="readonly" readonly />
</div>
<div class="row">
  <label>OpnView ClassName</label>
  <input type="text" id="opnViewName" class="readonly" readonly />
</div>
<div class="row">
  <label>OpnDlg ClassName</label>
  <input type="text" id="opnDlgName" class="readonly" readonly />
</div>
<div class="row">
  <label>Cmd ClassName</label>
  <input type="text" id="cmdClassName" class="readonly" readonly />
</div>

<div class="section-divider"></div>

<!-- Bottom area -->
<div class="bottom-area">
  <!-- Operation Options -->
  <div class="option-box">
    <fieldset>
      <legend>Operation Options</legend>
      <div class="checkbox-row">
        <input type="checkbox" id="useOpn" checked />
        <label for="useOpn">Use Opn</label>
      </div>
      <div class="checkbox-row">
        <input type="checkbox" id="useOpnDlg" checked />
        <label for="useOpnDlg">Use OpnDlg</label>
      </div>
      <div class="checkbox-row">
        <input type="checkbox" id="useSelectionList" checked />
        <label for="useSelectionList">Use Selection List</label>
      </div>
    </fieldset>
  </div>

  <!-- Command Options -->
  <div class="option-box">
    <fieldset>
      <legend>Command Options</legend>
      <div class="checkbox-row">
        <input type="checkbox" id="useCmd" checked />
        <label for="useCmd">Use Cmd</label>
      </div>
      <div class="checkbox-row">
        <input type="checkbox" id="addNewFiles" checked />
        <label for="addNewFiles">Add new files</label>
      </div>
    </fieldset>
  </div>

  <!-- Info & buttons -->
  <div class="info-box">
    <div class="info-row">
      <label>Project</label>
      <input type="text" id="project" />
    </div>
    <div class="info-row">
      <label>TaskID</label>
      <input type="text" id="taskId" />
    </div>
    <div class="info-row">
      <label>Author</label>
      <input type="text" id="author" />
    </div>
    <div class="info-row">
      <label>Date</label>
      <input type="text" id="date" readonly class="readonly" />
    </div>
    <div class="btn-row">
      <button class="primary" id="btnOK">OK</button>
      <button class="secondary" id="btnCancel">Cancel</button>
    </div>
  </div>
</div>

<script>
  const vscode = acquireVsCodeApi();
  let allProjects = [];

  // ── Fields whose values we persist across tab switches / reloads ───────────
  const TEXT_FIELDS = ['projectOpn', 'projectCmd', 'opnId', 'opnName', 'project', 'taskId', 'author', 'date'];
  const CHECK_FIELDS = ['useOpn', 'useOpnDlg', 'useSelectionList', 'useCmd', 'addNewFiles'];

  function saveState() {
    const state = { text: {}, check: {} };
    TEXT_FIELDS.forEach(id => { const el = document.getElementById(id); if (el) state.text[id] = el.value; });
    CHECK_FIELDS.forEach(id => { const el = document.getElementById(id); if (el) state.check[id] = el.checked; });
    vscode.setState(state);
  }

  function restoreState() {
    const state = vscode.getState();
    if (!state) return false;
    TEXT_FIELDS.forEach(id => {
      const el = document.getElementById(id);
      if (el && state.text && typeof state.text[id] === 'string') el.value = state.text[id];
    });
    CHECK_FIELDS.forEach(id => {
      const el = document.getElementById(id);
      if (el && state.check && typeof state.check[id] === 'boolean') el.checked = state.check[id];
    });
    return true;
  }

  // Persist on any edit.
  TEXT_FIELDS.concat(CHECK_FIELDS).forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', saveState);
      el.addEventListener('change', saveState);
    }
  });

  // ── receive init data from extension ──────────────────────────────────────
  window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.command === 'init') {
      allProjects = msg.projects || [];
      // Restore previously typed values; only fall back to defaults if none saved.
      const hadState = restoreState();
      if (!hadState || !document.getElementById('date').value) {
        document.getElementById('date').value = msg.today || '';
      }
      updateClassNames();
    }
  });

  // Restore immediately on load too (covers reload before init arrives).
  restoreState();

  // ── Compute class names from opnName ──────────────────────────────────────
  const opnNameInput = document.getElementById('opnName');
  opnNameInput.addEventListener('input', updateClassNames);

  function updateClassNames() {
    const name = opnNameInput.value.trim();
    document.getElementById('opnClassName').value  = name ? 'C' + name + 'Opn'    : '';
    document.getElementById('opnDocName').value    = name ? 'C' + name + 'OpnDoc' : '';
    document.getElementById('opnViewName').value   = name ? 'C' + name + 'OpnView': '';
    document.getElementById('opnDlgName').value    = name ? 'C' + name + 'OpnDlg' : '';
    document.getElementById('cmdClassName').value  = name ? 'CCmd' + name          : '';
  }

  // ── Use Opn checkbox toggles dependents ───────────────────────────────────
  document.getElementById('useOpn').addEventListener('change', function() {
    const enabled = this.checked;
    document.getElementById('useOpnDlg').disabled = !enabled;
    document.getElementById('useSelectionList').disabled = !enabled;
    if (!enabled) {
      document.getElementById('useOpnDlg').checked = false;
      document.getElementById('useSelectionList').checked = false;
    }
  });

  document.getElementById('useOpnDlg').addEventListener('change', function() {
    if (!this.checked) {
      document.getElementById('useSelectionList').checked = false;
      document.getElementById('useSelectionList').disabled = true;
    } else {
      document.getElementById('useSelectionList').disabled = false;
    }
  });

  // ── Autocomplete for project names ────────────────────────────────────────
  function setupAutocomplete(inputId, listId) {
    const input = document.getElementById(inputId);
    const list  = document.getElementById(listId);
    let activeIdx = -1;

    input.addEventListener('input', () => showSuggestions(input, list));
    input.addEventListener('keydown', e => {
      const items = list.querySelectorAll('.suggest-item');
      if (e.key === 'ArrowDown') {
        activeIdx = Math.min(activeIdx + 1, items.length - 1);
        highlight(items, activeIdx);
        e.preventDefault();
      } else if (e.key === 'ArrowUp') {
        activeIdx = Math.max(activeIdx - 1, 0);
        highlight(items, activeIdx);
        e.preventDefault();
      } else if (e.key === 'Enter' && activeIdx >= 0) {
        if (items[activeIdx]) {
          input.value = items[activeIdx].textContent;
          list.style.display = 'none';
          activeIdx = -1;
        }
      } else if (e.key === 'Escape') {
        list.style.display = 'none';
        activeIdx = -1;
      }
    });

    input.addEventListener('blur', () => setTimeout(() => { list.style.display = 'none'; activeIdx = -1; }, 150));
    input.addEventListener('focus', () => showSuggestions(input, list));

    function showSuggestions(inp, lst) {
      const val = inp.value.toLowerCase();
      const matches = allProjects.filter(p => p.toLowerCase().includes(val));
      if (matches.length === 0) { lst.style.display = 'none'; return; }
      lst.innerHTML = matches.slice(0, 20).map(p =>
        \`<div class="suggest-item">\${p}</div>\`
      ).join('');
      lst.style.display = 'block';
      lst.querySelectorAll('.suggest-item').forEach(item => {
        item.addEventListener('mousedown', () => {
          inp.value = item.textContent;
          lst.style.display = 'none';
        });
      });
    }

    function highlight(items, idx) {
      items.forEach((it, i) => it.classList.toggle('active', i === idx));
      if (items[idx]) items[idx].scrollIntoView({ block: 'nearest' });
    }
  }

  setupAutocomplete('projectOpn', 'suggestOpn');
  setupAutocomplete('projectCmd', 'suggestCmd');

  // ── OK / Cancel ───────────────────────────────────────────────────────────
  document.getElementById('btnOK').addEventListener('click', () => {
    const opnName = document.getElementById('opnName').value.trim();
    if (!opnName) {
      alert('Please enter an Operation Name.');
      document.getElementById('opnName').focus();
      return;
    }
    vscode.postMessage({
      command: 'ok',
      data: {
        projectOpn:        document.getElementById('projectOpn').value.trim(),
        projectCmd:        document.getElementById('projectCmd').value.trim(),
        opnId:             document.getElementById('opnId').value.trim(),
        opnName:           opnName,
        useOpn:            document.getElementById('useOpn').checked,
        useOpnDlg:         document.getElementById('useOpnDlg').checked,
        useSelectionList:  document.getElementById('useSelectionList').checked,
        useCmd:            document.getElementById('useCmd').checked,
        addNewFiles:       document.getElementById('addNewFiles').checked,
        project:           document.getElementById('project').value.trim(),
        taskId:            document.getElementById('taskId').value.trim(),
        author:            document.getElementById('author').value.trim(),
        date:              document.getElementById('date').value,
      }
    });
  });

  document.getElementById('btnCancel').addEventListener('click', () => {
    vscode.postMessage({ command: 'cancel' });
  });
</script>
</body>
</html>`;
}

module.exports = { activate, deactivate };
