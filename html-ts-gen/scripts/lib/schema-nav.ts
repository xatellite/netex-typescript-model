/** Schema navigation: inheritance walking, property flattening, inlining. */

import type { Def, NetexLibrary, FlatProperty, InheritanceNode } from "./types.js";
import { deref, canonicalPropName } from "./util.js";
import { resolveType, classifySchema, defRole } from "./classify.js";

/** Base types inherited by every NeTEx entity — infrastructure clutter (id, version, status, etc.). */
export const OMNIPRESENT_DEFS = new Set([
  "EntityStructure",
  "EntityInVersionStructure",
]);

/** Omnipresent props retained even when omni-filtering — required for valid NeTEx XML. */
export const ESSENTIAL_OMNI_PROPS = new Set(["$id", "$version"]);

/**
 * Build a merged exclusion set from explicit prop names + optional omni filtering.
 * Shared by CLI (ts-gen) and browser (schema-viewer-host-app).
 */
export function buildExclSet(
  allProps: FlatProperty[],
  opts?: { omni?: boolean; explicit?: Set<string> },
): Set<string> | undefined {
  const excl = new Set(opts?.explicit ?? []);
  if (opts?.omni) {
    const kept = new Set(
      allProps.filter((p) => !OMNIPRESENT_DEFS.has(p.origin)).map((p) => p.prop[1]),
    );
    for (const p of allProps)
      if (!kept.has(p.prop[1]) && !ESSENTIAL_OMNI_PROPS.has(p.prop[1])) excl.add(p.prop[1]);
  }
  return excl.size > 0 ? excl : undefined;
}

/**
 * Expose abstract XML element slots as concrete element-name properties.
 * A repeated head becomes one array per concrete tag, matching XMLBuilder's
 * object shape. This preserves element identity, but not interleaving order
 * between different concrete tags or exclusivity of single-item choices.
 */
function expandSubstitutionProperties(netexLibrary: NetexLibrary, props: FlatProperty[]): FlatProperty[] {
  function members(name: string, visited = new Set<string>()): string[] {
    if (visited.has(name)) return [];
    visited.add(name);
    const def = netexLibrary[name];
    if (!def) return [];
    if (defRole(def) !== "abstract") return [name];
    return (def["x-netex-sg-members"] ?? []).flatMap((m: string) => members(m, visited));
  }

  return props.flatMap((p) => {
    if (p.prop[1].startsWith("$")) return [p];
    const shape = classifySchema(p.schema);
    if (shape.kind !== "ref" && shape.kind !== "refArray") return [p];
    if (defRole(netexLibrary[shape.target]) !== "abstract") return [p];
    const concrete = members(shape.target);
    if (concrete.length === 0) return [p];
    // Reference heads have a separate collapse representation. This expansion
    // handles contained objects; retain the existing reference API.
    if (concrete.every(name => defRole(netexLibrary[name]) === "reference")) return [p];
    return concrete.map((name) => {
      const ref = "#/definitions/" + name;
      const schema = shape.kind === "refArray"
        ? { ...p.schema, items: { ...p.schema.items, $ref: ref } }
        : { ...p.schema, $ref: ref };
      return { ...p, prop: [name, name] as [string, string], schema, type: resolveType(schema) };
    });
  });
}

/** Flatten inheritance and expand abstract element properties to concrete tags. */
export function flattenAllOf(
  netexLibrary: NetexLibrary,
  name: string,
  opts?: { excludeOmni?: boolean },
): FlatProperty[] {
  const results: FlatProperty[] = [];
  const visited = new Set<string>();

  function walk(n: string): void {
    if (visited.has(n)) return;
    visited.add(n);
    const def = netexLibrary[n];
    if (!def) return;
    if (def.$ref) {
      walk(deref(def.$ref));
      return;
    }
    if (def.allOf) {
      for (const entry of def.allOf) {
        if (entry.$ref) {
          walk(deref(entry.$ref));
        } else if (entry.properties) {
          for (const [pn, pv] of Object.entries(entry.properties) as [string, Def][]) {
            results.push({
              prop: [pn, canonicalPropName(pn, pv)],
              type: resolveType(pv),
              desc: pv.description || "",
              origin: n,
              schema: pv,
            });
          }
        }
      }
    }
    if (def.properties) {
      for (const [pn, pv] of Object.entries(def.properties) as [string, Def][]) {
        if (!results.some((r) => r.prop[0] === pn && r.origin === n)) {
          results.push({
            prop: [pn, canonicalPropName(pn, pv)],
            type: resolveType(pv),
            desc: pv.description || "",
            origin: n,
            schema: pv,
          });
        }
      }
    }
  }
  walk(name);
  const expanded = expandSubstitutionProperties(netexLibrary, results);
  return opts?.excludeOmni ? expanded.filter((r) => !OMNIPRESENT_DEFS.has(r.origin)) : expanded;
}

/** Collect all required property names from the inheritance chain. */
export function collectRequired(
  netexLibrary: NetexLibrary,
  name: string,
  opts?: { excludeOmni?: boolean },
): Set<string> {
  const req = new Set<string>();
  const visited = new Set<string>();

  function walk(n: string): void {
    if (visited.has(n)) return;
    visited.add(n);
    const def = netexLibrary[n];
    if (!def) return;
    if (def.$ref) {
      walk(deref(def.$ref));
      return;
    }
    if (def.allOf) {
      for (const entry of def.allOf) {
        if (entry.$ref) walk(deref(entry.$ref));
        if (entry.required) entry.required.forEach((r: string) => req.add(r));
      }
    }
    if (def.required) def.required.forEach((r: string) => req.add(r));
  }
  walk(name);
  if (opts?.excludeOmni) {
    for (const omni of OMNIPRESENT_DEFS) {
      const def = netexLibrary[omni];
      if (def?.required) def.required.forEach((r: string) => req.delete(r));
      for (const ao of def?.allOf ?? []) {
        if (ao.required) ao.required.forEach((r: string) => req.delete(r));
      }
    }
  }
  return req;
}

/**
 * Walk the allOf/$ref chain to build a bottom-up inheritance list.
 *
 * Each entry contains the type name and properties defined directly on that type
 * (not inherited). The chain is ordered root-first (base class at index 0,
 * the requested type at the end).
 *
 * Used by the Graph tab to render the SVG inheritance diagram.
 */
export function buildInheritanceChain(netexLibrary: NetexLibrary, name: string): InheritanceNode[] {
  const chain: InheritanceNode[] = [];
  const visited = new Set<string>();

  function walk(n: string): void {
    if (visited.has(n)) return;
    visited.add(n);
    const def = netexLibrary[n];
    if (!def) return;
    if (def.$ref) {
      walk(deref(def.$ref));
      return;
    }
    let parent: string | null = null;
    const ownProps: InheritanceNode["ownProps"] = [];
    if (def.allOf) {
      for (const entry of def.allOf as Def[]) {
        if (entry.$ref) parent = deref(entry.$ref);
        else if (entry.properties) {
          for (const [k, v] of Object.entries(entry.properties))
            ownProps.push({ name: k, schema: v as Record<string, unknown> });
        }
      }
    }
    if (def.properties) {
      for (const [k, v] of Object.entries(def.properties) as [string, Def][]) {
        if (!ownProps.some((p) => p.name === k)) ownProps.push({ name: k, schema: v });
      }
    }
    if (parent) walk(parent);
    chain.push({ name: n, ownProps });
  }
  walk(name);
  return chain;
}

