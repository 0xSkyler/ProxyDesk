"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BROWSER_IDS = exports.BROWSER_COUNT = void 0;
const constants_1 = require("../constants");
/** @deprecated kept only so nothing importing the old name breaks; the real
 * ceiling is MAX_BROWSER_COUNT (see shared/constants) and browser count is
 * now a user setting, not a fixed constant. */
exports.BROWSER_COUNT = constants_1.MAX_BROWSER_COUNT;
/** Every possible browser id, up to the maximum configurable count. Actual
 * rendering/creation always slices this down to `settings.browser.browserCount`
 * (see BrowserGrid.tsx and main.ts's getBrowserIds) — this array itself is
 * just the full id space, not "how many browsers exist right now". */
exports.BROWSER_IDS = Array.from({ length: constants_1.MAX_BROWSER_COUNT }, (_, i) => i + 1);
//# sourceMappingURL=browser.js.map