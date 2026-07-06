import * as acorn from 'acorn';

// Restricted interpreter for build-generator code.
//
// Node's `vm` module is NOT a security boundary: sandboxed code can reach the
// host realm through the prototype chain (e.g. ({}).constructor.constructor)
// and execute arbitrary code in the server process. This module replaces it
// with a small AST interpreter over the JS subset the build DSL actually
// needs. Nothing from the host realm is reachable:
//  - only the globals explicitly passed in are visible;
//  - property access is allowlisted (plain objects/arrays/strings/numbers),
//    and `constructor`, `prototype`, `__proto__` etc. are always rejected;
//  - `new`, `this`, classes, imports, async/generators are not supported;
//  - execution is bounded by an operation budget and a wall-clock deadline.

export interface RestrictedScriptOptions {
  /** Wall-clock limit in milliseconds (default 10000). */
  timeoutMs?: number;
  /** Interpreter operation budget (default 20 million). */
  maxOps?: number;
}

export class ScriptTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScriptTimeoutError';
  }
}

class BreakSignal {
  constructor(readonly label?: string) {}
}
class ContinueSignal {
  constructor(readonly label?: string) {}
}
class ReturnSignal {
  constructor(readonly value: any) {}
}

const FORBIDDEN_PROPS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  'caller',
  'callee',
  'arguments',
  'bind',
  'call',
  'apply',
]);

const ARRAY_MEMBERS = new Set([
  'length', 'push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'indexOf',
  'lastIndexOf', 'includes', 'join', 'map', 'filter', 'forEach', 'reduce',
  'reduceRight', 'concat', 'reverse', 'sort', 'find', 'findIndex', 'some',
  'every', 'flat', 'flatMap', 'fill',
]);

const STRING_MEMBERS = new Set([
  'length', 'charAt', 'charCodeAt', 'codePointAt', 'indexOf', 'lastIndexOf',
  'includes', 'startsWith', 'endsWith', 'slice', 'substring', 'toUpperCase',
  'toLowerCase', 'trim', 'trimStart', 'trimEnd', 'split', 'repeat',
  'padStart', 'padEnd', 'concat', 'at', 'replace', 'replaceAll',
]);

const NUMBER_MEMBERS = new Set(['toFixed', 'toPrecision', 'toString']);

function isPlainObject(value: any): boolean {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

class Scope {
  private vars = new Map<string, any>();
  private consts = new Set<string>();

  constructor(
    readonly parent?: Scope,
    readonly isFunctionScope: boolean = false,
  ) {}

  declare(name: string, value: any, kind: 'var' | 'let' | 'const') {
    if (kind === 'var' && !this.isFunctionScope && this.parent) {
      // var-scoped to the nearest function/global scope
      this.parent.declare(name, value, kind);
      return;
    }
    this.vars.set(name, value);
    if (kind === 'const') this.consts.add(name);
  }

  private resolve(name: string): Scope | undefined {
    if (this.vars.has(name)) return this;
    return this.parent?.resolve(name);
  }

  private globalScope(): Scope {
    return this.parent ? this.parent.globalScope() : this;
  }

  has(name: string): boolean {
    return this.resolve(name) !== undefined;
  }

  get(name: string): any {
    const s = this.resolve(name);
    if (!s) throw new Error(`${name} is not defined`);
    return s.vars.get(name);
  }

  set(name: string, value: any) {
    const s = this.resolve(name);
    if (!s) {
      // Implicit global (LLM-generated code often skips declarations)
      this.globalScope().vars.set(name, value);
      return;
    }
    if (s.consts.has(name)) throw new Error(`Assignment to constant variable "${name}"`);
    s.vars.set(name, value);
  }
}

export function runRestrictedScript(
  code: string,
  globals: Record<string, any>,
  options?: RestrictedScriptOptions,
): void {
  const timeoutMs = options?.timeoutMs ?? 10000;
  const maxOps = options?.maxOps ?? 20_000_000;
  const deadline = Date.now() + timeoutMs;
  let ops = 0;

  let ast: any;
  try {
    ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: 'script' });
  } catch (err: any) {
    throw new Error(`Syntax error: ${err.message}`);
  }

  const globalScope = new Scope(undefined, true);
  for (const [name, value] of Object.entries(globals)) {
    globalScope.declare(name, value, 'const');
  }

  function tick() {
    ops++;
    if (ops > maxOps) {
      throw new ScriptTimeoutError(`Operation budget exceeded (${maxOps} ops)`);
    }
    if ((ops & 0x1fff) === 0 && Date.now() > deadline) {
      throw new ScriptTimeoutError(`Execution timed out after ${timeoutMs}ms`);
    }
  }

  function assertPropAllowed(prop: any): string {
    const name = typeof prop === 'symbol' ? String(prop) : String(prop);
    if (FORBIDDEN_PROPS.has(name)) {
      throw new Error(`Access to property "${name}" is not allowed`);
    }
    return name;
  }

  function getMember(obj: any, prop: any): any {
    if (obj === null || obj === undefined) {
      throw new Error(`Cannot read property "${String(prop)}" of ${obj}`);
    }
    const name = assertPropAllowed(prop);

    if (Array.isArray(obj)) {
      if (name === 'length') return obj.length;
      const idx = Number(name);
      if (Number.isInteger(idx) && idx >= 0) return obj[idx];
      if (ARRAY_MEMBERS.has(name)) return (obj as any)[name];
      throw new Error(`Array method "${name}" is not allowed`);
    }
    if (typeof obj === 'string') {
      if (name === 'length') return obj.length;
      const idx = Number(name);
      if (Number.isInteger(idx) && idx >= 0) return obj[idx];
      if (STRING_MEMBERS.has(name)) return (obj as any)[name];
      throw new Error(`String method "${name}" is not allowed`);
    }
    if (typeof obj === 'number') {
      if (NUMBER_MEMBERS.has(name)) return (obj as any)[name];
      throw new Error(`Number method "${name}" is not allowed`);
    }
    if (isPlainObject(obj)) {
      // Own properties only — never walk the prototype chain.
      if (Object.prototype.hasOwnProperty.call(obj, name)) return obj[name];
      return undefined;
    }
    throw new Error(`Property access on this value type is not allowed`);
  }

  function setMember(obj: any, prop: any, value: any) {
    if (obj === null || obj === undefined) {
      throw new Error(`Cannot set property "${String(prop)}" of ${obj}`);
    }
    const name = assertPropAllowed(prop);
    if (Object.isFrozen(obj)) {
      throw new Error(`Cannot assign to property "${name}" of a frozen object`);
    }
    if (Array.isArray(obj)) {
      const idx = Number(name);
      if ((Number.isInteger(idx) && idx >= 0) || name === 'length') {
        (obj as any)[name] = value;
        return;
      }
      throw new Error(`Cannot set property "${name}" on an array`);
    }
    if (isPlainObject(obj)) {
      obj[name] = value;
      return;
    }
    throw new Error(`Property assignment on this value type is not allowed`);
  }

  function callFunction(fn: any, thisArg: any, args: any[], desc: string): any {
    if (typeof fn !== 'function') {
      throw new Error(`${desc} is not a function`);
    }
    return fn.apply(thisArg, args);
  }

  function bindPattern(pattern: any, value: any, scope: Scope, kind: 'var' | 'let' | 'const') {
    switch (pattern.type) {
      case 'Identifier':
        scope.declare(pattern.name, value, kind);
        return;
      case 'AssignmentPattern':
        bindPattern(pattern.left, value === undefined ? evaluate(pattern.right, scope) : value, scope, kind);
        return;
      case 'ArrayPattern': {
        if (value === null || value === undefined) throw new Error('Cannot destructure null/undefined');
        let i = 0;
        for (const el of pattern.elements) {
          if (el === null) { i++; continue; }
          if (el.type === 'RestElement') {
            bindPattern(el.argument, Array.isArray(value) ? value.slice(i) : [], scope, kind);
            break;
          }
          bindPattern(el, getMember(value, i), scope, kind);
          i++;
        }
        return;
      }
      case 'ObjectPattern': {
        if (value === null || value === undefined) throw new Error('Cannot destructure null/undefined');
        const used = new Set<string>();
        for (const propNode of pattern.properties) {
          if (propNode.type === 'RestElement') {
            const rest: Record<string, any> = {};
            if (isPlainObject(value)) {
              for (const k of Object.keys(value)) {
                if (!used.has(k) && !FORBIDDEN_PROPS.has(k)) rest[k] = value[k];
              }
            }
            bindPattern(propNode.argument, rest, scope, kind);
            continue;
          }
          const key = propNode.computed
            ? String(evaluate(propNode.key, scope))
            : (propNode.key.type === 'Identifier' ? propNode.key.name : String(propNode.key.value));
          used.add(key);
          bindPattern(propNode.value, getMember(value, key), scope, kind);
        }
        return;
      }
      default:
        throw new Error(`Unsupported binding pattern: ${pattern.type}`);
    }
  }

  function makeFunction(node: any, closureScope: Scope): (...args: any[]) => any {
    return (...args: any[]) => {
      tick();
      const fnScope = new Scope(closureScope, true);
      node.params.forEach((param: any, i: number) => {
        if (param.type === 'RestElement') {
          bindPattern(param.argument, args.slice(i), fnScope, 'let');
        } else {
          bindPattern(param, args[i], fnScope, 'let');
        }
      });
      try {
        if (node.body.type === 'BlockStatement') {
          executeBlock(node.body.body, new Scope(fnScope));
          return undefined;
        }
        return evaluate(node.body, fnScope);
      } catch (signal) {
        if (signal instanceof ReturnSignal) return signal.value;
        throw signal;
      }
    };
  }

  function hoistFunctions(statements: any[], scope: Scope) {
    for (const stmt of statements) {
      if (stmt.type === 'FunctionDeclaration' && stmt.id) {
        if (stmt.async || stmt.generator) throw new Error('async/generator functions are not supported');
        scope.declare(stmt.id.name, makeFunction(stmt, scope), 'let');
      }
    }
  }

  function executeBlock(statements: any[], scope: Scope) {
    hoistFunctions(statements, scope);
    for (const stmt of statements) {
      execute(stmt, scope);
    }
  }

  function execute(node: any, scope: Scope): void {
    tick();
    switch (node.type) {
      case 'ExpressionStatement':
        evaluate(node.expression, scope);
        return;
      case 'VariableDeclaration':
        for (const decl of node.declarations) {
          const value = decl.init ? evaluate(decl.init, scope) : undefined;
          bindPattern(decl.id, value, scope, node.kind);
        }
        return;
      case 'FunctionDeclaration':
        return; // hoisted by executeBlock
      case 'BlockStatement':
        executeBlock(node.body, new Scope(scope));
        return;
      case 'EmptyStatement':
        return;
      case 'IfStatement':
        if (evaluate(node.test, scope)) {
          execute(node.consequent, scope);
        } else if (node.alternate) {
          execute(node.alternate, scope);
        }
        return;
      case 'ForStatement': {
        const forScope = new Scope(scope);
        if (node.init) {
          if (node.init.type === 'VariableDeclaration') execute(node.init, forScope);
          else evaluate(node.init, forScope);
        }
        while (node.test === null || evaluate(node.test, forScope)) {
          tick();
          try {
            execute(node.body, new Scope(forScope));
          } catch (signal) {
            if (signal instanceof BreakSignal) break;
            if (!(signal instanceof ContinueSignal)) throw signal;
          }
          if (node.update) evaluate(node.update, forScope);
        }
        return;
      }
      case 'ForOfStatement': {
        const iterable = evaluate(node.right, scope);
        if (!Array.isArray(iterable) && typeof iterable !== 'string') {
          throw new Error('for...of only supports arrays and strings');
        }
        for (const item of iterable as any[]) {
          tick();
          const iterScope = new Scope(scope);
          if (node.left.type === 'VariableDeclaration') {
            bindPattern(node.left.declarations[0].id, item, iterScope, node.left.kind);
          } else {
            assignTo(node.left, item, iterScope);
          }
          try {
            execute(node.body, iterScope);
          } catch (signal) {
            if (signal instanceof BreakSignal) break;
            if (!(signal instanceof ContinueSignal)) throw signal;
          }
        }
        return;
      }
      case 'ForInStatement': {
        const obj = evaluate(node.right, scope);
        const keys = isPlainObject(obj) ? Object.keys(obj) : Array.isArray(obj) ? obj.map((_, i) => String(i)) : [];
        for (const key of keys) {
          tick();
          const iterScope = new Scope(scope);
          if (node.left.type === 'VariableDeclaration') {
            bindPattern(node.left.declarations[0].id, key, iterScope, node.left.kind);
          } else {
            assignTo(node.left, key, iterScope);
          }
          try {
            execute(node.body, iterScope);
          } catch (signal) {
            if (signal instanceof BreakSignal) break;
            if (!(signal instanceof ContinueSignal)) throw signal;
          }
        }
        return;
      }
      case 'WhileStatement':
        while (evaluate(node.test, scope)) {
          tick();
          try {
            execute(node.body, new Scope(scope));
          } catch (signal) {
            if (signal instanceof BreakSignal) break;
            if (!(signal instanceof ContinueSignal)) throw signal;
          }
        }
        return;
      case 'DoWhileStatement':
        do {
          tick();
          try {
            execute(node.body, new Scope(scope));
          } catch (signal) {
            if (signal instanceof BreakSignal) break;
            if (!(signal instanceof ContinueSignal)) throw signal;
          }
        } while (evaluate(node.test, scope));
        return;
      case 'BreakStatement':
        throw new BreakSignal(node.label?.name);
      case 'ContinueStatement':
        throw new ContinueSignal(node.label?.name);
      case 'ReturnStatement':
        throw new ReturnSignal(node.argument ? evaluate(node.argument, scope) : undefined);
      case 'ThrowStatement':
        throw evaluate(node.argument, scope);
      case 'TryStatement': {
        try {
          execute(node.block, scope);
        } catch (err) {
          if (err instanceof BreakSignal || err instanceof ContinueSignal || err instanceof ReturnSignal) throw err;
          if (err instanceof ScriptTimeoutError) throw err;
          if (node.handler) {
            const catchScope = new Scope(scope);
            if (node.handler.param) {
              const message = err instanceof Error ? { message: err.message } : err;
              bindPattern(node.handler.param, message, catchScope, 'let');
            }
            execute(node.handler.body, catchScope);
          }
        } finally {
          if (node.finalizer) execute(node.finalizer, scope);
        }
        return;
      }
      case 'SwitchStatement': {
        const disc = evaluate(node.discriminant, scope);
        const switchScope = new Scope(scope);
        let matched = false;
        try {
          for (const caseNode of node.cases) {
            if (!matched) {
              if (caseNode.test === null) matched = true;
              else if (evaluate(caseNode.test, switchScope) === disc) matched = true;
            }
            if (matched) {
              for (const stmt of caseNode.consequent) execute(stmt, switchScope);
            }
          }
        } catch (signal) {
          if (!(signal instanceof BreakSignal)) throw signal;
        }
        return;
      }
      case 'LabeledStatement':
        // Labels are rare in generated DSL code; run body, swallow matching label signals.
        try {
          execute(node.body, scope);
        } catch (signal) {
          if (signal instanceof BreakSignal && signal.label === node.label.name) return;
          throw signal;
        }
        return;
      default:
        throw new Error(`Unsupported statement: ${node.type}`);
    }
  }

  function assignTo(target: any, value: any, scope: Scope) {
    if (target.type === 'Identifier') {
      scope.set(target.name, value);
    } else if (target.type === 'MemberExpression') {
      const obj = evaluate(target.object, scope);
      const prop = target.computed ? evaluate(target.property, scope) : target.property.name;
      setMember(obj, prop, value);
    } else {
      throw new Error(`Unsupported assignment target: ${target.type}`);
    }
  }

  function evaluate(node: any, scope: Scope): any {
    tick();
    switch (node.type) {
      case 'Literal':
        if (node.regex) throw new Error('Regular expression literals are not supported');
        return node.value;
      case 'TemplateLiteral': {
        let out = '';
        node.quasis.forEach((quasi: any, i: number) => {
          out += quasi.value.cooked ?? '';
          if (i < node.expressions.length) out += String(evaluate(node.expressions[i], scope));
        });
        return out;
      }
      case 'Identifier':
        return scope.get(node.name);
      case 'ArrayExpression': {
        const arr: any[] = [];
        for (const el of node.elements) {
          if (el === null) { arr.length++; continue; }
          if (el.type === 'SpreadElement') {
            const spread = evaluate(el.argument, scope);
            if (!Array.isArray(spread) && typeof spread !== 'string') {
              throw new Error('Spread only supports arrays and strings');
            }
            for (const item of spread as any[]) arr.push(item);
          } else {
            arr.push(evaluate(el, scope));
          }
        }
        return arr;
      }
      case 'ObjectExpression': {
        const obj: Record<string, any> = {};
        for (const prop of node.properties) {
          if (prop.type === 'SpreadElement') {
            const spread = evaluate(prop.argument, scope);
            if (isPlainObject(spread)) {
              for (const k of Object.keys(spread)) {
                if (!FORBIDDEN_PROPS.has(k)) obj[k] = spread[k];
              }
            }
            continue;
          }
          if (prop.kind !== 'init') throw new Error('Getters/setters are not supported');
          const key = prop.computed
            ? String(evaluate(prop.key, scope))
            : (prop.key.type === 'Identifier' ? prop.key.name : String(prop.key.value));
          assertPropAllowed(key);
          obj[key] = evaluate(prop.value, scope);
        }
        return obj;
      }
      case 'ArrowFunctionExpression':
      case 'FunctionExpression':
        if (node.async || node.generator) throw new Error('async/generator functions are not supported');
        return makeFunction(node, scope);
      case 'UnaryExpression': {
        if (node.operator === 'typeof' && node.argument.type === 'Identifier' && !scope.has(node.argument.name)) {
          return 'undefined';
        }
        if (node.operator === 'delete') {
          if (node.argument.type !== 'MemberExpression') return true;
          const obj = evaluate(node.argument.object, scope);
          const prop = node.argument.computed
            ? evaluate(node.argument.property, scope)
            : node.argument.property.name;
          const name = assertPropAllowed(prop);
          if (isPlainObject(obj) && !Object.isFrozen(obj)) {
            delete obj[name];
            return true;
          }
          throw new Error('delete is only allowed on plain objects');
        }
        const arg = evaluate(node.argument, scope);
        switch (node.operator) {
          case '-': return -arg;
          case '+': return +arg;
          case '!': return !arg;
          case '~': return ~arg;
          case 'typeof': return typeof arg;
          case 'void': return undefined;
          default: throw new Error(`Unsupported unary operator: ${node.operator}`);
        }
      }
      case 'UpdateExpression': {
        const old = node.argument.type === 'Identifier'
          ? scope.get(node.argument.name)
          : getMember(
              evaluate(node.argument.object, scope),
              node.argument.computed ? evaluate(node.argument.property, scope) : node.argument.property.name,
            );
        const next = node.operator === '++' ? old + 1 : old - 1;
        assignTo(node.argument, next, scope);
        return node.prefix ? next : old;
      }
      case 'BinaryExpression': {
        if (node.operator === 'in') {
          const key = assertPropAllowed(evaluate(node.left, scope));
          const obj = evaluate(node.right, scope);
          if (isPlainObject(obj)) return Object.prototype.hasOwnProperty.call(obj, key);
          if (Array.isArray(obj)) return Number(key) >= 0 && Number(key) < obj.length;
          throw new Error('"in" is only supported on plain objects and arrays');
        }
        if (node.operator === 'instanceof') throw new Error('instanceof is not supported');
        const l = evaluate(node.left, scope);
        const r = evaluate(node.right, scope);
        switch (node.operator) {
          case '+': return l + r;
          case '-': return l - r;
          case '*': return l * r;
          case '/': return l / r;
          case '%': return l % r;
          case '**': return l ** r;
          case '==': return l == r; // eslint-disable-line eqeqeq
          case '!=': return l != r; // eslint-disable-line eqeqeq
          case '===': return l === r;
          case '!==': return l !== r;
          case '<': return l < r;
          case '<=': return l <= r;
          case '>': return l > r;
          case '>=': return l >= r;
          case '&': return l & r;
          case '|': return l | r;
          case '^': return l ^ r;
          case '<<': return l << r;
          case '>>': return l >> r;
          case '>>>': return l >>> r;
          default: throw new Error(`Unsupported binary operator: ${node.operator}`);
        }
      }
      case 'LogicalExpression': {
        const l = evaluate(node.left, scope);
        if (node.operator === '&&') return l ? evaluate(node.right, scope) : l;
        if (node.operator === '||') return l ? l : evaluate(node.right, scope);
        if (node.operator === '??') return l ?? evaluate(node.right, scope);
        throw new Error(`Unsupported logical operator: ${node.operator}`);
      }
      case 'AssignmentExpression': {
        let value: any;
        if (node.operator === '=') {
          value = evaluate(node.right, scope);
        } else {
          const current = node.left.type === 'Identifier'
            ? scope.get(node.left.name)
            : getMember(
                evaluate(node.left.object, scope),
                node.left.computed ? evaluate(node.left.property, scope) : node.left.property.name,
              );
          const rhs = () => evaluate(node.right, scope);
          switch (node.operator) {
            case '+=': value = current + rhs(); break;
            case '-=': value = current - rhs(); break;
            case '*=': value = current * rhs(); break;
            case '/=': value = current / rhs(); break;
            case '%=': value = current % rhs(); break;
            case '**=': value = current ** rhs(); break;
            case '&=': value = current & rhs(); break;
            case '|=': value = current | rhs(); break;
            case '^=': value = current ^ rhs(); break;
            case '<<=': value = current << rhs(); break;
            case '>>=': value = current >> rhs(); break;
            case '>>>=': value = current >>> rhs(); break;
            case '&&=': value = current ? rhs() : current; break;
            case '||=': value = current ? current : rhs(); break;
            case '??=': value = current ?? rhs(); break;
            default: throw new Error(`Unsupported assignment operator: ${node.operator}`);
          }
        }
        assignTo(node.left, value, scope);
        return value;
      }
      case 'ConditionalExpression':
        return evaluate(node.test, scope) ? evaluate(node.consequent, scope) : evaluate(node.alternate, scope);
      case 'CallExpression': {
        const args: any[] = [];
        for (const argNode of node.arguments) {
          if (argNode.type === 'SpreadElement') {
            const spread = evaluate(argNode.argument, scope);
            if (!Array.isArray(spread) && typeof spread !== 'string') {
              throw new Error('Spread only supports arrays and strings');
            }
            for (const item of spread as any[]) args.push(item);
          } else {
            args.push(evaluate(argNode, scope));
          }
        }
        if (node.callee.type === 'MemberExpression') {
          const obj = evaluate(node.callee.object, scope);
          if (node.optional && (obj === null || obj === undefined)) return undefined;
          const prop = node.callee.computed
            ? evaluate(node.callee.property, scope)
            : node.callee.property.name;
          const method = getMember(obj, prop);
          if (node.callee.optional && (method === null || method === undefined)) return undefined;
          return callFunction(method, obj, args, `${String(prop)}`);
        }
        const fn = evaluate(node.callee, scope);
        if (node.optional && (fn === null || fn === undefined)) return undefined;
        const desc = node.callee.type === 'Identifier' ? node.callee.name : 'expression';
        return callFunction(fn, undefined, args, desc);
      }
      case 'MemberExpression': {
        const obj = evaluate(node.object, scope);
        if (node.optional && (obj === null || obj === undefined)) return undefined;
        const prop = node.computed ? evaluate(node.property, scope) : node.property.name;
        return getMember(obj, prop);
      }
      case 'ChainExpression':
        return evaluate(node.expression, scope);
      case 'SequenceExpression': {
        let result;
        for (const expr of node.expressions) result = evaluate(expr, scope);
        return result;
      }
      case 'NewExpression':
        throw new Error('"new" is not supported in build code');
      case 'ThisExpression':
        throw new Error('"this" is not supported in build code');
      case 'AwaitExpression':
        throw new Error('await is not supported in build code');
      case 'TaggedTemplateExpression':
        throw new Error('Tagged templates are not supported in build code');
      default:
        throw new Error(`Unsupported expression: ${node.type}`);
    }
  }

  executeBlock(ast.body, globalScope);
}
