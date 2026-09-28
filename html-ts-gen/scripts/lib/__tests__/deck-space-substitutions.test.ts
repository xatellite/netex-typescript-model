import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { XMLBuilder } from "fast-xml-parser";
import { validateWithXmllint, wrapInPublicationDelivery, CORE } from "./test-helpers.js";
import { generateInterface, generateSubTypesBlock } from "../codegens.js";
import { flattenAllOf } from "../schema-nav.js";
import { makeInlineCodeBlock } from "../to-xml-shape.js";
import { loadNetexLibrary } from "../loader.js";
import type { NetexLibrary } from "../types.js";

const lib = loadNetexLibrary();

function mapping(library: NetexLibrary, name: string) {
  const code = makeInlineCodeBlock(library, name, { html: false, typed: false });
  return new Function(code.replace(/^export /gm, "") + `\nreturn ${name[0].toLowerCase() + name.slice(1)}ToXmlShape;`)();
}

export const deckPlan = {
  $id: "test:DeckPlan:1", $version: "1",
  decks: { Deck: [{
    $id: "test:Deck:1", $version: "1",
    deckSpaces: {
      PassengerSpace: [{
        $id: "test:PassengerSpace:1", $version: "1",
        PassengerSpaceType: "seatingArea",
        passengerSpots: { PassengerSpot: [
          { $id: "test:PassengerSpot:1", $version: "1", Label: [{ value: "1A" }], HasPower: true },
          { $id: "test:PassengerSpot:2", $version: "1", Label: [{ value: "1B" }], HasPower: false },
        ] },
      }],
      OtherDeckSpace: [{ $id: "test:OtherDeckSpace:1", $version: "1", Name: [{ value: "Driver cab" }], PublicUse: false }],
    },
  }] },
};

describe("DeckPlan concrete space types", () => {
  it("type-checks a whole deckplan with both spaces and two seats", () => {
    const dir = mkdtempSync(join(tmpdir(), "netex-space-types-"));
    try {
      const types = generateInterface(lib, "DeckPlan", { html: false }).text + "\n" + generateSubTypesBlock(lib, "DeckPlan", { html: false });
      const file = join(dir, "model.ts");
      writeFileSync(file, types + "\nconst plan: DeckPlan = " + JSON.stringify(deckPlan) + ";\n");
      const program = ts.createProgram([file], { noEmit: true, strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, types: [] });
      const diagnostics = ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      expect(diagnostics).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exports the mixed deckplan as XSD-valid XML", { timeout: 60_000 }, () => {
    const shape = mapping(lib, "DeckPlan")(deckPlan);
    const xml = new XMLBuilder({ ignoreAttributes: false }).build({ DeckPlan: shape });
    const full = wrapInPublicationDelivery(CORE.find(e => e.name === "DeckPlan")!, xml);
    const result = validateWithXmllint(full);
    expect(result.valid, result.stderr).toBe(true);
    expect(xml).toContain("<PassengerSpace ");
    expect(xml).toContain("<OtherDeckSpace ");
  });

  it("includes passenger spaces, other spaces and seats when only DeckPlan is requested", () => {
    const code = generateInterface(lib, "DeckPlan", { html: false }).text + generateSubTypesBlock(lib, "DeckPlan", { html: false });
    expect(code).toContain("PassengerSpace?: PassengerSpace_VersionStructure[];");
    expect(code).toContain("OtherDeckSpace?: DeckSpace_VersionStructure[];");
    expect(code).toContain("export interface PassengerSpot_VersionStructure");
    expect(code).not.toContain("DeckSpace_Dummy?:");
  });

  it("converts both concrete tags and nested seat attributes through the root mapping", () => {
    const result = mapping(lib, "DeckPlan")(deckPlan);
    const deck = result.decks.Deck[0];
    expect(deck["@_id"]).toBe("test:Deck:1");
    const spaces = deck.deckSpaces;
    expect(spaces.PassengerSpace).toHaveLength(1);
    expect(spaces.OtherDeckSpace).toHaveLength(1);
    expect(spaces.OtherDeckSpace[0].PublicUse).toBe("false");
    expect(spaces.OtherDeckSpace[0].Name).toEqual([{ "#text": "Driver cab" }]);
    const seats = spaces.PassengerSpace[0].passengerSpots.PassengerSpot;
    expect(seats.map((s: any) => s["@_id"])).toEqual(["test:PassengerSpot:1", "test:PassengerSpot:2"]);
    expect(seats.map((s: any) => s.HasPower)).toEqual(["true", "false"]);
    expect(JSON.stringify(result)).not.toContain('"$id"');
    expect(JSON.stringify(result)).not.toContain("DeckSpace_Dummy");
    expect(deckPlan.decks.Deck[0].$id).toBe("test:Deck:1");
  });

  it("preserves legacy empty collection sentinels", () => {
    expect(mapping(lib, "DeckPlan")({ decks: [] }).decks).toEqual([]);
  });

  it("exports a passenger space directly without relabelling it as a cab", () => {
    const result = mapping(lib, "deckSpaces_RelStructure")(deckPlan.decks.Deck[0].deckSpaces);
    expect(result.PassengerSpace[0]["@_id"]).toBe("test:PassengerSpace:1");
    expect(result.OtherDeckSpace[0]["@_id"]).toBe("test:OtherDeckSpace:1");
  });
});

const small: NetexLibrary = {
  Holder: { properties: { Head: { type: "array", items: { $ref: "#/definitions/Head" } }, Label: { type: "string" } } },
  Head: { "x-netex-role": "abstract", "x-netex-sg-members": ["Nested", "B"] },
  Nested: { "x-netex-role": "abstract", "x-netex-sg-members": ["A", "B", "Head"] },
  A: { properties: { Value: { type: "string" } } },
  B: { properties: { Value: { type: "number" } } },
};

describe("substitution expansion", () => {
  it("expands nested members, deduplicates alternatives, guards cycles and keeps multiplicity", () => {
    const props = flattenAllOf(small, "Holder");
    expect(props.map(p => p.prop[1])).toEqual(["A", "B", "Label"]);
    expect(props.slice(0, 2).map(p => p.schema.items.$ref)).toEqual(["#/definitions/A", "#/definitions/B"]);
    expect(small.Holder.properties.Head.items.$ref).toBe("#/definitions/Head");
  });
  it("does not replace abstract reference properties used by reference collapse", () => {
    const props = flattenAllOf(lib, "Vehicle");
    expect(props.some(p => p.prop[1] === "TransportOrganisationRef")).toBe(true);
  });
  it("keeps a single element single", () => {
    const single = { ...small, Holder: { properties: { Head: { $ref: "#/definitions/Head" } } } };
    expect(flattenAllOf(single, "Holder").map(p => p.schema.$ref)).toEqual(["#/definitions/A", "#/definitions/B"]);
  });
});
