/**
 * No Update Check Extension
 *
 * Turns off pi's startup request to pi.dev for a newer pi release, and with it
 * the "Update Available" banner. Every package in this config is vendored and
 * pinned, and pi itself is updated deliberately with `pi update`.
 *
 * pi only honours this as an environment variable (there is no setting for it).
 * The check runs after extensions load, so setting it here is early enough.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

process.env.PI_SKIP_VERSION_CHECK ??= "1";

export default function (_pi: ExtensionAPI) {}
