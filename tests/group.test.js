import test from "node:test";
import assert from "node:assert/strict";
import { isExactGroup, normalizeGroupName } from "../src/group.js";

test("normalizes Cyrillic and Latin spellings of 8Ca", () => {
  for (const value of ["8Са", "8СА", "8Ca", "8CA", "8 Са"]) {
    assert.equal(normalizeGroupName(value), "8CA");
    assert.equal(isExactGroup(value, "8Са"), true);
  }
});
test("does not confuse 8Ca with another group", () => {
  for (const value of ["8Сб", "8Cb", "9Са", "18Са"]) {
    assert.equal(isExactGroup(value, "8Са"), false);
  }
});

test("normalizes requested Cyrillic and Latin spellings of 8Cba", () => {
  for (const value of ["8Сба", "8СБА", "8Cба", "8CBA", "8Сбa", "8SBA"]) {
    assert.equal(normalizeGroupName(value), "8CBA");
    assert.equal(isExactGroup(value, "8Сба"), true);
  }
});

test("keeps 8Ca distinct from 8Cba", () => {
  assert.equal(isExactGroup("8Са", "8Сба"), false);
  assert.equal(isExactGroup("8Сб", "8Сба"), false);
});
