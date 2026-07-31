/**
 * PURE MODULE — no I/O, no network, no environment, no side effects.
 *
 * THE EIGHT FAKE RECEIPT FIXTURES, and the assembler that turns one into a normalized
 * extraction.
 *
 * WHAT A FIXTURE IS. A fixture holds only SOURCE TEXT — the characters a provider would
 * have read off the paper. It does not hold minor-unit integers. The assembler below runs
 * that text through the real parser in ./receipt-amount-parsing.ts, so the fixtures
 * exercise the production amount grammar rather than bypassing it, and a regression in the
 * parser shows up as a wrong fixture rather than passing unnoticed.
 *
 * WHY THESE EIGHT. Between them they cover every minor-unit class the schema admits
 * (0, 2, 3, 4 via CLF is out of circulation on receipts, so 0/2/3 are exercised directly),
 * both decimal conventions, grouping whitespace, the two optional text fields being absent,
 * a subtotal/tax/total that legitimately does not add up, and the one failure a provider
 * reports about the document itself.
 *
 * A CLIENT CANNOT REACH ANY OF THIS. Fixture selection is server-side only — see
 * ./receipt-extraction-fake-provider.ts. There is no request field, query parameter,
 * header or claim that names a fixture, and this module is never imported by anything that
 * reads a request.
 */

import {
  hasSubtotalTaxTotalMismatch,
  parseAmountToMinor,
  type MinorUnit,
} from "./receipt-amount-parsing.ts";
import type {
  NormalizedAmount,
  NormalizedExtraction,
  NormalizedLineItem,
  NormalizedText,
} from "./receipt-extraction-provider.ts";
import type {
  ExtractionFailureCode,
  ExtractionWarningCode,
} from "./receipt-extraction-vocabulary.ts";

/** The eight fixture keys. A closed set; an unknown key fails closed and never falls back. */
export const FAKE_FIXTURE_KEYS = [
  "CLEAN_AED_2",
  "JPY_0_MINOR",
  "KWD_3_MINOR",
  "EUR_DECIMAL_COMMA",
  "MISSING_MERCHANT",
  "MISSING_DOCUMENT_NUMBER",
  "ROUNDING_MISMATCH",
  "REJECTED_DOCUMENT",
] as const;
export type FakeFixtureKey = (typeof FAKE_FIXTURE_KEYS)[number];

type FixtureLineItem = {
  readonly description: string;
  readonly quantity: number;
  readonly quantitySourceText: string;
  readonly unitPriceSourceText: string;
  readonly lineTotalSourceText: string;
  readonly confidence: number;
};

export type FakeFixture = {
  readonly key: FakeFixtureKey;
  /** When set, the fixture reports this failure at POLL time, after an operation exists. */
  readonly failureCode: ExtractionFailureCode | null;
  readonly currencyCode: string;
  readonly minorUnit: MinorUnit;
  readonly merchantNameSourceText: string | null;
  readonly documentNumberSourceText: string | null;
  /** ISO calendar date, no zone. */
  readonly transactionDate: string | null;
  readonly transactionDateSourceText: string | null;
  /** HH:MM, minute precision, no zone. */
  readonly transactionTime: string | null;
  readonly transactionTimeSourceText: string | null;
  readonly totalSourceText: string | null;
  readonly subtotalSourceText: string | null;
  readonly taxSourceText: string | null;
  readonly lineItems: readonly FixtureLineItem[];
};

const CONFIDENT = 0.97;
const LESS_CONFIDENT = 0.62;

/**
 * The fixtures, keyed and frozen.
 *
 * Every amount is written the way the corresponding locale actually prints it, so the
 * parser's rule order is genuinely under test: `12.500` for a three-minor dinar must not be
 * read as twelve thousand five hundred, and `1,000` for a zero-minor yen must not be read
 * as one.
 */
export const FAKE_FIXTURES: Readonly<Record<FakeFixtureKey, FakeFixture>> = {
  /** The ordinary case: a two-minor currency, point decimal, everything present. */
  CLEAN_AED_2: {
    key: "CLEAN_AED_2",
    failureCode: null,
    currencyCode: "AED",
    minorUnit: 2,
    merchantNameSourceText: "Lulu Hypermarket",
    documentNumberSourceText: "INV-2026/004512",
    transactionDate: "2026-07-12",
    transactionDateSourceText: "12/07/2026",
    transactionTime: "14:32",
    transactionTimeSourceText: "14:32:00",
    totalSourceText: "AED 1,234.56",
    subtotalSourceText: "1,176.00",
    taxSourceText: "58.56",
    lineItems: [
      {
        description: "Basmati Rice 5kg",
        quantity: 2,
        quantitySourceText: "2",
        unitPriceSourceText: "44.00",
        lineTotalSourceText: "88.00",
        confidence: CONFIDENT,
      },
      {
        description: "Olive Oil 1L",
        quantity: 1,
        quantitySourceText: "1",
        unitPriceSourceText: "1,088.00",
        lineTotalSourceText: "1,088.00",
        confidence: CONFIDENT,
      },
    ],
  },

  /** Zero minor units. `1,000` must be grouping, not one yen. */
  JPY_0_MINOR: {
    key: "JPY_0_MINOR",
    failureCode: null,
    currencyCode: "JPY",
    minorUnit: 0,
    merchantNameSourceText: "Family Mart Shibuya",
    documentNumberSourceText: "R-778812",
    transactionDate: "2026-06-03",
    transactionDateSourceText: "2026-06-03",
    transactionTime: "09:05",
    transactionTimeSourceText: "09:05",
    totalSourceText: "¥12,480",
    subtotalSourceText: "11,346",
    taxSourceText: "1,134",
    lineItems: [
      {
        description: "Onigiri",
        quantity: 3,
        quantitySourceText: "3",
        unitPriceSourceText: "160",
        lineTotalSourceText: "480",
        confidence: CONFIDENT,
      },
    ],
  },

  /** Three minor units. `12.500` must be twelve and a half dinars. */
  KWD_3_MINOR: {
    key: "KWD_3_MINOR",
    failureCode: null,
    currencyCode: "KWD",
    minorUnit: 3,
    merchantNameSourceText: "The Sultan Center",
    documentNumberSourceText: "TSC/2026/0091",
    transactionDate: "2026-05-21",
    transactionDateSourceText: "21-05-2026",
    transactionTime: "18:47",
    transactionTimeSourceText: "18:47",
    totalSourceText: "KD 12.500",
    subtotalSourceText: "11.905",
    taxSourceText: "0.595",
    lineItems: [
      {
        description: "Coffee Beans 500g",
        quantity: 1,
        quantitySourceText: "1",
        unitPriceSourceText: "12.500",
        lineTotalSourceText: "12.500",
        confidence: CONFIDENT,
      },
    ],
  },

  /** Comma decimal with point grouping, and narrow-space grouping on the subtotal. */
  EUR_DECIMAL_COMMA: {
    key: "EUR_DECIMAL_COMMA",
    failureCode: null,
    currencyCode: "EUR",
    minorUnit: 2,
    merchantNameSourceText: "Carrefour City",
    documentNumberSourceText: "FR-2026-55120",
    transactionDate: "2026-04-09",
    transactionDateSourceText: "09.04.2026",
    transactionTime: "11:15",
    transactionTimeSourceText: "11:15",
    totalSourceText: "1.284,90 €",
    subtotalSourceText: "1 070,75",
    taxSourceText: "214,15",
    lineItems: [
      {
        description: "Fromage Comté",
        quantity: 1.5,
        quantitySourceText: "1,5",
        unitPriceSourceText: "28,60",
        lineTotalSourceText: "42,90",
        confidence: LESS_CONFIDENT,
      },
    ],
  },

  /** The merchant name is absent. MISSING_MERCHANT_NAME is warned, nothing is invented. */
  MISSING_MERCHANT: {
    key: "MISSING_MERCHANT",
    failureCode: null,
    currencyCode: "AED",
    minorUnit: 2,
    merchantNameSourceText: null,
    documentNumberSourceText: "SR-99001",
    transactionDate: "2026-07-01",
    transactionDateSourceText: "01/07/2026",
    transactionTime: null,
    transactionTimeSourceText: null,
    totalSourceText: "310.00",
    subtotalSourceText: null,
    taxSourceText: null,
    lineItems: [],
  },

  /** The document number is absent, and the total is read with low confidence. */
  MISSING_DOCUMENT_NUMBER: {
    key: "MISSING_DOCUMENT_NUMBER",
    failureCode: null,
    currencyCode: "AED",
    minorUnit: 2,
    merchantNameSourceText: "Al Maya Supermarket",
    documentNumberSourceText: null,
    transactionDate: "2026-07-18",
    transactionDateSourceText: "18/07/2026",
    transactionTime: "20:02",
    transactionTimeSourceText: "20:02",
    totalSourceText: "87.25",
    subtotalSourceText: "83.10",
    taxSourceText: "4.15",
    lineItems: [
      {
        description: "Laundry Detergent",
        quantity: 1,
        quantitySourceText: "1",
        unitPriceSourceText: "87.25",
        lineTotalSourceText: "87.25",
        confidence: LESS_CONFIDENT,
      },
    ],
  },

  /**
   * subtotal + tax does not equal total, exactly as a real receipt that rounds its lines
   * independently. This is WARNED and never corrected, never blocked, and never derived
   * away — the backend does not compute any one of the three from the other two.
   */
  ROUNDING_MISMATCH: {
    key: "ROUNDING_MISMATCH",
    failureCode: null,
    currencyCode: "AED",
    minorUnit: 2,
    merchantNameSourceText: "Spinneys",
    documentNumberSourceText: "SPN-2026-3311",
    transactionDate: "2026-03-14",
    transactionDateSourceText: "14/03/2026",
    transactionTime: "16:40",
    transactionTimeSourceText: "16:40",
    totalSourceText: "105.01",
    subtotalSourceText: "100.00",
    taxSourceText: "5.00",
    lineItems: [
      {
        description: "Mixed Groceries",
        quantity: 1,
        quantitySourceText: "1",
        unitPriceSourceText: "100.00",
        lineTotalSourceText: "100.00",
        confidence: CONFIDENT,
      },
    ],
  },

  /**
   * The provider read the image and did not consider it a receipt.
   *
   * Reported at POLL time rather than at submit, because that is when a real service
   * reports it — which means this fixture exercises the post-provider failure path, where
   * an operation id already exists and must be supplied and matched.
   */
  REJECTED_DOCUMENT: {
    key: "REJECTED_DOCUMENT",
    failureCode: "PROVIDER_REJECTED_DOCUMENT",
    currencyCode: "AED",
    minorUnit: 2,
    merchantNameSourceText: null,
    documentNumberSourceText: null,
    transactionDate: null,
    transactionDateSourceText: null,
    transactionTime: null,
    transactionTimeSourceText: null,
    totalSourceText: null,
    subtotalSourceText: null,
    taxSourceText: null,
    lineItems: [],
  },
};

export function isFakeFixtureKey(value: unknown): value is FakeFixtureKey {
  return typeof value === "string" && (FAKE_FIXTURE_KEYS as readonly string[]).includes(value);
}

function text(value: string | null, confidence: number | null): NormalizedText {
  return { value, sourceText: value, confidence: value === null ? null : confidence };
}

/**
 * Runs one fixture amount through the real parser.
 *
 * A rejected parse yields a null value with the source text RETAINED and the corresponding
 * warning collected — which is the whole point of keeping source text on the row.
 */
function amount(
  sourceText: string | null,
  minorUnit: MinorUnit,
  confidence: number,
  warnings: ExtractionWarningCode[],
): NormalizedAmount {
  if (sourceText === null) return { minor: null, sourceText: null, confidence: null };

  const parsed = parseAmountToMinor(sourceText, minorUnit);

  if (parsed.status === "ok") {
    return { minor: parsed.minor, sourceText, confidence };
  }
  if (parsed.warning !== null && !warnings.includes(parsed.warning)) {
    warnings.push(parsed.warning);
  }
  return { minor: null, sourceText, confidence: null };
}

/**
 * Assembles the normalized extraction a fixture stands for.
 *
 * Warnings are DERIVED here rather than written into the fixture, so a fixture cannot claim
 * a warning its own values do not justify.
 */
export function buildFixtureExtraction(fixture: FakeFixture): {
  normalized: NormalizedExtraction;
  lineItems: NormalizedLineItem[];
} {
  const warnings: ExtractionWarningCode[] = [];

  const total = amount(fixture.totalSourceText, fixture.minorUnit, CONFIDENT, warnings);
  const subtotal = amount(fixture.subtotalSourceText, fixture.minorUnit, CONFIDENT, warnings);
  const taxTotal = amount(fixture.taxSourceText, fixture.minorUnit, CONFIDENT, warnings);

  if (fixture.merchantNameSourceText === null) warnings.push("MISSING_MERCHANT_NAME");
  if (fixture.documentNumberSourceText === null) warnings.push("MISSING_DOCUMENT_NUMBER");
  if (fixture.transactionTime === null) warnings.push("MISSING_TRANSACTION_TIME");
  if (total.minor === 0) warnings.push("ZERO_TOTAL");
  if (hasSubtotalTaxTotalMismatch(subtotal.minor, taxTotal.minor, total.minor)) {
    warnings.push("SUBTOTAL_TAX_TOTAL_MISMATCH");
  }

  const lineItems: NormalizedLineItem[] = fixture.lineItems.map((item, index) => {
    const unitPrice = parseAmountToMinor(item.unitPriceSourceText, fixture.minorUnit);
    const lineTotal = parseAmountToMinor(item.lineTotalSourceText, fixture.minorUnit);
    return {
      lineNumber: index + 1,
      description: item.description,
      descriptionSourceText: item.description,
      quantity: item.quantity,
      quantitySourceText: item.quantitySourceText,
      unitPriceMinor: unitPrice.status === "ok" ? unitPrice.minor : null,
      unitPriceSourceText: item.unitPriceSourceText,
      lineTotalMinor: lineTotal.status === "ok" ? lineTotal.minor : null,
      lineTotalSourceText: item.lineTotalSourceText,
      confidence: item.confidence,
    };
  });

  const normalized: NormalizedExtraction = {
    merchantName: text(fixture.merchantNameSourceText, CONFIDENT),
    documentNumber: text(fixture.documentNumberSourceText, CONFIDENT),
    transactionDate: {
      value: fixture.transactionDate,
      sourceText: fixture.transactionDateSourceText,
      confidence: fixture.transactionDate === null ? null : CONFIDENT,
    },
    transactionTime: {
      value: fixture.transactionTime,
      sourceText: fixture.transactionTimeSourceText,
      confidence: fixture.transactionTime === null ? null : CONFIDENT,
    },
    currencyCode: {
      value: fixture.currencyCode,
      sourceText: fixture.currencyCode,
      confidence: CONFIDENT,
    },
    total,
    subtotal,
    taxTotal,
    warningCodes: warnings,
  };

  return { normalized, lineItems };
}
