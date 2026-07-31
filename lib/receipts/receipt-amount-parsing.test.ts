/**
 * Unit tests for the integer minor-unit amount parser.
 *
 * Run with:  npm test
 *
 * These pin the properties every stored monetary value depends on: the rule ORDER (which is
 * what makes `KWD 12.500` twelve and a half dinars while `JPY 1,000` is one thousand yen),
 * the refusal to guess an ambiguous separator, the refusal of a negative, and — most
 * importantly — that the conversion is EXACT. No floating point is involved at any point,
 * and the last test in this file reads the module's own source to prove it.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hasSubtotalTaxTotalMismatch,
  looksNegative,
  normalizeAmountDigits,
  parseAmountToMinor,
  type MinorUnit,
} from "./receipt-amount-parsing.ts";
import { MAX_MINOR_AMOUNT } from "./receipt-extraction-vocabulary.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function minorOf(text: string, minorUnit: MinorUnit): number | null {
  const result = parseAmountToMinor(text, minorUnit);
  return result.status === "ok" ? result.minor : null;
}

function reasonOf(text: string, minorUnit: MinorUnit): string | null {
  const result = parseAmountToMinor(text, minorUnit);
  return result.status === "rejected" ? result.reason : null;
}

describe("rule 1 — the last separator is the decimal separator when it has exactly `m` digits", () => {
  test("two minor units, point decimal", () => {
    assert.equal(minorOf("1,234.56", 2), 123456);
    assert.equal(minorOf("19.99", 2), 1999);
    assert.equal(minorOf("0.29", 2), 29);
  });

  test("two minor units, comma decimal with point grouping", () => {
    assert.equal(minorOf("1.284,90", 2), 128490);
    assert.equal(minorOf("214,15", 2), 21415);
  });

  test("three minor units — checked BEFORE the grouping rule", () => {
    // The load-bearing case. `12.500` also ends in three digits, so if rule 2 ran first this
    // would come out as 12500 MAJOR units — a thousandfold error.
    assert.equal(minorOf("12.500", 3), 12500);
    assert.equal(minorOf("0.595", 3), 595);
    assert.equal(minorOf("1.234,567", 3), 1234567);
  });

  test("four minor units", () => {
    assert.equal(minorOf("12.3456", 4), 123456);
  });

  test("a bare leading separator is refused rather than read as major units", () => {
    // `.56` written against the digits could be 0.56 or a stray mark. Reading it as 56 major
    // units would be a hundredfold error, so it is refused — but `د.إ 1,234.56`, where the
    // point belongs to the symbol and a letter stands between, still parses.
    assert.equal(minorOf(".56", 2), null);
    assert.equal(reasonOf(".56", 2), "ambiguous-separator");
    assert.equal(minorOf("د.إ 1,234.56", 2), 123456);
  });
});

describe("rule 2 — every separator is a grouping mark", () => {
  test("zero minor units", () => {
    assert.equal(minorOf("12,480", 0), 12480);
    assert.equal(minorOf("1,134", 0), 1134);
  });

  test("two minor units with no decimal part", () => {
    assert.equal(minorOf("1,234", 2), 123400);
  });

  test("several groups", () => {
    assert.equal(minorOf("1.234.567", 2), 123456700);
    assert.equal(minorOf("12,345,678", 0), 12345678);
  });

  test("mixed separator characters are NOT grouping", () => {
    // `.` then `,` with three trailing digits is not a shape this parser will resolve.
    assert.equal(minorOf("1.234,567", 2), null);
    assert.equal(reasonOf("1.234,567", 2), "ambiguous-separator");
  });
});

describe("rule 3 — no separator at all", () => {
  test("integer major units", () => {
    assert.equal(minorOf("1234", 2), 123400);
    assert.equal(minorOf("160", 0), 160);
    assert.equal(minorOf("7", 3), 7000);
  });
});

describe("rule 4 — refuse rather than guess", () => {
  test("one digit after the separator for a two-minor currency", () => {
    assert.equal(minorOf("12.5", 2), null);
    assert.equal(reasonOf("12.5", 2), "ambiguous-separator");
  });

  test("two decimals for a zero-minor currency", () => {
    assert.equal(minorOf("1000.00", 0), null);
    assert.equal(reasonOf("1000.00", 0), "ambiguous-separator");
  });

  test("a group of four digits is not grouping", () => {
    assert.equal(reasonOf("1,2345", 2), "ambiguous-separator");
  });

  test("the rejection carries the closed warning code", () => {
    const result = parseAmountToMinor("12.5", 2);
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") {
      assert.equal(result.warning, "AMBIGUOUS_AMOUNT_FORMAT");
    }
  });
});

describe("grouping whitespace", () => {
  test("ordinary, no-break, thin and narrow no-break spaces all group", () => {
    assert.equal(minorOf("1 234,56", 2), 123456);
    assert.equal(minorOf("1 234,56", 2), 123456);
    assert.equal(minorOf("1 234,56", 2), 123456);
    assert.equal(minorOf("1 234,56", 2), 123456);
  });
});

describe("multilingual digits and separators", () => {
  test("Arabic-Indic digits fold to ASCII", () => {
    assert.equal(normalizeAmountDigits("١٢٣٤"), "1234");
    assert.equal(minorOf("١٢٣٤.٥٦", 2), 123456);
  });

  test("Extended Arabic-Indic digits fold to ASCII", () => {
    assert.equal(normalizeAmountDigits("۱۲۳۴"), "1234");
  });

  test("the Arabic decimal and thousands separators fold to their ASCII roles", () => {
    assert.equal(minorOf("1٬234٫56", 2), 123456);
  });
});

describe("currency symbols and codes are stripped", () => {
  test("leading and trailing symbols", () => {
    assert.equal(minorOf("AED 1,234.56", 2), 123456);
    assert.equal(minorOf("¥12,480", 0), 12480);
    assert.equal(minorOf("1.284,90 €", 2), 128490);
    assert.equal(minorOf("KD 12.500", 3), 12500);
  });

  test("a symbol containing a dot does not become a separator", () => {
    // The dirham symbol is written with an interior point. The numeric core must begin and
    // end with a digit, which is what discards it.
    assert.equal(minorOf("د.إ 1,234.56", 2), 123456);
  });
});

describe("negatives are refused, never absolute-valued", () => {
  test("leading minus", () => {
    assert.equal(minorOf("-50.00", 2), null);
    assert.equal(reasonOf("-50.00", 2), "negative");
  });

  test("trailing minus", () => {
    assert.equal(reasonOf("50.00-", 2), "negative");
  });

  test("accounting parentheses", () => {
    assert.equal(reasonOf("(50.00)", 2), "negative");
    assert.ok(looksNegative("(1,234.56)"));
  });

  test("the rejection carries the closed warning code", () => {
    const result = parseAmountToMinor("-1.00", 2);
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") {
      assert.equal(result.warning, "NEGATIVE_AMOUNT_REJECTED");
    }
  });
});

describe("zero and bounds", () => {
  test("zero is valid", () => {
    assert.equal(minorOf("0", 2), 0);
    assert.equal(minorOf("0.00", 2), 0);
  });

  test("the ceiling is enforced", () => {
    assert.equal(minorOf("9999999999.99", 2), 999999999999);
    assert.equal(minorOf("99999999999.99", 2), null);
    assert.equal(reasonOf("99999999999.99", 2), "out-of-range");
  });

  test("MAX_MINOR_AMOUNT itself is accepted", () => {
    assert.equal(minorOf("10000000000.00", 2), MAX_MINOR_AMOUNT);
  });
});

describe("degenerate input", () => {
  test("no digits", () => {
    assert.equal(reasonOf("", 2), "no-digits");
    assert.equal(reasonOf("abc", 2), "no-digits");
    assert.equal(reasonOf("...", 2), "no-digits");
  });

  test("a non-string is refused rather than coerced", () => {
    assert.equal(parseAmountToMinor(null, 2).status, "rejected");
    assert.equal(parseAmountToMinor(1234, 2).status, "rejected");
  });

  test("an unsupported minor unit is refused", () => {
    assert.equal(parseAmountToMinor("1.0", 1 as MinorUnit).status, "rejected");
    assert.equal(reasonOf("1.0", 1 as MinorUnit), "unsupported-minor-unit");
  });
});

describe("exactness — the property IEEE-754 would break", () => {
  test("every two-decimal value from 0.00 to 9.99 converts exactly", () => {
    // Math.round(x * 100) is wrong for a long tail of these; string assembly is not.
    for (let cents = 0; cents < 1000; cents += 1) {
      const major = Math.floor(cents / 100);
      const minor = cents % 100;
      const text = `${major}.${String(minor).padStart(2, "0")}`;
      assert.equal(minorOf(text, 2), cents, `failed on ${text}`);
    }
  });

  test("a value that IEEE-754 multiplication gets wrong", () => {
    // 0.29 * 100 === 28.999999999999996 in double precision.
    assert.equal(minorOf("0.29", 2), 29);
    assert.equal(minorOf("1.005", 3), 1005);
  });

  test("large exact values", () => {
    assert.equal(minorOf("9876543210.12", 2), 987654321012);
  });
});

describe("subtotal + tax is a warning, never a rule", () => {
  test("a mismatch is reported", () => {
    assert.equal(hasSubtotalTaxTotalMismatch(10000, 500, 10501), true);
  });

  test("agreement is not reported", () => {
    assert.equal(hasSubtotalTaxTotalMismatch(10000, 500, 10500), false);
  });

  test("a missing component is never a mismatch", () => {
    assert.equal(hasSubtotalTaxTotalMismatch(null, 500, 10500), false);
    assert.equal(hasSubtotalTaxTotalMismatch(10000, null, 10500), false);
    assert.equal(hasSubtotalTaxTotalMismatch(10000, 500, null), false);
  });
});

describe("the module contains no floating-point arithmetic", () => {
  const SOURCE = readFileSync(join(ROOT, "lib/receipts/receipt-amount-parsing.ts"), "utf8");
  const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  test("no parseFloat", () => {
    assert.ok(!/parseFloat/.test(CODE), "parseFloat must never appear in the money path");
  });

  test("no Number() coercion of a decimal", () => {
    assert.ok(!/\bNumber\s*\(/.test(CODE), "Number() coercion must never appear");
  });

  test("no multiplication by a power of ten", () => {
    assert.ok(!/\*\s*(10|100|1000|10000)\b/.test(CODE), "no float scaling");
    assert.ok(!/Math\.round/.test(CODE), "no Math.round in the money path");
  });

  test("the only integer parse is a bounded radix-10 parseInt", () => {
    const matches = CODE.match(/Number\.parseInt\([^)]*\)/g) ?? [];
    assert.ok(matches.length >= 1);
    for (const match of matches) {
      assert.ok(/,\s*10\)/.test(match) || /,\s*16\)/.test(match), `unbounded parse: ${match}`);
    }
  });
});
