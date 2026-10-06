"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.COUNTRIES = void 0;
exports.countryNameForCode = countryNameForCode;
/** ISO 3166-1 alpha-2 codes for the countries offered in the country picker. */
exports.COUNTRIES = [
    { code: 'US', name: 'United States' },
    { code: 'GB', name: 'United Kingdom' },
    { code: 'CA', name: 'Canada' },
    { code: 'DE', name: 'Germany' },
    { code: 'FR', name: 'France' },
    { code: 'NL', name: 'Netherlands' },
    { code: 'SG', name: 'Singapore' },
    { code: 'JP', name: 'Japan' },
    { code: 'AU', name: 'Australia' },
    { code: 'IN', name: 'India' },
    { code: 'BD', name: 'Bangladesh' },
    { code: 'BR', name: 'Brazil' }
];
function countryNameForCode(code) {
    if (!code)
        return undefined;
    return exports.COUNTRIES.find((c) => c.code === code.toUpperCase())?.name;
}
//# sourceMappingURL=countries.js.map