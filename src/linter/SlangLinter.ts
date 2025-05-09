// SPDX-License-Identifier: MIT
import * as vscode from 'vscode'
import { FileDiagnostic } from '../utils'
import BaseLinter from './BaseLinter'

export default class SlangLinter extends BaseLinter {
  protected convertToSeverity(severityString: string): vscode.DiagnosticSeverity {
    if (severityString.startsWith('error')) {
      return vscode.DiagnosticSeverity.Error
    } else if (severityString.startsWith('warning')) {
      return vscode.DiagnosticSeverity.Warning
    }
    return vscode.DiagnosticSeverity.Information
  }

  protected parseDiagnostics(args: {
    wsUri: vscode.Uri
    doc: vscode.TextDocument
    stdout: string
    stderr: string
  }): FileDiagnostic[] {
    /// TODO: reuse tasks/problem matchers for this

    let diags: FileDiagnostic[] = []

    let nonNoteDiag: FileDiagnostic | undefined = undefined

    const re = /(.+?):(\d+):(\d+):\s(note|warning|error):\s(.*?)(\[-W(.*)\]|$)/
    let lines = args.stderr.split(/\r?\n/g)
    for (let n = 0; n < lines.length; n++) {
      let line = lines[n]
      if (line.search(re) === -1) {
        continue
      }

      let rex = line.match(re)
      if (rex === null) {
        continue
      }

      if (!rex || rex[0].length === 0) {
        this.logger.warn('[slang] failed to parse error: ' + line)
        continue
      }

      let filePath = rex[1]
      let lineNum = Number(rex[2]) - 1
      let colNum = Number(rex[3]) - 1
      // find range
      const rangeLine = lines[n + 2]
      let begin = colNum
      let end = rangeLine.length
      if (colNum === rangeLine.length - 1) {
        // 1 length range, get the closest word after (unknown macro, etc.)
        const textLine = lines[n + 1]
        end = 1 + colNum + textLine.slice(colNum + 1).search(/[^a-zA-Z0-9_]/g)
        if (end <= colNum + 1) {
          end = textLine.length
        }
      } else {
        // n length range, adjust for ~~~~^~~~ case
        begin = Math.min(colNum, rangeLine.indexOf('~'))
        // should never happen, but just to be safe
        if (begin === -1) {
          begin = colNum
        }
      }

      // find message, potentially getting instance
      let msg = rex[5]
      if (n + 3 < lines.length && lines[n + 3].startsWith('  in instance:')) {
        msg += '\n' + lines[n + 3]
        n++
      }
      n += 2
      const slangSeverity = rex[4]

      const diag: FileDiagnostic = {
        file: filePath,
        severity: this.convertToSeverity(slangSeverity),
        range: new vscode.Range(
          new vscode.Position(lineNum, begin),
          new vscode.Position(lineNum, end)
        ),
        message: msg,
        code: rex[7] ? rex[7] : 'error',
        source: 'slang',
      }

      if (slangSeverity === 'note') {
        // Add to previous diag
        this.logger.info('[slang] note from previous error: ' + line)
        if (nonNoteDiag === undefined) {
          this.logger.warn('[slang] previous error not found: ' + line)
        } else {
          if (nonNoteDiag.relatedInformation === undefined) {
            nonNoteDiag.relatedInformation = []
          }
          nonNoteDiag.relatedInformation?.push({
            location: new vscode.Location(
              vscode.Uri.file(args.wsUri.fsPath + '/' + filePath),
              new vscode.Position(lineNum, colNum)
            ),
            message: msg,
          })
        }
      } else {
        nonNoteDiag = diag

        if (
          rex[7] &&
          rex[7].startsWith('unused-') &&
          !rex[7].startsWith('unused-config') &&
          !rex[7].startsWith('unused-but')
        ) {
          diag.tags = [vscode.DiagnosticTag.Unnecessary]
          if (diag.severity === vscode.DiagnosticSeverity.Warning) {
            diag.severity = vscode.DiagnosticSeverity.Hint
          }
        }
      }

      diags.push(diag)
    }

    return diags
  }
}
