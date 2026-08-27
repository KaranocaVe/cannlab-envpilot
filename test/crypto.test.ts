import test from "node:test";
import assert from "node:assert/strict";

import { encryptGitCodePassword } from "../src/crypto.js";

test("GitCode password encryption uses AES-CBC/PKCS7 and base64 output", () => {
  assert.equal(
    encryptGitCodePassword("Passw0rd!"),
    "XGK8ZNE9OyVbL8yFir8SFA==",
  );
});
