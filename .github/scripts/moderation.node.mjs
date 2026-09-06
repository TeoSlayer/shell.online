import test from "node:test";
import assert from "node:assert/strict";
import {
  parseModelJson,
  shouldClosePullRequest,
  shouldDeleteIssue,
  validateIssueAssessment,
  validateReleaseNotes,
} from "./moderation.mjs";

const issue = (overrides = {}) => ({
  classification: "unrelated",
  confidence: 0.99,
  technical_substance: false,
  ...overrides,
});
const issueVerifier = (overrides = {}) => ({decision: "delete", confidence: 0.99, ...overrides});
const pr = (overrides = {}) => ({
  classification: "spam",
  confidence: 0.99,
  technical_substance: false,
  ...overrides,
});
const prVerifier = (overrides = {}) => ({decision: "close", confidence: 0.99, ...overrides});

test("parses plain and fenced JSON model responses", () => {
  assert.deepEqual(parseModelJson('{"ok":true}'), {ok: true});
  assert.deepEqual(parseModelJson('```json\n{"ok":true}\n```'), {ok: true});
});

test("rejects incomplete model output before it can mutate GitHub", () => {
  assert.throws(() => validateIssueAssessment({}), /classification/);
  assert.throws(() => validateReleaseNotes({headline: "undefined"}), /summary/);
  assert.deepEqual(validateReleaseNotes({
    headline: "Portable PTY checks",
    summary: "The release expands runtime validation.",
    highlights: [],
    fixes: [],
    compatibility: ["Linux ARM"],
    verification: ["QEMU"],
  }).verification, ["QEMU"]);
});

test("deletion requires two high-confidence votes and no technical substance", () => {
  assert.equal(shouldDeleteIssue(issue(), issueVerifier()), true);
  assert.equal(shouldDeleteIssue(issue({confidence: 0.97}), issueVerifier()), false);
  assert.equal(shouldDeleteIssue(issue({technical_substance: true}), issueVerifier()), false);
  assert.equal(shouldDeleteIssue(issue(), issueVerifier({decision: "keep"})), false);
});

test("maintainers are never removed by automatic moderation", () => {
  assert.equal(shouldDeleteIssue(issue(), issueVerifier(), "OWNER"), false);
  assert.equal(shouldClosePullRequest(pr(), prVerifier(), "COLLABORATOR"), false);
});

test("a flawed but relevant pull request is never closed as noise", () => {
  assert.equal(shouldClosePullRequest(pr({classification: "needs_changes", technical_substance: true}), prVerifier()), false);
  assert.equal(shouldClosePullRequest(pr(), prVerifier()), true);
});
