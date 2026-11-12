import { applyEdits, getNodeValue, modify, parseTree, type Node as JsonNode, type ParseError } from 'jsonc-parser';
import { parseTOML, getStaticTOMLValue, type AST } from 'toml-eslint-parser';
import { isDeepStrictEqual } from 'node:util';
import type { SetupClient } from './clients.js';
import { SetupError } from './error.js';

type RecordValue = Record<string, unknown>;
export const object = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
const invalid = () => new SetupError('客户端配置格式无效、存在重复键或配置结构不受支持；原文件未修改。');
export const at = (value: RecordValue, path: readonly string[]): unknown => {
  let current: unknown = value;
  for (const key of path) { if (!object(current) || !Object.hasOwn(current, key)) return undefined; current = current[key]; }
  return current;
};
const duplicateMembers = (node: JsonNode): boolean => {
  if (node.type === 'object') {
    const names = (node.children ?? []).map((child) => child.children?.[0]?.value);
    if (new Set(names).size !== names.length) return true;
  }
  return (node.children ?? []).some(duplicateMembers);
};
const plainJson = (value: unknown): unknown => Array.isArray(value) ? value.map(plainJson)
  : object(value) ? Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, plainJson(nested)])) : value;
export function parseDocument(text: string, client: SetupClient): RecordValue {
  try {
    if (!text.replace(/^\uFEFF/, '').trim()) return {};
    if (client.format === 'toml') {
      const value: unknown = getStaticTOMLValue(parseTOML(text.replace(/^\uFEFF/, ''), { tomlVersion: '1.0.0' }));
      if (!object(value)) throw invalid();
      return value;
    }
    const errors: ParseError[] = [];
    const tree = parseTree(text.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: client.format === 'jsonc', disallowComments: client.format !== 'jsonc', allowEmptyContent: true });
    if (errors.length || (tree && (tree.type !== 'object' || duplicateMembers(tree)))) throw invalid();
    return tree ? plainJson(getNodeValue(tree)) as RecordValue : {};
  } catch { throw invalid(); }
}

export function serversPath(document: RecordValue, client: SetupClient): string[] {
  const base = client.dialect === 'codex' ? ['mcp_servers'] : client.dialect === 'vscode' ? ['servers'] : client.dialect === 'opencode' ? ['mcp'] : ['mcpServers'];
  const table = at(document, base);
  if (table !== undefined && !object(table)) throw invalid();
  if (client.dialect === 'opencode' && object(table) && Object.hasOwn(table, 'servers')) {
    const nested = table.servers;
    if (!object(nested) || Object.hasOwn(nested, 'command') || Object.hasOwn(nested, 'type')) throw invalid();
    return [...base, 'servers'];
  }
  return base;
}

function tomlValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`;
  if (object(value)) return `{ ${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)} = ${tomlValue(v)}`).join(', ')} }`;
  throw invalid();
}
const same = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((key, i) => key === right[i]);
const prefix = (left: readonly string[], right: readonly string[]) => left.length <= right.length && left.every((key, i) => key === right[i]);
const keyParts = (node: AST.TOMLKey): string[] => node.keys.map((part) => part.type === 'TOMLBare' ? part.name : part.value);

/** Patch a TOML leaf by AST ranges, never reserializing unrelated settings. */
function setTomlLeaf(source: string, path: string[], value: unknown): string {
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
  const text = source.slice(bom.length);
  const ast = parseTOML(text, { tomlVersion: '1.0.0' });
  let exact: AST.TOMLKeyValue | undefined;
  let inline: { node: AST.TOMLInlineTable; path: string[] } | undefined;
  let table: AST.TOMLTable | undefined;
  const visit = (body: (AST.TOMLKeyValue | AST.TOMLTable)[], base: string[]) => {
    for (const node of body) {
      if (node.type === 'TOMLTable') {
        const resolved = node.resolvedKey;
        if (resolved.some((key) => typeof key !== 'string')) continue;
        const keys = resolved as string[];
        if (node.kind === 'standard' && prefix(keys, path) && (!table || keys.length > table.resolvedKey.length)) table = node;
        visit(node.body, keys);
      } else {
        const keys = [...base, ...keyParts(node.key)];
        if (same(keys, path)) exact = node;
        if (node.value.type === 'TOMLInlineTable') {
          if (prefix(keys, path) && (!inline || keys.length > inline.path.length)) inline = { node: node.value, path: keys };
          visit(node.value.body, keys);
        }
      }
    }
  };
  visit(ast.body[0].body, []);
  const encoded = tomlValue(value);
  if (exact) return bom + text.slice(0, exact.value.range[0]) + encoded + text.slice(exact.value.range[1]);
  if (inline) {
    const point = inline.node.range[1] - 1;
    const assignment = `${path.slice(inline.path.length).map((key) => JSON.stringify(key)).join('.')} = ${encoded}`;
    return bom + text.slice(0, point) + `${inline.node.body.length ? ', ' : ''}${assignment}` + text.slice(point);
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const base = table ? table.resolvedKey.length : 0;
  const assignment = `${path.slice(base).map((key) => JSON.stringify(key)).join('.')} = ${encoded}${eol}`;
  if (!table) return bom + assignment + text;
  const newline = text.indexOf('\n', table.key.range[1]);
  const point = newline < 0 ? text.length : newline + 1;
  return bom + text.slice(0, point) + (newline < 0 ? eol : '') + assignment + text.slice(point);
}

export function patchEntry(source: string, client: SetupClient, path: string[], entry: RecordValue): string {
  const before = parseDocument(source, client);
  const previous = at(before, path);
  if (previous !== undefined && !object(previous)) throw invalid();
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
  let text = source.slice(bom.length);
  const patch = (keys: string[], value: unknown) => {
    if (isDeepStrictEqual(at(before, keys), value)) return;
    // Environment tables may be declared separately in TOML. Patch their
    // leaves to retain the table, comments, and unrelated environment values.
    if (client.format === 'toml' && object(value) && Object.keys(value).length) {
      for (const [key, nested] of Object.entries(value)) patch([...keys, key], nested);
      return;
    }
    if (client.format === 'toml') text = setTomlLeaf(text, keys, value);
    else {
      const tree = parseTree(text, [], { allowTrailingComma: true });
      if (!tree) {
        // Keep a JSONC file's standalone comments and optional BOM.
        const blank = text.replace(/^\uFEFF/, '').trim();
        text = blank ? text.trimEnd() + '\n{}\n' : (text.startsWith('\uFEFF') ? '\uFEFF' : '') + '{}\n';
      }
      text = applyEdits(text, modify(text, keys, value, { formattingOptions: {
        insertSpaces: !/^\t/m.test(source), tabSize: 2, eol: source.includes('\r\n') ? '\r\n' : '\n',
      } }));
    }
  };
  for (const [key, value] of Object.entries(entry)) patch([...path, key], value);
  const expected = structuredClone(before);
  let current = expected;
  for (const key of path) {
    if (!Object.hasOwn(current, key)) Object.defineProperty(current, key, { value: {}, writable: true, enumerable: true, configurable: true });
    if (!object(current[key])) throw invalid();
    current = current[key];
  }
  for (const [key, value] of Object.entries(entry)) Object.defineProperty(current, key, { value, writable: true, enumerable: true, configurable: true });
  if (!isDeepStrictEqual(parseDocument(text, client), expected)) throw new SetupError('配置合并校验失败；原文件未修改。');
  return bom + text;
}
