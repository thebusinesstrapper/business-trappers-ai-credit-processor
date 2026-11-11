import test from "node:test";
import assert from "node:assert/strict";
import { generateLetters } from "./generateLetter.js";

test("letter engine rejects an unverified test identity before generating any letters", async () => {
  const unverified = {
    name: "Sample Person",
    address_line_1: "100 Example Street",
    city: "Sampletown",
    state: "FL",
    postal_code: "00000",
  };
  const result = await generateLetters(
    { chainOk: true, items: [] },
    { tradelines: [], collections: [], inquiries: [], publicRecords: [] },
    { clientIdentity: unverified }
  );
  assert.equal(result.lettersOk, false);
  assert.deepEqual(result.letters, []);
  assert.ok(result.errors.some((reason) => /source|profile|provenance/i.test(reason)));
});
