/**
 * Unit tests for the Edge-runtime fake-extraction gate.
 *
 * Run with:  npm test
 *
 * This is one of the two switches that keep fabricated OCR values out of production, so its
 * whole value is in FAILING CLOSED. The table below is deliberately exhaustive about the
 * near-misses — a mis-cased value, a padded value, a truthy-looking value — because those
 * are the shapes a permissive parse would accept and a deployment would produce by accident.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FAKE_PENDING_MS,
  MAX_FAKE_PENDING_MS,
  RECEIPT_EXTRACTION_MODE_ENV,
  RECEIPT_EXTRACTION_MODE_FAKE,
  isFakeExtractionEnabled,
  resolveFakePendingMs,
} from "./receipt-extraction-mode.ts";

describe("isFakeExtractionEnabled", () => {
  test("the exact literal enables it, and only that", () => {
    assert.equal(isFakeExtractionEnabled("fake"), true);
    assert.equal(isFakeExtractionEnabled(RECEIPT_EXTRACTION_MODE_FAKE), true);
  });

  test("absent configuration fails closed", () => {
    assert.equal(isFakeExtractionEnabled(undefined), false);
    assert.equal(isFakeExtractionEnabled(null), false);
    assert.equal(isFakeExtractionEnabled(""), false);
  });

  test("mis-cased values fail closed", () => {
    for (const value of ["FAKE", "Fake", "fAkE"]) {
      assert.equal(isFakeExtractionEnabled(value), false, value);
    }
  });

  test("padded values fail closed", () => {
    for (const value of [" fake", "fake ", " fake ", "\tfake", "fake\n"]) {
      assert.equal(isFakeExtractionEnabled(value), false, JSON.stringify(value));
    }
  });

  test("truthy-looking values fail closed", () => {
    for (const value of ["1", "true", "yes", "on", "enabled", "enable", "FAKE_MODE"]) {
      assert.equal(isFakeExtractionEnabled(value), false, value);
    }
  });

  test("non-strings fail closed", () => {
    for (const value of [0, 1, true, {}, [], ["fake"], { mode: "fake" }, Symbol("fake")]) {
      assert.equal(isFakeExtractionEnabled(value), false, String(value?.toString?.()));
    }
  });

  test("the variable name is a constant, so the safety test has one anchor", () => {
    assert.equal(RECEIPT_EXTRACTION_MODE_ENV, "RECEIPT_EXTRACTION_MODE");
  });
});

describe("resolveFakePendingMs", () => {
  test("the default is NON-ZERO, so the asynchronous path is always exercised", () => {
    // With a zero default the request function would claim, submit and complete in one
    // invocation and the PENDING branch would be dead code.
    assert.ok(DEFAULT_FAKE_PENDING_MS > 0);
    assert.equal(resolveFakePendingMs(undefined), DEFAULT_FAKE_PENDING_MS);
    assert.equal(resolveFakePendingMs(""), DEFAULT_FAKE_PENDING_MS);
  });

  test("a valid integer is honoured", () => {
    assert.equal(resolveFakePendingMs("0"), 0);
    assert.equal(resolveFakePendingMs("250"), 250);
    assert.equal(resolveFakePendingMs(" 250 "), 250);
  });

  test("garbage falls back to the default rather than disabling anything", () => {
    // This variable controls TIMING, not authorization, so it fails safe rather than closed.
    for (const value of ["abc", "-1", "1.5", "1e3", "Infinity", null, {}, 250]) {
      assert.equal(resolveFakePendingMs(value), DEFAULT_FAKE_PENDING_MS, String(value));
    }
  });

  test("an absurd value is ignored so a typo cannot wedge a job", () => {
    assert.equal(resolveFakePendingMs(String(MAX_FAKE_PENDING_MS + 1)), DEFAULT_FAKE_PENDING_MS);
    assert.equal(resolveFakePendingMs(String(MAX_FAKE_PENDING_MS)), MAX_FAKE_PENDING_MS);
  });
});
