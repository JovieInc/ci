// Pure dependency parsers and comparisons. Intentionally no YAML/npm dependencies.
const SEMVER = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/;
const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const entries = (o) => Object.entries(o ?? {});
const scalar = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2');

export function versionOf(value) {
  const v = String(value ?? '').split(/[(_]/)[0];
  return SEMVER.test(v) ? v : null;
}
export function majorKey(version) {
  const m = SEMVER.exec(version ?? '');
  return !m ? null : m[1] !== '0' ? m[1] : m[2] !== '0' ? `0.${m[2]}` : `0.0.${m[3]}`;
}

// Only the mapping subset used by pnpm is needed: indentation, quoted keys,
// scalar values and inline importer records. Ignore sequences (workspace globs).
function mapping(line) {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === quote && line[i - 1] !== '\\') quote = ''; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === ':' && (i + 1 === line.length || /\s/.test(line[i + 1])))
      return [scalar(line.slice(0, i)), line.slice(i + 1).trim().replace(/\s+#.*$/, '')];
  }
  return null;
}
export function pnpmMapping(text) {
  const root = Object.create(null);
  const stack = [{ indent: -1, node: root }];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || /^\s*(#|- )/.test(line)) continue;
    const row = mapping(line.trim());
    if (!row) continue;
    const indent = line.length - line.trimStart().length;
    while (stack.at(-1).indent >= indent) stack.pop();
    const [key, value] = row;
    let node = scalar(value);
    if (!value || value === '{}') node = Object.create(null);
    else if (value.startsWith('{') && value.endsWith('}')) {
      node = Object.fromEntries(value.slice(1, -1).split(/,\s*/).map(mapping).filter(Boolean)
        .map(([k, v]) => [k, scalar(v)]));
    }
    stack.at(-1).node[key] = node;
    if (typeof node === 'object') stack.push({ indent, node });
  }
  return root;
}

function packageKey(key) {
  const clean = key.replace(/^\//, '').split('(')[0];
  const m = /^(.*?)(?:@|\/)(\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?)(?:_.*)?$/.exec(clean);
  return m && /^(?:@[^/@:\s]+\/)?[^/@:\s]+$/.test(m[1]) && majorKey(m[2]) ? { name: m[1], version: m[2] } : null;
}
export function directDependencies(manifest) {
  return Object.assign({}, ...SECTIONS.map((s) => manifest?.[s] ?? {}));
}
export function parseLockfile(path, text) {
  if (text == null) return { resolutions: [], importers: {}, overrides: {} };
  const resolutions = new Map();
  const importers = {};
  const add = (name, version) => {
    const v = versionOf(version);
    if (v) resolutions.set(`${name}@${v}`, { name, version: v });
  };
  if (path.endsWith('pnpm-lock.yaml')) {
    const doc = pnpmMapping(text);
    for (const block of [doc.packages, doc.snapshots])
      for (const [key] of entries(block)) { const p = packageKey(key); if (p) add(p.name, p.version); }
    for (const [id, importer] of entries(doc.importers ?? { '.': doc })) {
      importers[id] = {};
      for (const [name, dep] of entries(directDependencies(importer))) {
        const specifier = typeof dep === 'object' ? dep.specifier : doc.specifiers?.[name];
        const version = typeof dep === 'object' ? dep.version : dep;
        importers[id][name] = { specifier, version: versionOf(version) ?? version };
      }
    }
    return { resolutions: [...resolutions.values()], importers, overrides: doc.overrides ?? {} };
  }
  const doc = JSON.parse(text);
  for (const [key, pkg] of entries(doc.packages)) {
    if (key.includes('node_modules/')) add(pkg.name ?? key.slice(key.lastIndexOf('node_modules/') + 13), pkg.version);
    else {
      const deps = directDependencies(pkg);
      importers[key || '.'] = Object.fromEntries(entries(deps).map(([name, specifier]) => {
        const installed = doc.packages[`${key ? `${key}/` : ''}node_modules/${name}`] ?? doc.packages[`node_modules/${name}`];
        return [name, { specifier, version: installed?.version }];
      }));
    }
  }
  if (!doc.packages) {
    importers['.'] = {};
    const walk = (deps, direct = false) => {
      for (const [name, dep] of entries(deps)) {
        add(name, dep.version);
        if (direct) importers['.'][name] = { specifier: dep.version, version: dep.version };
        walk(dep.dependencies);
      }
    };
    walk(doc.dependencies, true);
  }
  return { resolutions: [...resolutions.values()], importers, overrides: {} };
}

export function resolutionDiff(base, head) {
  const old = new Set(base.map((p) => `${p.name}@${p.version}`));
  const versions = new Map();
  for (const p of base) versions.set(p.name, [...(versions.get(p.name) ?? []), p.version]);
  const added = head.filter((p) => !old.has(`${p.name}@${p.version}`));
  const majors = added.filter((p) => versions.has(p.name) &&
    !versions.get(p.name).some((v) => majorKey(v) === majorKey(p.version)))
    .map((p) => ({ ...p, from: [...new Set(versions.get(p.name))].sort() }));
  return { added, majors };
}
export function newDirectDependencies(base, head) {
  return entries(head).flatMap(([importer, deps]) => entries(deps)
    .filter(([name]) => !Object.hasOwn(base[importer] ?? {}, name))
    .map(([name, dep]) => ({ importer, name, ...dep })));
}
export function levenshtein(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++) next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (a[i] !== b[j])));
    row = next;
  }
  return row[b.length];
}
export function declarations(body = '') {
  return body.split(/\r?\n/).flatMap((line) => {
    const m = /(?:^|\s)(Dependency-Upgrade|Dependency-Add):\s*(.*?)\s*$/.exec(line.replace(/`/g, ''));
    if (!m) return [];
    const parts = m[1] === 'Dependency-Add' ? /^(\S+)$/.exec(m[2]) : /^(\S+)\s+(\S+)\s*->\s*(\S+)$/.exec(m[2]);
    return [{ kind: m[1], name: parts?.[1], from: parts?.[2], to: parts?.[3], raw: m[0].trim() }];
  });
}
export function isLoose(value) {
  const s = String(value).trim();
  if (/^(workspace|catalog|link|file):/.test(s) || SEMVER.test(s.replace(/^=\s*/, ''))) return false;
  const alias = /^npm:(?:@[^/]+\/)?[^@]+@(.+)$/.exec(s);
  return alias ? !SEMVER.test(alias[1]) : true;
}
export function manifestSpecifiers(path, text) {
  if (text == null) return {};
  const doc = path.endsWith('package.json') ? JSON.parse(text) : pnpmMapping(text);
  const out = {};
  const flatten = (value, key) => {
    if (typeof value === 'object' && value !== null) for (const [k, v] of entries(value)) flatten(v, `${key}/${k}`);
    else out[key] = String(value);
  };
  if (path.endsWith('package.json')) {
    for (const section of SECTIONS) flatten(doc[section] ?? {}, section);
    flatten(doc.pnpm?.overrides ?? {}, 'pnpm.overrides');
    flatten(doc.resolutions ?? {}, 'resolutions');
  }
  flatten(doc.overrides ?? {}, 'overrides');
  return out;
}
export function looseDiff(base, head) {
  const remaining = entries(head).filter(([, v]) => isLoose(v));
  // Ratchet: only a NEW loose entry, or an exact one turned loose, fails. An existing loose
  // entry may change value (Dependabot `increase` rewrites ^1.70.0 -> ^1.72.0); debt never grows.
  return { count: remaining.length, added: remaining.filter(([k]) => !(k in base && isLoose(base[k]))) };
}
