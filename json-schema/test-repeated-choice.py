#!/usr/bin/env python3
"""Check collection shape in freshly generated schemas; no extra dependencies.

Usage: python3 test-repeated-choice.py <fixture-schema> <netex-schema>
Exit 1 means collection shape has regressed.
It checks array representation, not all XSD choice/order/count semantics.
"""
import json
import sys


def properties(schema, name):
    """Resolve properties through the converter's references and allOf wrappers."""
    def visit(node, seen):
        result = dict(node.get("properties", {}))
        ref = node.get("$ref")
        if ref and ref not in seen:
            result.update(visit(schema["definitions"][ref.split("/")[-1]], seen | {ref}))
        for part in node.get("allOf", []):
            result.update(visit(part, seen))
        return result
    return visit(schema["definitions"][name], set())


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    with open(sys.argv[1]) as source:
        fixture = json.load(source)
    with open(sys.argv[2]) as source:
        netex = json.load(source)
    cases = [
        (fixture, "ElementRepeated", "PassengerSpot", "PassengerSpot"),
        (fixture, "ChoiceRepeated", "PassengerSpot", "PassengerSpot"),
        (fixture, "ChoiceRepeated", "PassengerSpotRef", "PassengerSpotRef"),
        (netex, "passengerSpots_RelStructure", "PassengerSpot", "PassengerSpot"),
        (netex, "passengerSpots_RelStructure", "PassengerSpotRef", "PassengerSpotRef"),
    ]
    for name in ("ChoiceBounded", "NestedChoice", "SequenceRepeated", "RepeatedGroupRef", "GroupInChoice"):
        cases.append((fixture, name, "PassengerSpot", "PassengerSpot"))
    failures = 0
    for schema, definition, field, target in cases:
        prop = properties(schema, definition).get(field, {})
        expected = "#/definitions/" + target
        passed = prop.get("type") == "array" and prop.get("items", {}).get("$ref") == expected
        print(f"{'PASS' if passed else 'FAIL'} {definition}.{field}: expected an array of {target}")
        if not passed:
            print("  Actual: " + json.dumps(prop, sort_keys=True))
            failures += 1
    # Controls: no accidental arrays for single items or unrelated siblings;
    # repetition must stop at an element boundary, not reach inside its object.
    named = properties(fixture, "NamedElement")["Seat"]
    checks = [
        ("Single choice stays single", properties(fixture, "ChoiceSingle")["PassengerSpot"] == {"$ref": "#/definitions/PassengerSpot"}),
        ("Sibling stays single", properties(fixture, "NestedChoice")["Label"].get("type") == "string"),
        ("Named element repeats", named.get("type") == "array"),
        ("Child inside repeated object stays single", named.get("items", {}).get("properties", {}).get("Label", {}).get("type") == "string"),
    ]
    for label, passed in checks:
        print(f"{'PASS' if passed else 'FAIL'} {label}")
        failures += not passed
    total = len(cases) + len(checks)
    print(f"\n{total - failures} passed; {failures} failed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
