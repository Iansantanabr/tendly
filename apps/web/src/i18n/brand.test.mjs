import test from "node:test";
import assert from "node:assert/strict";
import { brand, translate } from "./index.ts";

test("the visible name is GCore, real identifiers keep tendly", () => {
  assert.equal(brand("Tendly’s own address · Tendly 0.1"), "GCore’s own address · GCore 0.1");
  for (const kept of ["tendly_read_conversation", "tendly.host.theme", "~/.tendly", "TENDLY_TOKEN", "X-Tendly-Client", "tendly-apps", "TendlySymbols"]) {
    assert.equal(brand(kept), kept);
  }
});

test("translations show GCore, values put in are never touched", () => {
  assert.equal(translate("Tendly tools", "en"), "GCore tools");
  assert.match(translate("Tendly tools for agents", "pt-BR"), /GCore/);
  assert.equal(translate("{name}", "en", { name: "Tendly notes.md" }), "Tendly notes.md");
});
