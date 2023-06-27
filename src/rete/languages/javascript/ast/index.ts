import * as BabelType from '@babel/types'
import * as t from '@babel/types'
// import { parse, ParserOptions } from '@babel/parser'
// import generate from '@babel/generator'
import traverse, { Scope as TraverseScope, NodePath } from '@babel/traverse'
import { getIdentifiers } from './utils'
import { getUID } from 'rete'


const scopeHoisingIndex = new WeakMap()

function hoise(scopable: BabelType.Scopable, declaration: BabelType.Declaration) {
  const parentBody = getScopableBody(scopable)
  const index = scopeHoisingIndex.get(parentBody) || 0

  parentBody.splice(index, 0, declaration)
  scopeHoisingIndex.set(parentBody, index + 1)
}

function getScopableBody(scopable: BabelType.Scopable) {
  if (BabelType.isSwitchStatement(scopable)) throw new Error('scope does not have body')
  if (!Array.isArray(scopable.body)) throw new Error('not implemented for non-array body')

  return scopable.body
}


function declarationToVariable(declaration: BabelType.Declaration, parentScope: TraverseScope) {
  if (BabelType.isVariableDeclaration(declaration)) {
    return declaration
  }
  if (BabelType.isFunctionDeclaration(declaration)) {
    if (!declaration.id) throw new Error('function declaration should have id')

    return BabelType.variableDeclaration('var', [
      BabelType.variableDeclarator(declaration.id, declarationToExpression(declaration, parentScope))
    ])
  }
  if (BabelType.isClassDeclaration(declaration)) {
    return BabelType.variableDeclaration('const', [
      BabelType.variableDeclarator(declaration.id, declarationToExpression(declaration, parentScope))
    ])
  }
  throw new Error('unknown declaration type')
}

function declarationToExpression(declaration: BabelType.Declaration, parentScope: TraverseScope) {
  if (BabelType.isFunctionDeclaration(declaration)) {
    const { id, params, body, generator, async } = declaration

    applyAstTransformations(body, parentScope)

    return BabelType.functionExpression(id, params, body, generator, async)
  }
  if (BabelType.isClassDeclaration(declaration)) {
    applyAstTransformations(declaration, parentScope)

    const { id, superClass, body, decorators } = declaration

    return BabelType.classExpression(id, superClass, body, decorators)
  }
  throw new Error('unknown declaration type')
}

function prepend(parent: BabelType.Scopable, node: BabelType.Statement, nextSibling: BabelType.Statement) {
  const body = getScopableBody(parent)

  const exportIndex = body.indexOf(nextSibling)

  if (exportIndex < 0) throw new Error('exportIndex is negative')

  body.splice(exportIndex, 0, node)
}

function createLoop(path: NodePath<BabelType.Statement>) {
  const id = path.parentPath.isLabeledStatement() ? path.parentPath.node.label : t.identifier('loop' + getUID())

  if (path.parentPath.isLabeledStatement()) {
    path.parentPath.node.label = t.identifier('old' + getUID())
  }

  return {
    id,
    statement: t.labeledStatement(id, t.emptyStatement()),
    patchContinue(body: BabelType.Statement, pregoto?: BabelType.Statement | null) {
      traverse(body, {
        enter(path) {
          if (path.isCompletionStatement()) {
            path.skip()
          }
          if (path.isContinueStatement()) {
            if (!path.node.label || path.node.label.name === id.name) {
              const n = t.continueStatement(id)
              path.replaceWith(t.blockStatement(pregoto ? [pregoto, n] : [n]))
              path.skip()
            }
          }
        }
      }, path.scope)
    }
  }
}

function loopToGoto(path: NodePath<BabelType.WhileStatement | BabelType.ForStatement>, pregoto?: BabelType.Statement | null) {
  const { test, body } = path.node;
  const { id, statement, patchContinue } = createLoop(path)
  const block = t.blockStatement([])

  const ifStatement = t.ifStatement(test || t.booleanLiteral(true), block)

  statement.body = ifStatement

  patchContinue(body, pregoto)

  if (t.isBlockStatement(body)) {
    block.body.push(...body.body);
  } else {
    block.body.push(body)
  }
  if (pregoto) {
    block.body.push(pregoto)
  }
  block.body.push(t.continueStatement(id))

  return {
    statement,
    id,
    body: block
  }
}

export function makePurifiedExecutable<T extends BabelType.Node>(node: T, scope?: TraverseScope): T {
  traverse(node, {
    enter(path) {
      if (path.isLabeledStatement()) {
        const { label, body } = path.node

        makePurifiedExecutable(body, path.scope)

        path.replaceWith(t.labeledStatement(label, t.whileStatement(t.booleanLiteral(true), t.blockStatement([
          body,
          t.breakStatement(label)
        ]))))
        path.skip()
      }
    }
  }, scope)
  return node
}

export function applyAstTransformations<T extends BabelType.Node>(node: T, scope?: TraverseScope): T {
  traverse(node, {
    enter(path) {
      if (path.isObjectProperty()) {
        if (!path.node.computed && t.isIdentifier(path.node.key)) {
          path.replaceWith(t.objectProperty(t.stringLiteral(path.node.key.name), path.node.value, true, path.node.shorthand, path.node.decorators))
        }
      }
      if (path.isMemberExpression()) {
        if (!path.node.computed && t.isIdentifier(path.node.property)) {
          path.replaceWith(t.memberExpression(path.node.object, t.stringLiteral(path.node.property.name), true, path.node.optional))
        }
      }
      if (path.isWhileStatement()) {
        const { statement } = loopToGoto(path)

        path.replaceWith(statement)
      }
      if (path.isForStatement()) {
        const { init, update } = path.node;
        const { statement } = loopToGoto(path, update && t.expressionStatement(update))

        const closure = t.blockStatement([statement])

        if (init) {
          closure.body.unshift(t.isStatement(init) ? init : t.expressionStatement(init))
        }

        path.replaceWith(closure);
      }
      if (path.isDoWhileStatement()) {
        const { test, body } = path.node;
        const { id, statement, patchContinue } = createLoop(path)
        const block = t.blockStatement([])

        patchContinue(body)
        statement.body = block

        if (t.isBlockStatement(body)) {
          block.body.push(...body.body);
        } else {
          block.body.push(body)
        }

        const ifStatement = t.ifStatement(test || t.booleanLiteral(true), t.continueStatement(id))

        block.body.push(ifStatement)

        path.replaceWith(statement);
      }
      if (path.isForInStatement() || path.isForOfStatement()) {
        const { left, right, body } = path.node;
        const { id, statement, patchContinue } = createLoop(path)
        const closure = t.blockStatement([statement])

        const iteratorId = t.identifier('iterator')
        const iterator = t.memberExpression(right, t.memberExpression(t.identifier('Symbol'), t.identifier('iterator')), true)

        closure.body.unshift(t.variableDeclaration('const', [
          t.variableDeclarator(iteratorId, t.callExpression(iterator, []))
        ]))

        const block = t.blockStatement([])

        patchContinue(body)
        statement.body = block

        block.body.push(t.variableDeclaration('const', [
          t.variableDeclarator(t.objectPattern([
            t.objectProperty(t.identifier('value'), t.identifier('value')),
            t.objectProperty(t.identifier('done'), t.identifier('done'))
          ]), t.callExpression(t.memberExpression(iteratorId, t.identifier('next')), [])
          )]))
        block.body.push(t.ifStatement(t.identifier('done'), t.breakStatement(id)))

        if (t.isVariableDeclaration(left)) {
          left.declarations[0].init = right
          block.body.push(left)
        } else {
          block.body.push(t.variableDeclaration('const', [
            t.variableDeclarator(left, t.identifier('value'))
          ]))
        }

        if (t.isBlockStatement(body)) {
          block.body.push(...body.body);
        } else {
          block.body.push(body)
        }

        block.body.push(t.continueStatement(id))
        path.replaceWith(closure);
      }
      if (path.isSwitchStatement()) {
        const { discriminant, cases } = path.node;
        const { statement } = createLoop(path)

        const block = t.blockStatement([])

        statement.body = block

        const v = t.variableDeclaration('let', [
          t.variableDeclarator(t.identifier('_switchCase'))
        ])
        block.body.push(v)
        cases.forEach(item => {
          const completed = t.assignmentExpression('=', t.identifier('_switchCase'), t.booleanLiteral(true))
          const test = item.test && t.binaryExpression('===', discriminant, item.test)
          const testAll = test && t.logicalExpression('||', t.identifier('_switchCase'), test)

          block.body.push(testAll ? t.ifStatement(testAll, t.blockStatement([
            ...item.consequent,
            t.expressionStatement(completed)
          ])) : t.blockStatement(item.consequent))
        })

        path.replaceWith(statement)
      }
      if (path.isExportNamedDeclaration() && path.node.declaration) {
        if (!BabelType.isScopable(path.parent)) throw new Error('parent is not scopable')

        const { declaration } = path.node

        path.node.declaration = null

        const varDeclaration = declarationToVariable(declaration, path.parentPath.scope)

        prepend(path.parent, varDeclaration, path.node)

        const declarations = varDeclaration.declarations.map(item => getIdentifiers(item.id)).flat()

        for (const id of declarations) {
          path.node.specifiers.push(BabelType.exportSpecifier(id, id))
        }
      } else if (path.isExportDefaultDeclaration() && path.node.declaration) {

        if (BabelType.isDeclaration(path.node.declaration)) {
          path.node.declaration = declarationToExpression(path.node.declaration, path.parentPath.scope)
        }
      } else if (path.isImportDefaultSpecifier()) {
        path.replaceWith(BabelType.importSpecifier(path.node.local, BabelType.identifier('default')))
      } else if (path.isFunctionDeclaration()) {
        if (path.node.id && ('body' in path.parent)) {
          const variable = declarationToVariable(path.node, path.parentPath.scope)
          path.remove()

          if (!BabelType.isScopable(path.parent)) throw new Error('parent is not scopable')
          hoise(path.parent, variable)
        }
      } else if (path.isClassDeclaration()) {
        path.replaceWith(declarationToVariable(path.node, path.parentPath.scope))
      } else if (path.isObjectMethod()) {
        const { params, body, generator, async } = path.node
        const functionExpression = BabelType.functionExpression(null, params, body, generator, async)

        path.replaceWith(BabelType.objectProperty(path.node.key, functionExpression))
      } else if (path.isArrowFunctionExpression() && BabelType.isExpression(path.node.body)) {
        path.node.body = BabelType.blockStatement([BabelType.returnStatement(path.node.body)])
      } else if (path.isClassMethod() && BabelType.isIdentifier(path.node.key) && path.node.key.name !== 'constructor') {
        const params = path.node.params.filter((p): p is Exclude<typeof p, BabelType.TSParameterProperty> => !BabelType.isTSParameterProperty(p))
        const functionExpression = BabelType.functionExpression(null, params, path.node.body)

        const parent = path.parentPath
        if (!parent.isClassBody()) throw new Error('parent is not class body')

        parent.node.body.unshift(BabelType.classProperty(path.node.key, functionExpression))
        path.remove()
      }
    }
  }, scope)
  return node
}

export function applyAstReverseTransformations<T extends BabelType.Node>(node: T, scope?: TraverseScope): T {
  const n = BabelType.isProgram(node) ? BabelType.file(node) : node
  traverse(n, {
    enter(path) {
      if (path.isObjectProperty()) {
        if (path.node.computed && t.isStringLiteral(path.node.key)) {
          path.replaceWith(t.objectProperty(t.identifier(path.node.key.value), path.node.value, false, path.node.shorthand, path.node.decorators))
        }
      }
      if (path.isMemberExpression()) {
        if (path.node.computed && t.isStringLiteral(path.node.property)) {
          path.replaceWith(t.memberExpression(path.node.object, t.identifier(path.node.property.value), false, path.node.optional))
        }
      }
    }
  }, scope)
  return n as T
}
