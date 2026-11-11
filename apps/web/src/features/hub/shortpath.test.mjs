import test from "node:test";
import assert from "node:assert/strict";
import { shortPath } from "./catalog.ts";

test("a skill path reads short: home as ~, long ones cut in the middle", () => {
  assert.equal(shortPath("/Users/ian/.claude/skills/x/SKILL.md"), "~/.claude/skills/x/SKILL.md");
  assert.equal(shortPath("/Users/iansantana/.claude/plugins/cache/some-market/some-plugin/1.2.3/skills/analise/SKILL.md"), "~/.claude/plugins/…/analise/SKILL.md");
  assert.equal(shortPath("/home/ian/proj/.claude/skills/a/SKILL.md"), "~/proj/.claude/skills/a/SKILL.md");
  assert.equal(shortPath("/opt/x/SKILL.md"), "/opt/x/SKILL.md");
});
