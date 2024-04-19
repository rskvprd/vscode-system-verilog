// SPDX-License-Identifier: MIT
import * as vscode from 'vscode'
import { ext } from './extension'
import { ConfigObject, ExtensionComponent } from './libconfig'
import { CtagsParser, Symbol } from './parsers/ctagsParser'
import { getParentText, getPrevChar } from './utils'

export class CtagsManager extends ExtensionComponent {
  // file -> parser
  private filemap: Map<vscode.TextDocument, CtagsParser> = new Map()
  /// symbol name -> symbols (from includes)
  private symbolMap: Map<string, Symbol[]> = new Map()

  path: ConfigObject<string> = new ConfigObject({
    default: 'ctags',
    description: 'Path to ctags universal executable',
  })

  indexAllIncludes: ConfigObject<boolean> = new ConfigObject({
    default: false,
    description: 'Whether to index all .svh files',
  })

  activate(_context: vscode.ExtensionContext): void {
    this.logger.info('activating')
    vscode.workspace.onDidCloseTextDocument((doc: vscode.TextDocument) => {
      this.filemap.delete(doc)
    })

    ext.includes.onConfigUpdated(() => {
      if (!this.indexAllIncludes.getValue()) {
        this.indexIncludes()
      }
    })

    vscode.workspace.onDidSaveTextDocument((doc: vscode.TextDocument) => {
      this.getCtags(doc).clearSymbols()
    })
  }

  async indexIncludes(): Promise<void> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: 'Indexing Verilog Includes',
        cancellable: true,
      },
      async () => {
        let files: vscode.Uri[]

        if (this.indexAllIncludes.getValue()) {
          files = await ext.findFiles(['svh'])
        } else {
          files = await ext.findFiles(['svh'], ext.includes.getValue(), false)
        }
        this.logger.info(`indexing ${files.length} .svh files`)

        files.forEach(async (file: vscode.Uri) => {
          let doc = await vscode.workspace.openTextDocument(file)
          let syms = await this.getCtags(doc).getPackageSymbols()
          syms.forEach((element: Symbol) => {
            if (this.symbolMap.has(element.name)) {
              this.symbolMap.get(element.name)?.push(element)
            } else {
              this.symbolMap.set(element.name, [element])
            }
          })
          // close doc
        })

        this.logger.info(`indexed ${files.length} .svh files`)
      }
    )
  }

  getCtags(doc: vscode.TextDocument): CtagsParser {
    let ctags: CtagsParser | undefined = this.filemap.get(doc)
    if (ctags === undefined) {
      ctags = new CtagsParser(this.logger, doc)
      this.filemap.set(doc, ctags)
    }
    return ctags
  }

  async findDefinitionByName(moduleName: string, targetText: string): Promise<Symbol[]> {
    let file = await ext.index.findModule(moduleName)
    if (file === undefined) {
      return []
    }
    let parser = this.getCtags(file)
    return await parser.getSymbols({ name: targetText })
  }

  /// Finds a symbols definition, but also looks in targetText.sv to get module/interface defs
  async findSymbol(document: vscode.TextDocument, position: vscode.Position): Promise<Symbol[]> {
    let textRange = document.getWordRangeAtPosition(position)
    if (!textRange || textRange.isEmpty) {
      return []
    }
    let parser = this.getCtags(document)
    let targetText = document.getText(textRange)
    let symPromise = parser.getSymbols({ name: targetText })

    let parentScope = getParentText(document, textRange)
    // let modulePromise = this.findDefinitionByName(parentScope, targetText);
    // If we're at a port, .<text> plus no parent
    if (getPrevChar(document, textRange) === '.') {
      if (parentScope === targetText) {
        // param or port on instance
        let insts = await parser.getSymbols({ type: 'instance' })
        insts = insts.filter((inst) => inst.getFullRange().contains(position))
        if (insts.length > 0 && insts[0].typeRef !== null) {
          return await this.findDefinitionByName(insts[0].typeRef, targetText)
        }
      } else if (parentScope !== undefined) {
        // hierarchcal reference to instance.wire
        let insts = await parser.getSymbols({ name: parentScope })
        if (insts.length > 0 && insts[0].typeRef !== null) {
          return await this.findDefinitionByName(insts[0].typeRef, targetText)
        }
      }
    }

    if (this.symbolMap.has(targetText)) {
      return this.symbolMap.get(targetText) ?? []
    }

    if (ext.index.moduleMap.has(targetText) || ext.index.moduleMap.has(parentScope)) {
      // find parentScope.sv of parentScope::targetText
      let sym = (await this.findDefinitionByName(parentScope, targetText)).at(0)
      // Sometimes package::x is found multiple times, return just the top level package
      if (sym !== undefined) {
        return [sym]
      }
    }
    return await symPromise
  }
}
