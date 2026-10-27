"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROXY_TIERS = void 0;
exports.resolveProxyTier = resolveProxyTier;
exports.parseGeoProxyFeed = parseGeoProxyFeed;
exports.matchesProxyTier = matchesProxyTier;

const { ProxyParser, toProxyRecord } = require("./ProxyParser");

// Country membership is a user-defined classification, not a measurement
// of proxy quality, speed, connectivity, anonymity, or advertising value.
exports.PROXY_TIERS = Object.freeze({
    tier1: Object.freeze({
        label: "Tier 1",
        countries: Object.freeze({
            US: "United States", CA: "Canada",
            GB: "United Kingdom", DE: "Germany", FR: "France", NL: "Netherlands",
            CH: "Switzerland", AT: "Austria", BE: "Belgium", LU: "Luxembourg",
            IE: "Ireland", SE: "Sweden", NO: "Norway", DK: "Denmark", FI: "Finland",
            IT: "Italy", ES: "Spain",
            AU: "Australia", NZ: "New Zealand", JP: "Japan", SG: "Singapore",
            KR: "South Korea", HK: "Hong Kong",
            AE: "United Arab Emirates", QA: "Qatar"
        })
    }),
    tier2: Object.freeze({
        label: "Tier 2",
        countries: Object.freeze({
            PL: "Poland", CZ: "Czech Republic", PT: "Portugal", GR: "Greece",
            HU: "Hungary", RO: "Romania", SK: "Slovakia", TR: "Turkey",
            BR: "Brazil", MX: "Mexico", AR: "Argentina", CL: "Chile",
            CO: "Colombia", CR: "Costa Rica",
            TH: "Thailand", MY: "Malaysia", ID: "Indonesia", PH: "Philippines",
            TW: "Taiwan", SA: "Saudi Arabia", IL: "Israel", ZA: "South Africa"
        })
    }),
    tier3: Object.freeze({
        label: "Tier 3 (all remaining proxies)",
        countries: Object.freeze({
            IN: "India", PK: "Pakistan", BD: "Bangladesh", VN: "Vietnam",
            KH: "Cambodia", LK: "Sri Lanka", NP: "Nepal", LA: "Laos",
            NG: "Nigeria", KE: "Kenya", EG: "Egypt", GH: "Ghana",
            MA: "Morocco", DZ: "Algeria", TZ: "Tanzania", UG: "Uganda",
            MZ: "Mozambique", GT: "Guatemala", BO: "Bolivia", PE: "Peru",
            EC: "Ecuador", UA: "Ukraine", AM: "Armenia", GE: "Georgia",
            AZ: "Azerbaijan", UZ: "Uzbekistan"
        })
    })
});
const CODE_BY_NAME = new Map(Object.values(exports.PROXY_TIERS).flatMap(
    tier => Object.entries(tier.countries).map(([code, name]) => [name.toLowerCase(), code])
));
CODE_BY_NAME.set("czechia", "CZ");
CODE_BY_NAME.set("korea, republic of", "KR");
CODE_BY_NAME.set("viet nam", "VN");
CODE_BY_NAME.set("united states of america", "US");
CODE_BY_NAME.set("united arab emirates", "AE");
CODE_BY_NAME.set("hong kong sar", "HK");

function resolveProxyTier(tierId) {
    const id = tierId == null || tierId === "" ? "tier1" : String(tierId);
    if (!Object.hasOwn(exports.PROXY_TIERS, id))
        throw new Error("Unknown proxy tier: " + id);
    return id;
}
function normalizeCountryCode(code, name) {
    const raw = String(code || "").trim();
    if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase();
    return CODE_BY_NAME.get(String(name || raw).trim().toLowerCase()) || "";
}
function matchesProxyTier(countryCode, tierId) {
    const tier = resolveProxyTier(tierId);
    const code = normalizeCountryCode(countryCode);
    if (tier === "tier3") {
        // Tier 3 is the complement of Tier 1 and Tier 2, including
        // unlisted countries and missing/unknown provider country labels.
        // Do not run IP lookups or proxy-health checks to classify records.
        return !Object.hasOwn(exports.PROXY_TIERS.tier1.countries, code) &&
            !Object.hasOwn(exports.PROXY_TIERS.tier2.countries, code);
    }
    return Object.hasOwn(exports.PROXY_TIERS[tier].countries, code);
}

/**
 * Parses a provider's country-labeled JSON. This is metadata classification,
 * NOT a geolocation lookup, connectivity probe, latency test or verification.
 * A proxy with unknown/missing country is unclassified and belongs to
 * catch-all Tier 3. Provider metadata is never independently verified.
 */
function parseGeoProxyFeed(text, source) {
    let payload;
    try { payload = JSON.parse(text); }
    catch { throw new Error(source + " returned no country-labeled JSON. Select a provider with country metadata."); }
    const candidates = [
        payload, payload?.proxies, payload?.data, payload?.results,
        payload?.items, payload?.data?.proxies, payload?.data?.results,
        payload?.data?.items
    ];
    const items = candidates.find(Array.isArray);
    if (!items) throw new Error(source + " returned no proxy array with country metadata.");
    const proxies = [], invalidLines = [];
    for (const item of items) {
        if (!item || typeof item !== "object") continue;
        // ProxyScrape v4 get_proxies stores geography under ip_data.
        // The official CDN mirror flattens it to country_code/country.
        // Both are provider metadata only; no independent IP lookup.
        const ipData = item.ip_data || item.ipData || {};
        const code = normalizeCountryCode(
            item.country_code || item.countryCode || item.iso2 || item.country?.code ||
                ipData.countryCode || ipData.country_code ||
                (typeof item.country === "string" ? item.country : ""),
            (typeof item.country === "string" ? item.country : item.country?.name) ||
                ipData.country
        );
        // Keep proxies lacking metadata: Tier 3 must receive leftovers too.
        const host = item.ip || item.host || item.address;
        const direct = item.proxy || item.url || (
            host && item.port && item.protocol ? String(item.protocol) + "://" + host + ":" + item.port : ""
        );
        const parsed = direct ? ProxyParser.tryParseLine(String(direct)) : null;
        if (!parsed) { invalidLines.push(String(direct || "malformed record")); continue; }
        proxies.push(toProxyRecord(parsed, source, {
            countryCode: code,
            country: (typeof item.country === "string" ? item.country : item.country?.name) ||
                ipData.country,
            countryVerified: false // Declared by the provider; no independent test.
        }));
    }
    return { proxies, invalidLines, totalRecords: items.length };
}
//# sourceMappingURL=ProxyTiers.js.map
