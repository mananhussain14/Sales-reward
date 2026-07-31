import type { NextConfig } from "next";
import {
  PROXY_CLIENT_MAX_BODY_BYTES,
  SERVER_ACTION_BODY_SIZE_LIMIT_BYTES,
} from "./lib/uploads/upload-policy.ts";

/**
 * THE REQUEST BOUNDARY FOR UPLOADS.
 *
 * Both numbers below are DERIVED, never typed in. They come from
 * ./lib/uploads/upload-policy.ts, which also defines the 10 MB application maximum they
 * have to stay above, and lib/uploads/upload-request-boundary.test.ts imports this file
 * and fails if the two ever stop agreeing.
 *
 * WHY THESE TWO AND NOT ONE. A receipt submission is a POST to /retailer/receipts, a
 * path proxy.ts matches, so its body passes TWO independent size gates in Next.js
 * 16.2.10:
 *
 *   experimental.serverActions.bodySizeLimit   default 1 MiB.  Over it: HTTP 413,
 *                                              reported to the browser as a 500.
 *                                              This is what rejected every receipt
 *                                              above 1 MB.
 *   experimental.proxyClientMaxBodySize        default 10 MiB. Over it: the cloned
 *                                              body is TRUNCATED with a console.warn
 *                                              (next/dist/server/body-streams.js),
 *                                              not refused. Its default is exactly the
 *                                              advertised 10 MB file maximum, leaving
 *                                              no room for multipart framing.
 *
 * Raising only the first would have moved the failure to the second at precisely the
 * size the product advertises. Both are raised, and the Proxy bound is kept strictly
 * higher so an over-sized body is always refused at the Server Action boundary — where
 * the failure is clean and typed — rather than arriving truncated.
 *
 * Neither value is unlimited. See the policy module for the denial-of-service reasoning
 * behind keeping them finite and close to the application maximum.
 *
 * `experimental` is where both options live in this installed version — verified
 * against node_modules/next/dist/server/config-shared.d.ts (ExperimentalConfig) and
 * node_modules/next/dist/docs, not carried over from another Next.js release. Both
 * accept a raw byte count as a number, which is what is passed: a "10mb"-style string
 * would re-introduce the decimal-versus-binary ambiguity the policy module exists to
 * settle.
 */
const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: SERVER_ACTION_BODY_SIZE_LIMIT_BYTES,
    },
    proxyClientMaxBodySize: PROXY_CLIENT_MAX_BODY_BYTES,
  },
};

export default nextConfig;
